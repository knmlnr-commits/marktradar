// Public demo-aanvraag endpoint. Geen auth — wordt aangeroepen vanuit de
// landing-page (index.html). Slaat de aanvraag op in KV onder een
// dedicated prefix zodat een admin ze achteraf kan reviewen via een
// los script of via Redis CLI.
//
// POST body: { naam, organisatie, email, telefoon?, rol?, bericht? }

const auth = require('./_lib/auth');
const { randomBytes } = require('crypto');

const KEY_PREFIX = 'marktradar:demo-request:';
const INDEX_KEY = 'marktradar:demo-request:index';

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

function clientIp(req) {
  const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For']);
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

function makeId() { return 'dr_' + randomBytes(8).toString('hex'); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!auth.kvConfigured()) {
    return res.status(503).json({
      error: 'Aanvraag-systeem nog niet geconfigureerd. Mail ons direct op hello@marktradar.nl.',
    });
  }
  try {
    const body = await readJsonBody(req);
    const naam = String(body.naam || '').trim();
    const organisatie = String(body.organisatie || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const telefoon = String(body.telefoon || '').trim();
    const rol = String(body.rol || '').trim();
    const bericht = String(body.bericht || '').trim();

    if (!naam || !organisatie || !email) {
      return res.status(400).json({ error: 'Naam, organisatie en email zijn verplicht.' });
    }
    if (!/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: 'Vul een geldig emailadres in.' });
    }
    if (naam.length > 200 || organisatie.length > 200 || email.length > 200 ||
        telefoon.length > 50 || rol.length > 100 || bericht.length > 4000) {
      return res.status(400).json({ error: 'Een of meer velden zijn te lang.' });
    }

    const id = makeId();
    const record = {
      id,
      naam, organisatie, email, telefoon, rol, bericht,
      createdAt: Date.now(),
      ip: clientIp(req).slice(0, 64),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
      status: 'nieuw',
    };
    await auth.kvSet(KEY_PREFIX + id, record);
    const index = (await auth.kvGet(INDEX_KEY)) || [];
    index.push({ id, email, organisatie, createdAt: record.createdAt });
    await auth.kvSet(INDEX_KEY, index);

    return res.status(200).json({
      ok: true,
      message: 'Bedankt! We nemen binnen één werkdag contact op.',
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
