// Gedeelde helpers voor api/auth.js, api/state.js en api/assignments.js.
// Geen externe dependencies; gebruikt alleen Node-builtins (crypto, util).

const { scrypt: scryptCb, randomBytes, timingSafeEqual } = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(scryptCb);

const KV_USER_PREFIX = 'marktradar:user:';
const KV_SESSION_PREFIX = 'marktradar:session:';
const KV_USERS_INDEX = 'marktradar:users:index';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function kvConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function kvFetch(path, init) {
  if (!kvConfigured()) {
    const e = new Error('KV not configured');
    e.code = 'NO_KV';
    throw e;
  }
  const res = await fetch(`${process.env.KV_REST_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`KV error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function kvGet(key) {
  const data = await kvFetch('/get/' + encodeURIComponent(key));
  return data?.result ? JSON.parse(data.result) : null;
}

async function kvSet(key, value) {
  return kvFetch('/set/' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)),
  });
}

async function kvDel(key) {
  return kvFetch('/del/' + encodeURIComponent(key), { method: 'POST' });
}

function makeId(prefix) {
  return (prefix || '') + randomBytes(8).toString('hex');
}

function makeToken() {
  return randomBytes(32).toString('hex');
}

function makeSalt() {
  return randomBytes(16).toString('hex');
}

async function hashPassword(password, salt) {
  const buf = await scrypt(String(password), salt, 64);
  return buf.toString('hex');
}

async function verifyPassword(password, salt, expected) {
  const buf = await scrypt(String(password), salt, 64);
  const a = Buffer.from(expected, 'hex');
  return a.length === buf.length && timingSafeEqual(a, buf);
}

function bearerToken(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function getSession(req) {
  const token = bearerToken(req);
  if (!token) return null;
  try {
    const session = await kvGet(KV_SESSION_PREFIX + token);
    if (!session) return null;
    if (session.expires && session.expires < Date.now()) {
      await kvDel(KV_SESSION_PREFIX + token).catch(() => {});
      return null;
    }
    return { ...session, token };
  } catch (e) {
    if (e.code === 'NO_KV') return null;
    throw e;
  }
}

// Gate elke schrijf-/leesactie op gedeelde state achter een geldige sessie
// zodra KV beschikbaar is. Zonder KV (legacy mode) is auth uit.
async function requireAuth(req, res) {
  if (!kvConfigured()) return null;
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return false;
  }
  return session;
}

module.exports = {
  KV_USER_PREFIX,
  KV_SESSION_PREFIX,
  KV_USERS_INDEX,
  SESSION_TTL_MS,
  kvConfigured,
  kvFetch,
  kvGet,
  kvSet,
  kvDel,
  makeId,
  makeToken,
  makeSalt,
  hashPassword,
  verifyPassword,
  bearerToken,
  getSession,
  requireAuth,
};
