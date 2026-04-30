// Signals-list endpoint: leest de auto-gegenereerde signalen uit
// marktradar:tenant:<id>:signals:v1 (geschreven door /api/signals/refresh).
// Auth verplicht; tenant-scoped uit sessie.
//
// GET /api/signals/list                   → { signals, lastRun }
// POST /api/signals/list   body: { signals } → vervangt de hele array
//                                              (handig voor handmatige cleanup)

const auth = require('../_lib/auth');

function key(tenantId) { return 'marktradar:tenant:' + tenantId + ':signals:v1'; }
function lastRunKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':signals:lastRun'; }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.kvConfigured()) {
    return res.status(503).json({ error: 'KV niet geconfigureerd' });
  }
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  try {
    if (req.method === 'GET') {
      const signals = (await auth.kvGet(key(session.tenantId))) || [];
      const lastRun = await auth.kvGet(lastRunKey(session.tenantId));
      return res.status(200).json({ signals, lastRun: lastRun || null });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const arr = Array.isArray(body.signals) ? body.signals : null;
      if (!arr) return res.status(400).json({ error: 'signals-array verplicht' });
      await auth.kvSet(key(session.tenantId), arr.slice(0, 100));
      return res.status(200).json({ ok: true, count: arr.length });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
