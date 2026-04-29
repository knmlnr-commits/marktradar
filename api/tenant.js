// Tenant-instellingen: naam + markt-scope (set van instelling-IDs).
// Auth vereist; alle acties scopen op de tenant van de ingelogde user.
//
// Endpoints:
//   GET  /api/tenant?action=info                    -> { tenant }
//   POST /api/tenant?action=update     body: { naam? }
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
    createdAt: t.createdAt,
    market: Array.isArray(t.market) ? t.market : null,
    marketDefined: !!t.marketDefined,
  };
}

async function loadOrCreate(tenantId) {
  let t = await auth.kvGet(auth.tenantMetaKey(tenantId));
  if (!t) {
    t = {
      id: tenantId,
      naam: 'MarktRadar',
      createdAt: Date.now(),
      market: null,
      marketDefined: false,
      legacy: tenantId === auth.LEGACY_TENANT_ID,
    };
    await auth.kvSet(auth.tenantMetaKey(tenantId), t);
  }
  return t;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!auth.kvConfigured()) {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    const session = await auth.requireAuth(req, res);
    if (session === false) return;
    const action = (req.query && req.query.action) || 'info';

    if (action === 'info') {
      const t = await loadOrCreate(session.tenantId);
      return res.status(200).json({ tenant: publicTenant(t) });
    }
    if (action === 'update' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const t = await loadOrCreate(session.tenantId);
      if (typeof body.naam === 'string') t.naam = String(body.naam).trim() || t.naam;
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
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
