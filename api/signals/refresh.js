// Wekelijkse signal-refresh — Vercel cron-target.
//
// Iterateert over alle tenants in marktradar:tenants:index. Per tenant:
//   - Tenant heeft tenant.feeds[] → optie 2 (RSS-parser): haal alle feeds
//     op, filter op last 7 days, fuzzy-match titels op tenant.entiteiten[].
//     Maak signalen { id, datum, headline, summary, source, sourceUrl,
//     instellingId, urgentie } en schrijf naar marktradar:tenant:<id>:
//     signals:v1 (gemerged + gededupliceerd op sourceUrl, cap op 60).
//   - Geen feeds → optie 3 (LLM-curator): nog niet geïmplementeerd, geeft
//     stub-resultaat terug zodat de cron-run zelf wel slaagt.
//
// Beveiliging: alleen Vercel cron (x-vercel-cron header) of expliciete
// CRON_SECRET in Authorization-header.
//
// POST/GET /api/signals/refresh                  → refresh alle tenants
// GET      /api/signals/refresh?tenantId=<id>    → refresh één tenant
//                                                  (handig voor debug)

const auth = require('../_lib/auth');
const { fetchFeed } = require('../_lib/rss');

const SIGNALS_CAP = 60;
const RECENT_WINDOW_DAYS = 7;

function isAuthorizedCron(req) {
  if (req.headers['x-vercel-cron']) return true;
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const a = req.headers.authorization || '';
    if (a === 'Bearer ' + secret) return true;
  }
  return false;
}

// Probeer een sessie-gebaseerde auth (Bearer token van een ingelogde
// gebruiker). Daarmee kunnen admins via de Beheer-UI handmatig hun eigen
// tenant refreshen, zonder dat ze CRON_SECRET nodig hebben.
async function getSessionAuth(req) {
  try {
    const session = await auth.getSession(req);
    return session ? session.tenantId : null;
  } catch (e) { return null; }
}

function tenantSignalsKey(tenantId) {
  return 'marktradar:tenant:' + tenantId + ':signals:v1';
}
function tenantRefreshLogKey(tenantId) {
  return 'marktradar:tenant:' + tenantId + ':signals:lastRun';
}

async function getAllTenantIds() {
  return (await auth.kvGet(auth.KV_TENANTS_INDEX)) || [];
}

function makeId() {
  return 'auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function entiteitMatches(text, ent) {
  if (!ent || !ent.naam) return false;
  const naam = String(ent.naam).toLowerCase().trim();
  if (naam.length < 4) return false; // te kort = teveel false positives
  return text.includes(naam);
}

async function refreshViaFeeds(tenant) {
  const feeds = Array.isArray(tenant.feeds) ? tenant.feeds : [];
  if (feeds.length === 0) return { mode: 'no-feeds' };
  const allItems = [];
  const errors = [];
  for (const feed of feeds) {
    if (!feed || !feed.url) continue;
    try {
      const items = await fetchFeed(feed.url);
      items.forEach(it => allItems.push({ ...it, _feedLabel: feed.label || feed.url, _feedUrl: feed.url }));
    } catch (e) {
      errors.push({ feed: feed.url, error: String(e.message || e) });
    }
  }
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = allItems.filter(i => i.datum && new Date(i.datum).getTime() >= cutoff);

  const ents = Array.isArray(tenant.entiteiten) ? tenant.entiteiten : [];
  const signals = [];
  for (const item of recent) {
    const text = (item.title + ' ' + item.summary).toLowerCase();
    let matched = null;
    for (const ent of ents) {
      if (entiteitMatches(text, ent)) { matched = ent; break; }
    }
    // Sector-signaal: geen instelling-match maar wel relevant via marktNaam-sleutelwoord
    const isSector = !matched && tenant.marktNaam && text.includes(String(tenant.marktNaam).toLowerCase().split(' ')[0]);
    if (matched || isSector) {
      signals.push({
        id: makeId(),
        datum: item.datum.slice(0, 10),
        urgentie: 'middel',
        type: matched ? 'auto' : 'sector',
        instellingId: matched ? matched.id : null,
        instellingNaam: matched ? matched.naam : null,
        headline: item.title.slice(0, 200),
        summary: item.summary.slice(0, 500),
        source: item._feedLabel,
        sourceUrl: item.url,
      });
    }
  }

  // Dedup op sourceUrl tegen bestaande signalen, daarna mergen + cap.
  const key = tenantSignalsKey(tenant.id);
  const existing = (await auth.kvGet(key)) || [];
  const existingUrls = new Set(existing.filter(s => s && s.sourceUrl).map(s => s.sourceUrl));
  const fresh = signals.filter(s => s.sourceUrl && !existingUrls.has(s.sourceUrl));
  const merged = [...fresh, ...existing]
    .sort((a, b) => (b.datum || '').localeCompare(a.datum || ''))
    .slice(0, SIGNALS_CAP);
  await auth.kvSet(key, merged);

  return {
    mode: 'feeds',
    feedsChecked: feeds.length,
    itemsFetched: allItems.length,
    inWindow: recent.length,
    matched: signals.length,
    newSaved: fresh.length,
    totalAfter: merged.length,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * LLM-curator (Claude + web search). Werkt waar RSS-feeds niet bij komen
 * — bestuurswisselingen op company-sites, lokale persberichten, RTV-
 * stations, branchevereniging-publicaties (Verenso/ActiZ), aanbestedingen
 * op TenderNed. Vereist ANTHROPIC_API_KEY env-var.
 *
 * Claude krijgt: tenant.propositie + marktNaam + marktBeschrijving + tot
 * 30 entiteiten + 14-dagen-venster. Tool: web_search_20250305 (max 8
 * uses per call, voorkomt runaway-kosten). Output: strikt JSON-array.
 */
async function callAnthropicWithSearch(tenant, recentDateIso) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY niet gezet');
  const ents = (Array.isArray(tenant.entiteiten) ? tenant.entiteiten : []).slice(0, 30);
  const entsList = ents.map(e => `- ${e.naam}${e.regio ? ' (' + e.regio + ')' : ''}`).join('\n') || '(nog geen organisaties geconfigureerd)';

  const sys = 'Je bent een sales-intelligence-analist voor MarktRadar. Doe doelgericht web-onderzoek, vind marktsignalen van de afgelopen 14 dagen die relevant zijn voor de propositie, en geef ze terug als strikt JSON. Geen prose, alleen het JSON-array.';
  // Tenant-specifieke prompt-extensie. Beheerder kan via Beheer >
  // Werkomgeving > Automatische signalen > Prompt-aanpassing extra
  // instructies meegeven aan de LLM, bv. 'focus op claims-systeem-
  // vervangingen' of 'negeer signalen jonger dan 30 dagen'.
  const overrideRaw = String(tenant.signalPromptOverride || '').trim();
  const overrideBlock = overrideRaw
    ? `\n\n**Extra instructies van werkomgeving-beheerder:**\n${overrideRaw.slice(0, 4000)}`
    : '';
  const userMessage = `**Werkomgeving:** ${tenant.naam || ''}
**Propositie:** ${tenant.propositie || '(niet gezet)'}
**Markt:** ${tenant.marktNaam || '(niet gezet)'}
**Markt-beschrijving:** ${tenant.marktBeschrijving || '(niet gezet)'}

**Te volgen organisaties:**
${entsList}

**Opdracht:** Zoek op het web naar marktsignalen na ${recentDateIso} voor deze organisaties. Type signalen: bestuurswisselingen, fusies/overnames, financiële alerts, aanbestedingen (TenderNed), CAO/sector-bewegingen, nieuwe locaties/uitbreiding. Filter strikt op datum (laatste 14 dagen). Voor elk signaal: datum (YYYY-MM-DD), urgentie (laag|middel|hoog), type, instellingNaam (matcht een van bovenstaande organisaties OF leeg voor sector-signaal), headline (max 200 chars), summary (max 500 chars), source (bron-naam), sourceUrl (volledige URL).${overrideBlock}

**Output: alleen JSON-array, geen prose:**
[{"datum":"2026-04-23","urgentie":"middel","type":"...","instellingNaam":"...","headline":"...","summary":"...","source":"...","sourceUrl":"..."}]`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
      system: sys,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + t.slice(0, 500));
  }
  const j = await res.json();
  const text = (j.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) {
    return { items: [], rawTextSnippet: text.slice(0, 200) };
  }
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { throw new Error('JSON-parse mislukt op LLM-output: ' + e.message); }
  return { items: Array.isArray(arr) ? arr : [], usage: j.usage };
}

async function refreshViaLlm(tenant) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      mode: 'llm-skipped',
      reason: 'ANTHROPIC_API_KEY niet geconfigureerd in Vercel env-vars. Voeg toe om de LLM-curator te activeren.',
    };
  }
  const recentDate = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const { items, usage, rawTextSnippet } = await callAnthropicWithSearch(tenant, recentDate);
  if (items.length === 0) {
    return { mode: 'llm', candidates: 0, matched: 0, newSaved: 0, note: 'Claude vond geen signalen in dit venster' + (rawTextSnippet ? ' (tekst-fragment: "' + rawTextSnippet + '")' : ''), usage };
  }
  // Match instellingNaam tegen entiteiten op exacte (case-insensitive) naam
  const ents = Array.isArray(tenant.entiteiten) ? tenant.entiteiten : [];
  const byName = new Map(ents.map(e => [String(e.naam).toLowerCase().trim(), e]));
  const signals = items.map(it => {
    if (!it || !it.datum || !it.headline) return null;
    const namKey = String(it.instellingNaam || '').toLowerCase().trim();
    const matched = byName.get(namKey);
    return {
      id: 'llm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      datum: String(it.datum).slice(0, 10),
      urgentie: ['laag','middel','hoog'].includes(it.urgentie) ? it.urgentie : 'middel',
      type: String(it.type || 'auto').slice(0, 40),
      instellingId: matched ? matched.id : null,
      instellingNaam: matched ? matched.naam : (it.instellingNaam || null),
      headline: String(it.headline).slice(0, 200),
      summary: String(it.summary || '').slice(0, 500),
      source: String(it.source || 'LLM-curator').slice(0, 100),
      sourceUrl: it.sourceUrl || null,
    };
  }).filter(Boolean);
  const key = tenantSignalsKey(tenant.id);
  const existing = (await auth.kvGet(key)) || [];
  const existingUrls = new Set(existing.filter(s => s && s.sourceUrl).map(s => s.sourceUrl));
  const fresh = signals.filter(s => s.sourceUrl && !existingUrls.has(s.sourceUrl));
  const merged = [...fresh, ...existing]
    .sort((a, b) => (b.datum || '').localeCompare(a.datum || ''))
    .slice(0, SIGNALS_CAP);
  await auth.kvSet(key, merged);
  return {
    mode: 'llm',
    candidates: items.length,
    matched: signals.length,
    newSaved: fresh.length,
    totalAfter: merged.length,
    usage,
  };
}

async function refreshOneTenant(tenantId) {
  const tenant = await auth.kvGet(auth.tenantMetaKey(tenantId));
  if (!tenant) return { tenantId, error: 'Tenant niet gevonden' };
  // Twee modes kunnen samen lopen: feeds (goedkoop) + LLM (breder).
  // Beslislogica:
  //   - feeds[] aanwezig → run feeds
  //   - useLlmCurator true OF (geen feeds én Anthropic key) → run LLM
  // Resultaten worden gemerged in de signals-KV (per refreshViaX-functie).
  const runs = [];
  let result = null;
  const hasFeeds = Array.isArray(tenant.feeds) && tenant.feeds.length > 0;
  const wantLlm = !!tenant.useLlmCurator || (!hasFeeds && !!process.env.ANTHROPIC_API_KEY);
  if (hasFeeds) {
    try { runs.push({ feeds: await refreshViaFeeds(tenant) }); } catch (e) { runs.push({ feeds: { mode: 'feeds', error: String(e.message || e) } }); }
  }
  if (wantLlm) {
    try { runs.push({ llm: await refreshViaLlm(tenant) }); } catch (e) { runs.push({ llm: { mode: 'llm', error: String(e.message || e) } }); }
  }
  if (runs.length === 0) {
    result = { mode: 'no-source', reason: 'Geen feeds geconfigureerd en LLM-curator niet geactiveerd. Voeg feeds toe in Beheer > Werkomgeving of zet useLlmCurator aan.' };
  } else if (runs.length === 1) {
    result = runs[0].feeds || runs[0].llm;
  } else {
    result = { mode: 'combined', feeds: runs[0].feeds, llm: runs[1].llm };
  }
  // Schrijf laatste-run-log voor inspectie in de Beheer-UI
  await auth.kvSet(tenantRefreshLogKey(tenantId), {
    ranAt: Date.now(),
    ...result,
  });
  return { tenantId, naam: tenant.naam, ...result };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.kvConfigured()) {
    return res.status(503).json({ error: 'KV niet geconfigureerd' });
  }
  // Twee auth-paden:
  // 1. Vercel cron / CRON_SECRET → mag alle tenants of specifieke ID
  // 2. Sessie-token → alleen de eigen tenant (tenantId uit sessie)
  const cronOk = isAuthorizedCron(req);
  let sessionTenantId = null;
  if (!cronOk) {
    sessionTenantId = await getSessionAuth(req);
    if (!sessionTenantId) {
      return res.status(401).json({ error: 'Unauthorized — Vercel cron, CRON_SECRET of geldige sessie vereist' });
    }
  }
  try {
    if (sessionTenantId) {
      // Sessie-pad: forceer tenantId vanuit sessie, negeer ?tenantId param
      const r = await refreshOneTenant(sessionTenantId);
      return res.status(200).json({ ok: true, mode: 'session', results: [r] });
    }
    const explicit = req.query && req.query.tenantId;
    if (explicit) {
      const r = await refreshOneTenant(String(explicit));
      return res.status(200).json({ ok: true, results: [r] });
    }
    const tenantIds = await getAllTenantIds();
    const results = [];
    for (const tid of tenantIds) {
      try {
        results.push(await refreshOneTenant(tid));
      } catch (e) {
        results.push({ tenantId: tid, error: String(e.message || e) });
      }
    }
    return res.status(200).json({
      ok: true,
      ranAt: new Date().toISOString(),
      tenantsChecked: tenantIds.length,
      results,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
