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

function refreshViaLlmStub(_tenant) {
  return {
    mode: 'llm-stub',
    skipped: true,
    reason: 'LLM-curator nog niet geïmplementeerd. Configureer feeds via Beheer > Werkomgeving om automatische refresh te activeren.',
  };
}

async function refreshOneTenant(tenantId) {
  const tenant = await auth.kvGet(auth.tenantMetaKey(tenantId));
  if (!tenant) return { tenantId, error: 'Tenant niet gevonden' };
  let result;
  if (Array.isArray(tenant.feeds) && tenant.feeds.length > 0) {
    result = await refreshViaFeeds(tenant);
  } else {
    result = refreshViaLlmStub(tenant);
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
  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ error: 'Unauthorized — alleen Vercel cron of geldige CRON_SECRET' });
  }
  try {
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
