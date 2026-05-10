// Tenant-instellingen: naam, slug + markt-scope (set van entiteit-IDs).
// Auth vereist voor mutaties; by-slug lookup is publiek (alleen branding).
//
// Endpoints:
//   GET  /api/tenant?action=info                    -> { tenant }
//   GET  /api/tenant?action=by-slug&slug=...        -> { tenant }   (publiek, branding-only)
//   POST /api/tenant?action=update     body: { naam?, slug? }
//   POST /api/tenant?action=set-market body: { instellingIds: [..], marketDefined?: bool }
//   POST /api/tenant?action=clear-market                                                    -> { tenant }

const auth = require('./_lib/auth');

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function publicTenant(t) {
  if (!t) return null;
  return {
    id: t.id,
    naam: t.naam || 'MarktRadar',
    slug: t.slug || null,
    createdAt: t.createdAt,
    propositie: t.propositie || null,
    marktNaam: t.marktNaam || null,
    marktBeschrijving: t.marktBeschrijving || null,
    entiteiten: Array.isArray(t.entiteiten) ? t.entiteiten : null,
    klanten: Array.isArray(t.klanten) ? t.klanten : [],
    feeds: Array.isArray(t.feeds) ? t.feeds : [],
    useLlmCurator: !!t.useLlmCurator,
    logoDataUri: t.logoDataUri || null,
    onboardingDone: !!t.onboardingDone,
    market: Array.isArray(t.market) ? t.market : null,
    marketDefined: !!t.marketDefined,
    klantSchema: Array.isArray(t.klantSchema) ? t.klantSchema : [],
    theme: t.theme && typeof t.theme === 'object' ? t.theme : null,
    signalPromptOverride: typeof t.signalPromptOverride === 'string' ? t.signalPromptOverride : '',
    oppStages: Array.isArray(t.oppStages) ? t.oppStages : null,
    oppTargets: Array.isArray(t.oppTargets) ? t.oppTargets : [],
    salesPlan: t.salesPlan && typeof t.salesPlan === 'object' ? t.salesPlan : null,
    decisionMakerRoles: Array.isArray(t.decisionMakerRoles) ? t.decisionMakerRoles : null,
  };
}

// Default feed-set voor de GeriCall seed-tenant. URL's verifieer je
// handmatig in Beheer > Werkomgeving voordat de eerste cron-run draait;
// publieke RSS-URL's kunnen verschuiven en niet alle bronnen exposen
// een feed (TenderNed bv. niet — die heeft een aparte API).
const GERICALL_DEFAULT_FEEDS = [
  { url: 'https://www.skipr.nl/feed/', label: 'Skipr', type: 'rss' },
  { url: 'https://www.zorgvisie.nl/feed/', label: 'Zorgvisie', type: 'rss' },
  { url: 'https://www.icthealth.nl/feed/', label: 'ICTHealth', type: 'rss' },
  { url: 'https://www.nationalezorggids.nl/rss-nieuws.xml', label: 'NationaleZorggids', type: 'rss' },
];

// Versie zonder gevoelige velden voor publieke (unauth) lookup: branding
// + theme zodat /app/<slug> bij eerste paint al de tenant-kleuren toont
// (anders flasht de gate eerst in default-oranje en daarna pas in de
// juiste kleurset). Theme is niet-gevoelig — alleen hex-codes.
function publicTenantBranding(t) {
  if (!t) return null;
  return {
    naam: t.naam || 'MarktRadar',
    slug: t.slug || null,
    logoDataUri: t.logoDataUri || null,
    theme: t.theme && typeof t.theme === 'object' ? t.theme : null,
  };
}

// GeriCall canonical defaults — gebruikt zowel bij eerste creatie als bij
// idempotent backfill voor bestaande tenant-records die nog op oudere
// schemaversie zitten. Backfill respecteert handmatige user-edits: alleen
// ontbrekende of expliciet 'oude default'-waarden worden vervangen.
const GERICALL_PROPOSITIE = 'GeriCall biedt VVT-organisaties 24/7 ANW-bereikbaarheid van specialisten ouderengeneeskunde, zodat hun eigen artsen geen avond-, nacht- en weekenddiensten hoeven te draaien.';
const GERICALL_MARKTNAAM = 'VVT — verpleeg-, verzorgings- en thuiszorg Nederland';
const GERICALL_MARKTBESCHRIJVING = 'Nederlandse VVT-instellingen met intramurale capaciteit (verpleeghuiszorg, GRZ, ELV) waar specialisten ouderengeneeskunde nodig zijn voor avond-, nacht- en weekendzorg. Focus op organisaties met 200+ cliënten waar eigen SO-capaciteit ontoereikend is voor 24/7 dekking; secundair de thuiszorg- en VPT-segmenten waar ANW-bereikbaarheid via samenwerkingsverbanden loopt (ThoeZ, AWIZ, NOB Green Deal).';
const GERICALL_OLD_PROPOSITIES = [
  'GeriCall · ANW-zorg & VVT-marktintelligentie voor zorgleveranciers',
];
const GERICALL_OLD_MARKTNAAMEN = [
  'VVT (verpleeg-, verzorgings- en thuiszorg)',
];

async function loadOrCreate(tenantId) {
  let t = await auth.kvGet(auth.tenantMetaKey(tenantId));
  if (!t) {
    t = {
      id: tenantId,
      naam: 'MarktRadar',
      slug: null,
      createdAt: Date.now(),
      market: null,
      marketDefined: false,
      legacy: tenantId === auth.LEGACY_TENANT_ID,
    };
    if (tenantId === auth.LEGACY_TENANT_ID) {
      t.naam = 'GeriCall';
      t.slug = auth.LEGACY_TENANT_SLUG;
      t.onboardingDone = true;
      t.propositie = GERICALL_PROPOSITIE;
      t.marktNaam = GERICALL_MARKTNAAM;
      t.marktBeschrijving = GERICALL_MARKTBESCHRIJVING;
      t.feeds = GERICALL_DEFAULT_FEEDS.slice();
      await auth.kvSet(auth.tenantSlugKey(auth.LEGACY_TENANT_SLUG), tenantId);
    }
    await auth.kvSet(auth.tenantMetaKey(tenantId), t);
    return t;
  }
  // Centrale GeriCall-backfill (zelfde helper die /api/auth ook gebruikt).
  t = await auth.backfillGericallTenant(t);
  return t;
}

async function ensureUniqueSlug(base, ownTenantId) {
  const cleaned = auth.slugifyName(base);
  if (!cleaned) return null;
  let candidate = cleaned;
  for (let i = 0; i < 50; i++) {
    const existing = await auth.kvGet(auth.tenantSlugKey(candidate));
    if (!existing || existing === ownTenantId) return candidate;
    candidate = cleaned + '-' + (i + 2);
  }
  return cleaned + '-' + Math.random().toString(36).slice(2, 6);
}

async function setSlug(tenant, newSlug) {
  if (tenant.slug && tenant.slug !== newSlug) {
    await auth.kvDel(auth.tenantSlugKey(tenant.slug)).catch(() => {});
  }
  tenant.slug = newSlug;
  await auth.kvSet(auth.tenantSlugKey(newSlug), tenant.id);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!auth.kvConfigured()) {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    const action = (req.query && req.query.action) || 'info';

    // Publieke endpoint: slug → branding (alleen naam + slug, geen state)
    if (action === 'by-slug') {
      const slug = String((req.query && req.query.slug) || '').toLowerCase().trim();
      if (!slug) return res.status(400).json({ error: 'slug verplicht' });
      // Reserved slug 'gericall' geeft altijd de legacy-tenant terug, ook
      // als de meta-record nog niet on-the-fly is aangemaakt.
      let tenantId = await auth.kvGet(auth.tenantSlugKey(slug));
      if (!tenantId && slug === auth.LEGACY_TENANT_SLUG) tenantId = auth.LEGACY_TENANT_ID;
      if (!tenantId) return res.status(404).json({ error: 'Werkomgeving niet gevonden' });
      const t = await loadOrCreate(tenantId);
      return res.status(200).json({ tenant: publicTenantBranding(t) });
    }

    // Vanaf hier: auth vereist
    const session = await auth.requireAuth(req, res);
    if (session === false) return;

    if (action === 'info') {
      const t = await loadOrCreate(session.tenantId);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'update' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const t = await loadOrCreate(session.tenantId);
      if (typeof body.naam === 'string') t.naam = String(body.naam).trim() || t.naam;
      if (typeof body.useLlmCurator === 'boolean') t.useLlmCurator = body.useLlmCurator;
      if (typeof body.signalPromptOverride === 'string') {
        t.signalPromptOverride = String(body.signalPromptOverride).slice(0, 4000);
      }
      if (body.salesPlan && typeof body.salesPlan === 'object') {
        // SalesPlan = vier vaste secties (doelstellingen / marktbenadering /
        // speerpunten / mijlpalen). Per sectie cap op 4000 chars zodat de
        // tenant-record beheersbaar blijft. updatedAt wordt server-side
        // gezet zodat de UI kan tonen wanneer het plan voor het laatst is
        // bijgewerkt.
        const sec = (k) => typeof body.salesPlan[k] === 'string'
          ? String(body.salesPlan[k]).slice(0, 4000)
          : '';
        t.salesPlan = {
          doelstellingen: sec('doelstellingen'),
          marktbenadering: sec('marktbenadering'),
          speerpunten: sec('speerpunten'),
          mijlpalen: sec('mijlpalen'),
          updatedAt: Date.now(),
        };
      } else if (body.salesPlan === null) {
        t.salesPlan = null;
      }
      if (Array.isArray(body.oppTargets)) {
        // Per (year, stage_key, owner_id) een target_count + target_avg_value_eur.
        // owner_id is optioneel: leeg = tenant-totaal, gevuld = persoonlijk
        // target voor die owner. Year is 4-digit kalenderjaar als string.
        // Stage_key wordt niet gevalideerd tegen oppStages — als de stage
        // later wordt hernoemd of verwijderd blijft de historische target staan.
        // Cap verhoogd naar 600 entries (200 stage-buckets × ~3 owners).
        const seen = new Set();
        t.oppTargets = body.oppTargets.slice(0, 600).map((tg) => {
          const year = String(tg.year || '').trim();
          if (!/^[0-9]{4}$/.test(year)) return null;
          const stage_key = String(tg.stage_key || '').trim().slice(0, 40);
          if (!stage_key) return null;
          const owner_id = tg.owner_id == null ? '' : String(tg.owner_id).trim().slice(0, 60);
          const composite = year + '|' + stage_key + '|' + owner_id;
          if (seen.has(composite)) return null;
          seen.add(composite);
          let count = parseInt(tg.target_count, 10);
          if (isNaN(count) || count < 0) count = 0;
          if (count > 100000) count = 100000;
          let avg = parseFloat(tg.target_avg_value_eur);
          if (isNaN(avg) || avg < 0) avg = 0;
          if (avg > 1e12) avg = 1e12;
          const out = { year, stage_key, target_count: count, target_avg_value_eur: avg };
          if (owner_id) out.owner_id = owner_id;
          return out;
        }).filter(Boolean);
      }
      if (Array.isArray(body.oppStages)) {
        // Whitelist + normaliseer per fase. Stage-key wordt gebruikt
        // als waarde in de opportunity-status-dropdown; label is voor
        // weergave; target_days = SLA in dagen vanaf stage-entry;
        // probability_pct = kans dat een opp deze fase verlaat met
        // een win (gebruikt voor weighted-funnel-totals).
        const seen = new Set();
        t.oppStages = body.oppStages.slice(0, 12).map((s) => {
          const key = String(s.key || s.label || '').trim().slice(0, 40);
          const label = String(s.label || s.key || '').trim().slice(0, 40);
          if (!key || seen.has(key)) return null;
          seen.add(key);
          let target = parseInt(s.target_days, 10);
          if (isNaN(target) || target < 0) target = 30;
          if (target > 3650) target = 3650;
          let prob = parseFloat(s.probability_pct);
          if (isNaN(prob) || prob < 0) prob = 0;
          if (prob > 100) prob = 100;
          return { key, label, target_days: target, probability_pct: prob };
        }).filter(Boolean);
      }
      if (body.theme === null) {
        // Reset naar default-theme.
        t.theme = null;
      } else if (body.theme && typeof body.theme === 'object') {
        // Whitelist hex-velden zodat we geen garbage in de KV krijgen.
        const hex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim()) ? v.trim() : null;
        const cleaned = {};
        ['primary', 'primaryDark', 'primaryLight', 'primaryPale', 'accent'].forEach((k) => {
          const v = hex(body.theme[k]);
          if (v) cleaned[k] = v;
        });
        t.theme = Object.keys(cleaned).length ? cleaned : null;
      }
      if (Array.isArray(body.klantSchema)) {
        // Validate + normalise: each entry needs id+label+type. We strip
        // unknown keys and cap at 60 fields om mis-imports te voorkomen.
        const allowedTypes = new Set(['text', 'number', 'date', 'enum', 'boolean', 'url', 'list-text', 'list-enum']);
        const seen = new Set();
        t.klantSchema = body.klantSchema.slice(0, 60).map((f) => {
          const id = String(f.id || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
          const label = String(f.label || '').trim().slice(0, 80);
          const type = allowedTypes.has(f.type) ? f.type : 'text';
          if (!id || !label || seen.has(id)) return null;
          seen.add(id);
          const out = { id, label, type };
          if ((type === 'enum' || type === 'list-enum') && Array.isArray(f.values)) {
            out.values = f.values.map((v) => String(v).slice(0, 60)).slice(0, 30);
          }
          if (f.placeholder) out.placeholder = String(f.placeholder).slice(0, 120);
          if (f.section) out.section = String(f.section).slice(0, 60);
          if (f.help) out.help = String(f.help).slice(0, 200);
          return out;
        }).filter(Boolean);
      }
      if (typeof body.slug === 'string' && body.slug.trim()) {
        // Legacy 'gericall' slug is gereserveerd voor de seed-tenant
        const desired = auth.slugifyName(body.slug.trim());
        if (!desired) return res.status(400).json({ error: 'Ongeldige slug; gebruik letters, cijfers en koppeltekens.' });
        if (desired === auth.LEGACY_TENANT_SLUG && t.id !== auth.LEGACY_TENANT_ID) {
          return res.status(409).json({ error: 'Deze slug is gereserveerd.' });
        }
        const finalSlug = await ensureUniqueSlug(desired, t.id);
        if (finalSlug !== desired) {
          // De gevraagde slug was al in gebruik; we hebben een suffix toegevoegd
          await setSlug(t, finalSlug);
          t.updatedAt = Date.now();
          t.updatedBy = session.email;
          await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
          return res.status(200).json({ tenant: publicTenant(t), slugAdjusted: true, requested: desired });
        }
        await setSlug(t, finalSlug);
      }
      t.updatedAt = Date.now();
      t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'set-market' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.instellingIds) ? body.instellingIds.map(String) : null;
      if (!ids) return res.status(400).json({ error: 'instellingIds-array verplicht' });
      const t = await loadOrCreate(session.tenantId);
      t.market = ids;
      t.marketDefined = body.marketDefined !== false;
      t.marketUpdatedAt = Date.now();
      t.marketUpdatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'clear-market' && req.method === 'POST') {
      const t = await loadOrCreate(session.tenantId);
      t.market = null;
      t.marketDefined = false;
      t.marketUpdatedAt = Date.now();
      t.marketUpdatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'set-propositie' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const t = await loadOrCreate(session.tenantId);
      if (typeof body.propositie === 'string') t.propositie = String(body.propositie).slice(0, 4000);
      if (typeof body.marktNaam === 'string') t.marktNaam = String(body.marktNaam).slice(0, 200).trim();
      if (typeof body.marktBeschrijving === 'string') t.marktBeschrijving = String(body.marktBeschrijving).slice(0, 4000);
      if (Array.isArray(body.decisionMakerRoles)) {
        const roles = body.decisionMakerRoles
          .map(r => String(r || '').trim())
          .filter(r => r.length > 0 && r.length <= 80)
          .slice(0, 12);
        t.decisionMakerRoles = roles.length > 0 ? roles : null;
      } else if (body.decisionMakerRoles === null) {
        t.decisionMakerRoles = null;
      }
      t.updatedAt = Date.now(); t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'set-entiteiten' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const arr = Array.isArray(body.entiteiten) ? body.entiteiten : null;
      if (!arr) return res.status(400).json({ error: 'entiteiten-array verplicht' });
      // Normaliseer: { id, naam, regio?, provincie?, segment?, tags?, klant?, leadScore?, ... }
      const seen = new Set();
      const cleaned = [];
      for (const e of arr.slice(0, 5000)) {
        if (!e || typeof e !== 'object') continue;
        const naam = String(e.naam || '').trim();
        if (!naam) continue;
        let id = String(e.id || '').trim() || auth.slugifyName(naam) || ('e_' + auth.makeId(''));
        let candId = id;
        let n = 2;
        while (seen.has(candId)) { candId = id + '-' + n; n++; }
        seen.add(candId);
        cleaned.push({
          id: candId,
          naam,
          regio: e.regio ? String(e.regio).slice(0, 80) : null,
          provincie: e.provincie ? String(e.provincie).slice(0, 80) : null,
          segment: e.segment ? String(e.segment).slice(0, 80) : null,
          klant: e.klant === true || e.klant === 'true',
          tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 20) : [],
          notes: e.notes ? String(e.notes).slice(0, 1000) : null,
          aantalMedewerkers: typeof e.aantalMedewerkers === 'number' ? e.aantalMedewerkers : null,
          omzet: typeof e.omzet === 'number' ? e.omzet : null,
          website: e.website ? String(e.website).slice(0, 300) : null,
        });
      }
      const t = await loadOrCreate(session.tenantId);
      t.entiteiten = cleaned;
      // Sync klanten[] uit entiteiten.klant
      t.klanten = cleaned.filter(x => x.klant).map(x => x.id);
      t.updatedAt = Date.now(); t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t), aantal: cleaned.length });
    }
    if (action === 'set-klanten' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.klanten) ? body.klanten.map(String) : null;
      if (!ids) return res.status(400).json({ error: 'klanten-array verplicht' });
      const t = await loadOrCreate(session.tenantId);
      const set = new Set(ids);
      t.klanten = ids;
      // Synchroniseer ook entiteiten.klant
      if (Array.isArray(t.entiteiten)) {
        t.entiteiten.forEach(e => { e.klant = set.has(String(e.id)); });
      }
      t.updatedAt = Date.now(); t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'set-logo' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const dataUri = typeof body.logoDataUri === 'string' ? body.logoDataUri : '';
      // Validatie: data:image/(svg+xml|png|jpeg|webp);base64,... — max 100KB
      if (dataUri && !/^data:image\/(svg\+xml|png|jpeg|jpg|webp);base64,/i.test(dataUri)) {
        return res.status(400).json({ error: 'Logo moet een data:image/(svg+xml|png|jpeg|webp);base64-URI zijn' });
      }
      if (dataUri && dataUri.length > 100000) {
        return res.status(400).json({ error: 'Logo te groot — maximaal 100 KB (≈75 KB binary).' });
      }
      const t = await loadOrCreate(session.tenantId);
      t.logoDataUri = dataUri || null;
      t.updatedAt = Date.now(); t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'set-feeds' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const feeds = Array.isArray(body.feeds) ? body.feeds : null;
      if (!feeds) return res.status(400).json({ error: 'feeds-array verplicht' });
      // Normaliseer + valideer URL's lichtjes
      const cleaned = [];
      for (const f of feeds.slice(0, 50)) {
        if (!f || typeof f !== 'object') continue;
        const url = String(f.url || '').trim();
        if (!url || !/^https?:\/\//i.test(url)) continue;
        cleaned.push({
          url: url.slice(0, 500),
          label: String(f.label || '').slice(0, 100).trim() || new URL(url).hostname,
          type: ['rss','atom'].includes(f.type) ? f.type : 'rss',
        });
      }
      const t = await loadOrCreate(session.tenantId);
      t.feeds = cleaned;
      t.updatedAt = Date.now(); t.updatedBy = session.email;
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t), aantal: cleaned.length });
    }
    if (action === 'last-refresh' && (req.method === 'GET' || req.method === 'POST')) {
      // Geeft het log-record van de laatste cron-run terug (of null als nog niet
      // gedraaid). Wordt door de Beheer-UI gebruikt om status te tonen.
      const log = await auth.kvGet('marktradar:tenant:' + session.tenantId + ':signals:lastRun');
      return res.status(200).json({ lastRun: log || null });
    }
    if (action === 'set-onboarding-done' && req.method === 'POST') {
      const t = await loadOrCreate(session.tenantId);
      t.onboardingDone = true;
      t.onboardingDoneAt = Date.now();
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'salesplan-draft' && req.method === 'POST') {
      // Genereert een concept-SalesPlan in vier secties op basis van de
      // bestaande tenant-context (propositie, markt, oppStages, oppTargets).
      // Returns { sections: { doelstellingen, marktbenadering, speerpunten,
      // mijlpalen } }. Slaat NIETS op — caller zet de tekst in de draft
      // en de gebruiker beslist wat er bewaard wordt via 'update'.
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
      }
      const t = await loadOrCreate(session.tenantId);
      const stages = Array.isArray(t.oppStages) ? t.oppStages : [];
      const targets = Array.isArray(t.oppTargets) ? t.oppTargets : [];
      const curYear = String(new Date().getFullYear());
      const tenantTargets = targets
        .filter((tg) => String(tg.year) === curYear && !tg.owner_id)
        .map((tg) => `  - ${tg.stage_key}: ${tg.target_count} opps × € ${tg.target_avg_value_eur}`)
        .join('\n') || '  (geen targets gezet)';
      const stagesList = stages
        .map((s) => `  - ${s.label} (key=${s.key}, prob=${s.probability_pct}%, SLA=${s.target_days}d)`)
        .join('\n') || '  (default Lead/Suspect/Prospect/Contract)';
      const sys = 'Je bent een sales-strateeg die helpt bij het opstellen van een SalesPlan. Geef een gestructureerd concept dat de gebruiker kan redigeren. Schrijf in het Nederlands, concreet en actiegericht. Geen prose buiten het JSON-object. Lengte per sectie: 4-8 zinnen, geen bullet-formatting tenzij bij Speerpunten/Mijlpalen.';
      const userMessage = `**Werkomgeving:** ${t.naam || ''}
**Propositie:** ${t.propositie || '(niet gezet)'}
**Markt:** ${t.marktNaam || '(niet gezet)'}
**Markt-beschrijving:** ${t.marktBeschrijving || '(niet gezet)'}

**Pipeline-fases:**
${stagesList}

**Targets ${curYear} (tenant-totaal):**
${tenantTargets}

**Opdracht:** Genereer een concept-SalesPlan in vier secties:
1. **Doelstellingen** — kwantitatieve + kwalitatieve doelen voor ${curYear}, gekoppeld aan de targets hierboven.
2. **Marktbenadering** — segmentatie, ideal customer profile, kanaal-keuze, value proposition per segment.
3. **Speerpunten** — 3-5 prioriteiten waar de organisatie deze periode op stuurt (bullet-list met '- ' prefix per punt).
4. **Mijlpalen** — 3-5 concrete kwartaal-mijlpalen met indicator wanneer ze 'gehaald' zijn (bullet-list met '- ' prefix).

**Output: alleen JSON-object, geen prose:**
{"doelstellingen":"...","marktbenadering":"...","speerpunten":"- ...\\n- ...","mijlpalen":"- Q1: ...\\n- Q2: ..."}`;

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          system: sys,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!apiRes.ok) {
        const txt = await apiRes.text();
        return res.status(502).json({ error: 'Claude API ' + apiRes.status + ': ' + txt.slice(0, 400) });
      }
      const j = await apiRes.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      // Strip markdown-codeblock-fences als Claude die meestuurt.
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      let sections;
      try {
        sections = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ error: 'Claude-response was geen geldig JSON', raw: text.slice(0, 500) });
      }
      const sec = (k) => typeof sections[k] === 'string' ? sections[k].slice(0, 4000) : '';
      return res.status(200).json({
        sections: {
          doelstellingen: sec('doelstellingen'),
          marktbenadering: sec('marktbenadering'),
          speerpunten: sec('speerpunten'),
          mijlpalen: sec('mijlpalen'),
        },
      });
    }
    if (action === 'accountplan-draft' && req.method === 'POST') {
      // Genereert een concept-accountplan voor één account op basis van
      // de tenant.salesPlan + propositie + de klantbeeld-context die de
      // client meestuurt (instelling-data, contacts, opportunities,
      // recente todos, recente signalen). Returns { sections, suggestedTodos }.
      // Slaat NIETS op — caller toont aan de gebruiker, die kiest welke
      // todos er aangemaakt worden en slaat dan zelf op.
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
      }
      const body = await readJsonBody(req);
      const ctx = body && body.context && typeof body.context === 'object' ? body.context : null;
      if (!ctx || !ctx.naam) {
        return res.status(400).json({ error: 'context.naam (account-naam) verplicht' });
      }
      const t = await loadOrCreate(session.tenantId);
      const sp = t.salesPlan && typeof t.salesPlan === 'object' ? t.salesPlan : null;
      const salesPlanBlock = sp
        ? `**Doelstellingen:** ${sp.doelstellingen || '(leeg)'}
**Marktbenadering:** ${sp.marktbenadering || '(leeg)'}
**Speerpunten:** ${sp.speerpunten || '(leeg)'}
**Mijlpalen:** ${sp.mijlpalen || '(leeg)'}`
        : '(geen SalesPlan opgesteld — geef generiek advies)';
      const safeStr = (v, max) => typeof v === 'string' ? v.slice(0, max || 1000) : '';
      const safeNum = (v) => typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : null);
      const fmtList = (arr, mapper, max) => {
        if (!Array.isArray(arr) || arr.length === 0) return '(geen)';
        return arr.slice(0, max || 20).map(mapper).filter(Boolean).join('\n') || '(geen)';
      };
      const customFieldsBlock = ctx.customFields && typeof ctx.customFields === 'object'
        ? Object.entries(ctx.customFields)
            .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
            .map(([k, v]) => `  - ${k}: ${String(v).slice(0, 200)}`)
            .join('\n') || '(geen)'
        : '(geen)';
      const contactsBlock = fmtList(ctx.contacts, (c) =>
        `  - ${safeStr(c.naam, 80)}${c.functie ? ' — ' + safeStr(c.functie, 80) : ''}${c.rol ? ' (' + safeStr(c.rol, 30) + ')' : ''}${c.vertrouwen ? ' [vertrouwen: ' + safeStr(c.vertrouwen, 30) + ']' : ''}`, 15);
      const oppsBlock = fmtList(ctx.opportunities, (o) => {
        const val = safeNum(o.value);
        return `  - "${safeStr(o.titel, 120)}" — fase: ${safeStr(o.status, 30) || '(onbekend)'}${val ? ', waarde € ' + val : ''}${o.eigenaar ? ', eigenaar: ' + safeStr(o.eigenaar, 60) : ''}`;
      }, 10);
      const todosBlock = fmtList(ctx.recentTodos, (td) =>
        `  - [${td.done ? 'x' : ' '}] ${safeStr(td.text, 200)}${td.ownerNaam ? ' (eigenaar: ' + safeStr(td.ownerNaam, 60) + ')' : ''}`, 15);
      const signalsBlock = fmtList(ctx.recentSignals, (s) =>
        `  - ${safeStr(s.datum, 12)} · ${safeStr(s.urgentie, 10)} · ${safeStr(s.headline, 200)}`, 8);

      const sys = 'Je bent een sales-strateeg die een accountplan opstelt voor één specifieke account. Gebruik het tenant-SalesPlan als kader en de klantbeeld-context (inclusief recente signalen) als feiten. Schrijf in het Nederlands, concreet en actiegericht. Geen prose buiten het JSON-object. Lengte per sectie: 3-6 zinnen of 3-6 bullet-punten met "- " prefix.';
      const userMessage = `**Werkomgeving:** ${t.naam || ''}
**Propositie:** ${t.propositie || '(niet gezet)'}
**Markt:** ${t.marktNaam || '(niet gezet)'}

**SalesPlan-kader:**
${salesPlanBlock}

**Account: ${ctx.naam}**
${ctx.eigenaarNaam ? `Account-eigenaar: ${ctx.eigenaarNaam}` : 'Account-eigenaar: (geen)'}
${ctx.regio ? `Regio: ${ctx.regio}` : ''}
${ctx.segment ? `Segment: ${ctx.segment}` : ''}
${ctx.notitie ? `Notitie: ${safeStr(ctx.notitie, 600)}` : ''}

**Custom-velden:**
${customFieldsBlock}

**Contactpersonen / DMU:**
${contactsBlock}

**Lopende opportunities:**
${oppsBlock}

**Recente todos (open + gedaan):**
${todosBlock}

**Recente signalen:**
${signalsBlock}

**Opdracht:** Maak een accountplan in vier secties + een lijst suggested todos. Alle output gegrond in de feiten hierboven; geen verzonnen contactpersonen of bedragen. Suggested todos zijn concrete acties (5-8) die de account-eigenaar moet doen om dit plan te realiseren — start met een werkwoord, max 120 chars per todo.

1. **Strategische context** — wat is de positie van dit account binnen ons SalesPlan en de markt; recente ontwikkelingen (gegrond in signalen + custom-velden) en de impact daarvan op onze deal-kansen of risico's.
2. **Stakeholders & koopcriteria** — DMU-mapping uit de contacten hierboven (decider/champion/blocker), welke koopcriteria spelen, welke relaties moeten nog worden opgebouwd of versterkt.
3. **Aanpak (propositie + tactiek)** — welke onderdelen van onze propositie passen bij dit account, welke tactische stappen (events, demo, pilot, partnership) en met welke contact-frequentie.
4. **Volgende stappen** — concrete kwartaal-mijlpalen voor dit account met indicator wanneer 'gehaald'.

**Output: alleen JSON-object, geen prose:**
{"sections":{"strategischeContext":"...","stakeholdersKoopcriteria":"...","aanpak":"...","volgendeStappen":"..."},"suggestedTodos":["Bel decider X om Y te bespreken","Stuur propositie-deck naar Z",...]}`;

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          system: sys,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!apiRes.ok) {
        const txt = await apiRes.text();
        return res.status(502).json({ error: 'Claude API ' + apiRes.status + ': ' + txt.slice(0, 400) });
      }
      const j = await apiRes.json();
      const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return res.status(502).json({ error: 'Claude-response was geen geldig JSON', raw: text.slice(0, 500) });
      }
      const secObj = (parsed && parsed.sections && typeof parsed.sections === 'object') ? parsed.sections : {};
      const sec = (k) => typeof secObj[k] === 'string' ? secObj[k].slice(0, 4000) : '';
      const suggestedTodos = Array.isArray(parsed.suggestedTodos)
        ? parsed.suggestedTodos.map((s) => String(s || '').slice(0, 200)).filter(Boolean).slice(0, 12)
        : [];
      return res.status(200).json({
        sections: {
          strategischeContext: sec('strategischeContext'),
          stakeholdersKoopcriteria: sec('stakeholdersKoopcriteria'),
          aanpak: sec('aanpak'),
          volgendeStappen: sec('volgendeStappen'),
        },
        suggestedTodos,
      });
    }
    if (action === 'find-decision-makers' && req.method === 'POST') {
      // Zoekt publieke LinkedIn-profielen van beslissers bij een specifieke
      // account via Claude's web_search-tool (server-side). Geen scraping van
      // LinkedIn zelf — alleen search-engine snippets met site:linkedin.com.
      // Returns { results: [{ name, title, linkedinUrl, snippet }], cached, queriedAt }.
      // Cache 24h per (tenantId, instId, rolesHash) zodat herhaaldelijk klikken
      // niet onnodig kost.
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
      }
      const body = await readJsonBody(req);
      const instId = body && typeof body.instId === 'string' ? body.instId.trim() : '';
      const force = !!(body && body.force);
      if (!instId) return res.status(400).json({ error: 'instId verplicht' });
      const t = await loadOrCreate(session.tenantId);
      const ent = Array.isArray(t.entiteiten) ? t.entiteiten.find(e => String(e.id) === instId) : null;
      // Voor seed-tenant GeriCall staan accounts in de baseline (niet in
      // t.entiteiten); de client stuurt dan de accountnaam mee.
      const naam = (ent && ent.naam) || (body && typeof body.naam === 'string' ? body.naam.trim() : '');
      if (!naam) return res.status(400).json({ error: 'account niet gevonden' });
      const regio = (ent && ent.regio) || (body && typeof body.regio === 'string' ? body.regio : '') || '';
      const website = (ent && ent.website) || (body && typeof body.website === 'string' ? body.website : '') || '';
      const DEFAULT_DM_ROLES = ['CEO', 'directeur', 'bestuurder', 'COO', 'CFO', 'CTO', 'algemeen directeur', 'managing director'];
      const roles = (Array.isArray(t.decisionMakerRoles) && t.decisionMakerRoles.length > 0)
        ? t.decisionMakerRoles
        : DEFAULT_DM_ROLES;
      // Existing contacts om dubbele resultaten uit te filteren in de prompt.
      const existing = Array.isArray(body && body.existingContacts) ? body.existingContacts : [];
      const existingNames = existing
        .map(c => (c && typeof c.naam === 'string') ? c.naam.toLowerCase().trim() : '')
        .filter(Boolean);
      // Cache-key: tenant + inst + hash van rollen, zodat een wijziging in de
      // rol-set de cache invalideert. Eenvoudige hash op join.
      const rolesHash = Buffer.from(roles.slice().sort().join('|')).toString('base64').slice(0, 16);
      const cacheKey = 'tenant:' + session.tenantId + ':dmu-search:' + instId + ':' + rolesHash;
      if (!force) {
        try {
          const cached = await auth.kvGet(cacheKey);
          if (cached && cached.results && Array.isArray(cached.results)) {
            return res.status(200).json({ ...cached, cached: true });
          }
        } catch (e) { /* cache-miss of KV-error: doorvallen naar live-zoek */ }
      }
      const sys = 'Je bent een sales-research assistent. Je krijgt een bedrijfsnaam en een lijst beslisser-rollen. Gebruik de web_search-tool om publieke LinkedIn-profielen te vinden via "site:linkedin.com/in" queries. Per query 1 rol-keyword combineren met de bedrijfsnaam. Verzamel resultaten, deduplicate, en lever een schoon JSON-object terug. Geen prose buiten het JSON.';
      const queriesHint = roles.slice(0, 6).map(r => `site:linkedin.com/in "${naam}" "${r}"`).join('\n');
      const userMessage = `**Account:** ${naam}
${regio ? `**Regio/locatie:** ${regio}` : ''}
${website ? `**Website (verifieer dat het bedrijf klopt):** ${website}` : ''}

**Beslisser-rollen om te zoeken (in deze volgorde):**
${roles.map(r => '- ' + r).join('\n')}

**Bestaande contacten bij dit account (skip deze in de output):**
${existingNames.length > 0 ? existingNames.join(', ') : '(geen)'}

**Werkwijze:**
1. Doe per rol-keyword een web_search met query \`site:linkedin.com/in "${naam}" "[rol]"\`. Begin met de eerste 4-5 rollen; stop zodra je 10 unieke resultaten hebt.
2. Voorbeeld-queries:
${queriesHint}
3. Voor elk gevonden LinkedIn-profiel: extracteer naam (zoals op profiel), titel/functie (uit snippet), LinkedIn-URL (canonical /in/...), en het korte snippet dat de search-engine teruggaf.
4. Filter alleen profielen waar de bedrijfsnaam expliciet in titel of snippet staat (anders is het geen actuele werknemer). Skip oud-medewerkers ("ex-", "former", "voormalig").
5. Skip profielen waarvan de naam al in 'bestaande contacten' voorkomt (case-insensitive substring match).
6. Maximaal 10 resultaten. Als je niets vindt, return een lege array.

**Output: alleen JSON, geen prose:**
{"results":[{"name":"Voornaam Achternaam","title":"Functie · Bedrijf","linkedinUrl":"https://www.linkedin.com/in/...","snippet":"korte snippet uit search-resultaat"}, ...]}`;

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 3000,
          system: sys,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
      if (!apiRes.ok) {
        const txt = await apiRes.text();
        return res.status(502).json({ error: 'Claude API ' + apiRes.status + ': ' + txt.slice(0, 400) });
      }
      const j = await apiRes.json();
      // Pak de laatste assistant-text uit de content-blocks (na alle web_search-rondes).
      const text = (j.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        // Laatste poging: pak de eerste JSON-object-substring uit de tekst.
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
        }
      }
      if (!parsed || !Array.isArray(parsed.results)) {
        return res.status(502).json({ error: 'Claude-response was geen geldig JSON', raw: text.slice(0, 500) });
      }
      const existingSet = new Set(existingNames);
      const results = parsed.results
        .filter(r => r && typeof r === 'object' && typeof r.name === 'string' && typeof r.linkedinUrl === 'string')
        .filter(r => /linkedin\.com\/in\//i.test(r.linkedinUrl))
        .filter(r => !existingSet.has(r.name.toLowerCase().trim()))
        .slice(0, 10)
        .map(r => ({
          name: String(r.name).slice(0, 120).trim(),
          title: typeof r.title === 'string' ? r.title.slice(0, 200).trim() : '',
          linkedinUrl: String(r.linkedinUrl).slice(0, 300).trim(),
          snippet: typeof r.snippet === 'string' ? r.snippet.slice(0, 400).trim() : '',
        }));
      const payload = { results, queriedAt: Date.now() };
      try { await auth.kvSet(cacheKey, payload, { ttlSec: 86400 }); } catch (e) { /* niet-fataal */ }
      return res.status(200).json({ ...payload, cached: false });
    }
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
