// Generieke key/value endpoint voor cross-device state (todos, dmu-overrides, etc).
// Werkt op Vercel KV; zelfde setup als api/assignments.js (dezelfde KV-database
// kan worden gedeeld).
//
// GET  /api/state?key=<naam>          -> { value: <opgeslagen JSON> }
// POST /api/state  body: { key, value } -> { ok: true }
//
// Toegestane keys staan in een whitelist hieronder om misbruik te voorkomen.

const ALLOWED_KEYS = new Set(['todos', 'dmu-overrides', 'spec-overrides', 'overrides', 'dropdowns', 'owners', 'signal-history']);
const KEY_PREFIX = 'marktradar:state:v1:';

async function kvFetch(path, init) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    const e = new Error('KV not configured');
    e.code = 'NO_KV';
    throw e;
  }
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`KV error ${res.status}: ${await res.text()}`);
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const key = (req.query && req.query.key) || '';
      if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Onbekende key' });
      const data = await kvFetch(`/get/${KEY_PREFIX}${key}`);
      const value = data?.result ? JSON.parse(data.result) : {};
      return res.status(200).json({ value });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const key = body.key;
      const value = body.value;
      if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'Onbekende key' });
      if (value === undefined || value === null) {
        return res.status(400).json({ error: 'value ontbreekt' });
      }
      await kvFetch(`/set/${KEY_PREFIX}${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value)),
      });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.code === 'NO_KV') {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    return res.status(500).json({ error: String(err.message || err) });
  }
};
