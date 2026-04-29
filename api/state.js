// Generieke key/value endpoint voor cross-device state. Auth vereist zodra
// Vercel KV geconfigureerd is; zonder KV werkt deze endpoint niet en valt
// de client terug op localStorage.

const auth = require('./_lib/auth');

const ALLOWED_KEYS = new Set([
  'todos', 'dmu-overrides', 'spec-overrides', 'overrides',
  'dropdowns', 'owners', 'signal-history',
]);
const KEY_PREFIX = 'marktradar:state:v1:';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!auth.kvConfigured()) {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    const session = await auth.requireAuth(req, res);
    if (session === false) return; // 401 al verzonden

    if (req.method === 'GET') {
      const key = (req.query && req.query.key) || '';
      if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Onbekende key' });
      const value = await auth.kvGet(KEY_PREFIX + key);
      return res.status(200).json({ value: value || {} });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const key = body.key;
      const value = body.value;
      if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Onbekende key' });
      if (value === undefined || value === null) return res.status(400).json({ error: 'value ontbreekt' });
      await auth.kvSet(KEY_PREFIX + key, value);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
