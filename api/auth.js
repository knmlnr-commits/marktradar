// Email + wachtwoord-authenticatie + gebruikersbeheer voor MarktRadar.
//
// Endpoints (allemaal via ?action=…):
//   GET  /api/auth?action=needs-bootstrap          -> { needs: bool }
//   POST /api/auth?action=bootstrap                body: { email, naam, password }  (alleen als geen users)
//   POST /api/auth?action=login                    body: { email, password }       -> { user, token }
//   GET  /api/auth?action=me                                                       -> { user } | 401
//   POST /api/auth?action=logout                                                   -> { ok }
//   POST /api/auth?action=change-password          body: { oldPassword, newPassword }
//   GET  /api/auth?action=list-users               -> { users }                    (auth required)
//   POST /api/auth?action=create-user              body: { email, naam, password? } (auth)
//   POST /api/auth?action=reset-password           body: { email }                 (auth) -> { password }
//   POST /api/auth?action=delete-user              body: { email }                 (auth)
//
// Vereist Vercel KV / Redis. Open registratie is uitgeschakeld; nieuwe accounts
// worden alleen via een ingelogde gebruiker (admin) aangemaakt.

const auth = require('./_lib/auth');
const { randomBytes } = require('crypto');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    naam: u.naam,
    createdAt: u.createdAt,
    mustChangePassword: !!u.mustChangePassword,
  };
}

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

async function getUsersIndex() {
  return (await auth.kvGet(auth.KV_USERS_INDEX)) || [];
}
async function appendUserIndex(email) {
  const list = await getUsersIndex();
  if (!list.includes(email)) {
    list.push(email);
    await auth.kvSet(auth.KV_USERS_INDEX, list);
  }
}
async function removeUserIndex(email) {
  const list = await getUsersIndex();
  await auth.kvSet(auth.KV_USERS_INDEX, list.filter((e) => e !== email));
}

function generateTempPassword(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const buf = randomBytes(len || 12);
  let pw = '';
  for (let i = 0; i < buf.length; i++) pw += chars[buf[i] % chars.length];
  return pw;
}

async function newUserRecord(email, naam, password, opts) {
  const salt = auth.makeSalt();
  const passwordHash = await auth.hashPassword(password, salt);
  return {
    id: auth.makeId('u_'),
    email,
    naam,
    salt,
    passwordHash,
    createdAt: Date.now(),
    createdBy: (opts && opts.createdBy) || null,
    mustChangePassword: !!(opts && opts.mustChangePassword),
  };
}

async function createSession(email, userId) {
  const token = auth.makeToken();
  await auth.kvSet(
    auth.KV_SESSION_PREFIX + token,
    { userId, email, expires: Date.now() + auth.SESSION_TTL_MS },
    { ttlSec: auth.SESSION_TTL_SEC }
  );
  return token;
}

async function needsBootstrap(req, res) {
  const list = await getUsersIndex();
  return res.status(200).json({ needs: list.length === 0 });
}

async function bootstrap(req, res) {
  const list = await getUsersIndex();
  if (list.length > 0) {
    return res.status(403).json({
      error: 'Bootstrap niet meer mogelijk; gebruikers bestaan al. Vraag een collega om je een account aan te maken.',
    });
  }
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const naam = String(body.naam || '').trim();
  const password = String(body.password || '');
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ongeldig email-adres' });
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
  const user = await newUserRecord(email, naam, password, { mustChangePassword: false });
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  await appendUserIndex(email);
  const token = await createSession(email, user.id);
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
  const token = await createSession(email, user.id);
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

async function changePassword(req, res) {
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  const body = await readJsonBody(req);
  const oldPw = String(body.oldPassword || '');
  const newPw = String(body.newPassword || '');
  if (newPw.length < 8) return res.status(400).json({ error: 'Nieuw wachtwoord moet minimaal 8 tekens zijn' });
  const user = await auth.kvGet(auth.KV_USER_PREFIX + session.email);
  if (!user) return res.status(404).json({ error: 'Account niet gevonden' });
  const ok = await auth.verifyPassword(oldPw, user.salt, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Huidig wachtwoord onjuist' });
  user.salt = auth.makeSalt();
  user.passwordHash = await auth.hashPassword(newPw, user.salt);
  user.passwordChangedAt = Date.now();
  user.mustChangePassword = false;
  await auth.kvSet(auth.KV_USER_PREFIX + session.email, user);
  return res.status(200).json({ ok: true, user: publicUser(user) });
}

async function createUser(req, res) {
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const naam = String(body.naam || '').trim();
  let password = String(body.password || '');
  const generated = !password;
  if (generated) password = generateTempPassword(12);
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ongeldig email-adres' });
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
  const existing = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (existing) return res.status(409).json({ error: 'Er bestaat al een account voor dit email-adres' });
  const user = await newUserRecord(email, naam, password, {
    createdBy: session.email,
    mustChangePassword: true,
  });
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  await appendUserIndex(email);
  return res.status(200).json({
    user: publicUser(user),
    password: generated ? password : undefined,
    message: generated
      ? 'Account aangemaakt. Deel dit tijdelijke wachtwoord met de gebruiker; bij eerste login moet het worden gewijzigd.'
      : 'Account aangemaakt; bij eerste login moet het wachtwoord worden gewijzigd.',
  });
}

async function listUsers(req, res) {
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  const emails = await getUsersIndex();
  const users = [];
  for (const e of emails) {
    const u = await auth.kvGet(auth.KV_USER_PREFIX + e);
    if (u) users.push(publicUser(u));
  }
  return res.status(200).json({ users });
}

async function deleteUser(req, res) {
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email verplicht' });
  if (email === session.email) return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
  const count = (await getUsersIndex()).length;
  if (count <= 1) return res.status(400).json({ error: 'Kan niet de laatste gebruiker verwijderen' });
  await auth.kvDel(auth.KV_USER_PREFIX + email);
  await removeUserIndex(email);
  return res.status(200).json({ ok: true });
}

async function resetPassword(req, res) {
  const session = await auth.requireAuth(req, res);
  if (session === false) return;
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Email verplicht' });
  const user = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (!user) return res.status(404).json({ error: 'Account niet gevonden' });
  const newPw = generateTempPassword(12);
  user.salt = auth.makeSalt();
  user.passwordHash = await auth.hashPassword(newPw, user.salt);
  user.mustChangePassword = true;
  user.passwordResetAt = Date.now();
  user.passwordResetBy = session.email;
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  return res.status(200).json({
    ok: true,
    password: newPw,
    message: 'Tijdelijk wachtwoord aangemaakt. Deel dit met de gebruiker; bij eerste login moet het worden gewijzigd.',
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!auth.kvConfigured()) {
    return res.status(503).json({ error: 'Vercel KV niet geconfigureerd', fallback: true });
  }
  const action = (req.query && req.query.action) || '';
  try {
    if (action === 'needs-bootstrap' && (req.method === 'GET' || req.method === 'POST')) return needsBootstrap(req, res);
    if (action === 'bootstrap' && req.method === 'POST') return bootstrap(req, res);
    if (action === 'login' && req.method === 'POST') return login(req, res);
    if (action === 'me' && (req.method === 'GET' || req.method === 'POST')) return me(req, res);
    if (action === 'logout' && req.method === 'POST') return logout(req, res);
    if (action === 'change-password' && req.method === 'POST') return changePassword(req, res);
    if (action === 'list-users' && (req.method === 'GET' || req.method === 'POST')) return listUsers(req, res);
    if (action === 'create-user' && req.method === 'POST') return createUser(req, res);
    if (action === 'delete-user' && req.method === 'POST') return deleteUser(req, res);
    if (action === 'reset-password' && req.method === 'POST') return resetPassword(req, res);
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
