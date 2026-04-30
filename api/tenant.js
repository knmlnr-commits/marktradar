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
    onboardingDone: !!t.onboardingDone,
    market: Array.isArray(t.market) ? t.market : null,
    marketDefined: !!t.marketDefined,
  };
}

// Versie zonder gevoelige velden voor publieke (unauth) lookup: alleen
// brandings-informatie zodat /app/<slug> de juiste naam kan tonen.
function publicTenantBranding(t) {
  if (!t) return null;
  return {
    naam: t.naam || 'MarktRadar',
    slug: t.slug || null,
  };
}

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
      // GeriCall heeft een ingebouwde VVT-baseline, dus onboarding is af.
      t.onboardingDone = true;
      t.propositie = 'GeriCall · ANW-zorg & VVT-marktintelligentie voor zorgleveranciers';
      t.marktNaam = 'VVT (verpleeg-, verzorgings- en thuiszorg)';
      await auth.kvSet(auth.tenantSlugKey(auth.LEGACY_TENANT_SLUG), tenantId);
    }
    await auth.kvSet(auth.tenantMetaKey(tenantId), t);
  }
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
    if (action === 'set-onboarding-done' && req.method === 'POST') {
      const t = await loadOrCreate(session.tenantId);
      t.onboardingDone = true;
      t.onboardingDoneAt = Date.now();
      await auth.kvSet(auth.tenantMetaKey(session.tenantId), t);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
