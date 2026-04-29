// Email + wachtwoord-authenticatie voor MarktRadar.
//
// Endpoints (allemaal via ?action=…):
//   GET  /api/auth?action=me        -> { user } of 401
//   POST /api/auth?action=register  body: { email, naam, password } -> { user, token }
//   POST /api/auth?action=login     body: { email, password }       -> { user, token }
//   POST /api/auth?action=logout                                    -> { ok: true }
//
// Vereist Vercel KV. Zonder KV werkt deze endpoint niet en valt de client
// terug op de oude code-gate.

const auth = require('./_lib/auth');

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, naam: u.naam, createdAt: u.createdAt };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  // Fallback: stream
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function appendUserIndex(email) {
  const list = (await auth.kvGet(auth.KV_USERS_INDEX)) || [];
  if (!list.includes(email)) {
    list.push(email);
    await auth.kvSet(auth.KV_USERS_INDEX, list);
  }
}

async function register(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const naam = String(body.naam || '').trim();
  const password = String(body.password || '');
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ongeldig email-adres' });
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });

  const existing = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (existing) return res.status(409).json({ error: 'Er bestaat al een account voor dit email-adres' });

  const salt = auth.makeSalt();
  const passwordHash = await auth.hashPassword(password, salt);
  const user = {
    id: auth.makeId('u_'),
    email,
    naam,
    salt,
    passwordHash,
    createdAt: Date.now(),
  };
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  await appendUserIndex(email);

  const token = auth.makeToken();
  await auth.kvSet(
    auth.KV_SESSION_PREFIX + token,
    { userId: user.id, email, expires: Date.now() + auth.SESSION_TTL_MS },
    { ttlSec: auth.SESSION_TTL_SEC }
  );
  return res.status(200).json({ user: publicUser(user), token });
}

async function login(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
  const user = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (!user) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  const ok = await auth.verifyPassword(password, user.salt, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  const token = auth.makeToken();
  await auth.kvSet(
    auth.KV_SESSION_PREFIX + token,
    { userId: user.id, email, expires: Date.now() + auth.SESSION_TTL_MS },
    { ttlSec: auth.SESSION_TTL_SEC }
  );
  return res.status(200).json({ user: publicUser(user), token });
}

async function me(req, res) {
  const session = await auth.getSession(req);
  if (!session) return res.status(401).json({ error: 'Niet ingelogd' });
  const user = await auth.kvGet(auth.KV_USER_PREFIX + session.email);
  if (!user) return res.status(401).json({ error: 'Account niet gevonden' });
  return res.status(200).json({ user: publicUser(user) });
}

async function logout(req, res) {
  const token = auth.bearerToken(req);
  if (token) await auth.kvDel(auth.KV_SESSION_PREFIX + token).catch(() => {});
  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.kvConfigured()) {
    return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
  }
  const action = (req.query && req.query.action) || '';
  try {
    if (action === 'register' && req.method === 'POST') return register(req, res);
    if (action === 'login' && req.method === 'POST') return login(req, res);
    if (action === 'me' && (req.method === 'GET' || req.method === 'POST')) return me(req, res);
    if (action === 'logout' && req.method === 'POST') return logout(req, res);
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
