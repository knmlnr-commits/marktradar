// Vercel serverless function voor cross-device opslag van eigenaar-toewijzingen.
//
// Setup (eenmalig in het Vercel-dashboard):
//   1. Storage tab → Create Database → KV
//   2. Connect aan dit project
//   3. De env vars KV_REST_API_URL en KV_REST_API_TOKEN worden automatisch geinjecteerd
//   4. Redeploy
//
// Zonder KV-config faalt deze endpoint met 503 en valt de client terug op
// localStorage + de statische data/assignments.json baseline.

const KEY = 'marktradar:assignments:v1';

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
      const data = await kvFetch(`/get/${KEY}`);
      const value = data?.result ? JSON.parse(data.result) : {};
      return res.status(200).json({ assignments: value });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = req.body || {};
      const assignments = body.assignments;
      if (!assignments || typeof assignments !== 'object') {
        return res.status(400).json({ error: 'Body moet { assignments: {...} } zijn' });
      }
      await kvFetch(`/set/${KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(assignments)),
      });
      return res.status(200).json({ ok: true, count: Object.keys(assignments).length });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err.code === 'NO_KV') {
      return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
    }
    return res.status(500).json({ error: String(err.message || err) });
  }
}
