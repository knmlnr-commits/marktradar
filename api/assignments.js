// Eigenaar-toewijzingen per instelling. Auth vereist zodra Vercel KV
// geconfigureerd is; zonder KV werkt deze endpoint niet en valt de client
// terug op localStorage + de statische data/assignments.json baseline.

const auth = require('./_lib/auth');

const KEY = 'marktradar:assignments:v1';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!auth.kvConfigured()) {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    const session = await auth.requireAuth(req, res);
    if (session === false) return;

    if (req.method === 'GET') {
      const value = (await auth.kvGet(KEY)) || {};
      return res.status(200).json({ assignments: value });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const assignments = body.assignments;
      if (!assignments || typeof assignments !== 'object') {
        return res.status(400).json({ error: 'Body moet { assignments: {...} } zijn' });
      }
      await auth.kvSet(KEY, assignments);
      return res.status(200).json({ ok: true, count: Object.keys(assignments).length });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
