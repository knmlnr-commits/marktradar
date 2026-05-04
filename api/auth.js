// Email + wachtwoord-authenticatie + gebruikersbeheer voor MarktRadar.
//
// Multi-tenant vanaf v1.12: elke email-registratie creëert een eigen tenant.
// Een ingelogde admin kan binnen zijn eigen tenant collega's uitnodigen.
//
// Endpoints (allemaal via ?action=…):
//   GET  /api/auth?action=needs-bootstrap          -> { needs: bool }
//   POST /api/auth?action=bootstrap                body: { email, naam, password, tenantNaam? }  (alleen als geen users)
//   POST /api/auth?action=register                 body: { email, naam, password, tenantNaam? }  (open per email)
//   POST /api/auth?action=login                    body: { email, password }       -> { user, token, tenant }
//   GET  /api/auth?action=me                                                       -> { user, tenant } | 401
//   POST /api/auth?action=logout                                                   -> { ok }
//   POST /api/auth?action=change-password          body: { oldPassword, newPassword }
//   GET  /api/auth?action=list-users               -> { users }                    (auth required, scope=tenant)
//   POST /api/auth?action=create-user              body: { email, naam, password? } (auth, voegt toe aan eigen tenant)
//   POST /api/auth?action=reset-password           body: { email }                 (auth, alleen eigen tenant)
//   POST /api/auth?action=delete-user              body: { email }                 (auth, alleen eigen tenant)
//
// Vereist Vercel KV / Redis.

const auth = require('./_lib/auth');
const { randomBytes } = require('crypto');

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    naam: u.naam,
    tenantId: u.tenantId,
    role: u.role || 'admin',
    createdAt: u.createdAt,
    mustChangePassword: !!u.mustChangePassword,
  };
}

function publicTenant(t) {
  if (!t) return null;
  return {
    id: t.id,
    naam: t.naam || 'MarktRadar',
    slug: t.slug || null,
    createdAt: t.createdAt,
    propositie: t.propositie || null,
    marktNaam: t.marktNaam || null,
    marktBeschrijving: t.marktBeschrijving || null,
    entiteiten: Array.isArray(t.entiteiten) ? t.entiteiten : null,
    klanten: Array.isArray(t.klanten) ? t.klanten : [],
    feeds: Array.isArray(t.feeds) ? t.feeds : [],
    useLlmCurator: !!t.useLlmCurator,
    logoDataUri: t.logoDataUri || null,
    onboardingDone: !!t.onboardingDone,
    market: Array.isArray(t.market) ? t.market : null,
    marketDefined: !!t.marketDefined,
  };
}

async function ensureUniqueSlug(base, ownTenantId) {
  const cleaned = auth.slugifyName(base);
  if (!cleaned) return null;
  let candidate = cleaned;
  for (let i = 0; i < 50; i++) {
    const existing = await auth.kvGet(auth.tenantSlugKey(candidate));
    if (!existing || existing === ownTenantId) return candidate;
    candidate = cleaned + '-' + (i + 2);
  }
  return cleaned + '-' + Math.random().toString(36).slice(2, 6);
}

async function setTenantSlug(tenant, newSlug) {
  if (tenant.slug && tenant.slug !== newSlug) {
    await auth.kvDel(auth.tenantSlugKey(tenant.slug)).catch(() => {});
  }
  tenant.slug = newSlug;
  await auth.kvSet(auth.tenantSlugKey(newSlug), tenant.id);
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

async function getGlobalUsersIndex() {
  return (await auth.kvGet(auth.KV_USERS_INDEX)) || [];
}
async function appendGlobalUserIndex(email) {
  const list = await getGlobalUsersIndex();
  if (!list.includes(email)) {
    list.push(email);
    await auth.kvSet(auth.KV_USERS_INDEX, list);
  }
}
async function removeGlobalUserIndex(email) {
  const list = await getGlobalUsersIndex();
  await auth.kvSet(auth.KV_USERS_INDEX, list.filter((e) => e !== email));
}

async function getTenantUsersIndex(tenantId) {
  return (await auth.kvGet(auth.tenantUsersIndexKey(tenantId))) || [];
}
async function appendTenantUserIndex(tenantId, email) {
  const list = await getTenantUsersIndex(tenantId);
  if (!list.includes(email)) {
    list.push(email);
    await auth.kvSet(auth.tenantUsersIndexKey(tenantId), list);
  }
}
async function removeTenantUserIndex(tenantId, email) {
  const list = await getTenantUsersIndex(tenantId);
  await auth.kvSet(auth.tenantUsersIndexKey(tenantId), list.filter((e) => e !== email));
}

async function getTenantsIndex() {
  return (await auth.kvGet(auth.KV_TENANTS_INDEX)) || [];
}
async function appendTenantIndex(tenantId) {
  const list = await getTenantsIndex();
  if (!list.includes(tenantId)) {
    list.push(tenantId);
    await auth.kvSet(auth.KV_TENANTS_INDEX, list);
  }
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
    tenantId: (opts && opts.tenantId) || null,
    role: (opts && opts.role) || 'admin',
    salt,
    passwordHash,
    createdAt: Date.now(),
    createdBy: (opts && opts.createdBy) || null,
    mustChangePassword: !!(opts && opts.mustChangePassword),
  };
}

async function createSession(email, userId, tenantId) {
  const token = auth.makeToken();
  await auth.kvSet(
    auth.KV_SESSION_PREFIX + token,
    { userId, email, tenantId, expires: Date.now() + auth.SESSION_TTL_MS },
    { ttlSec: auth.SESSION_TTL_SEC }
  );
  return token;
}

async function loadTenant(tenantId) {
  if (!tenantId) return null;
  let t = await auth.kvGet(auth.tenantMetaKey(tenantId));
  if (t) {
    // Migratie: tenants zonder slug krijgen on-the-fly een slug
    if (!t.slug) {
      const slugBase = t.naam || tenantId;
      const newSlug = await ensureUniqueSlug(slugBase, tenantId);
      if (newSlug) {
        await setTenantSlug(t, newSlug);
        await auth.kvSet(auth.tenantMetaKey(tenantId), t);
      }
    }
    // GeriCall canonical backfill (propositie / marktNaam / marktBeschrijving
    // / feeds) zodat oude KV-records ook automatisch op nieuwe schema komen.
    t = await auth.backfillGericallTenant(t);
    return t;
  }
  // Migratie: legacy-tenant zonder meta-record → on-the-fly aanmaken met
  // gereserveerde slug 'gericall'.
  if (tenantId === auth.LEGACY_TENANT_ID) {
    const legacy = {
      id: auth.LEGACY_TENANT_ID,
      naam: 'GeriCall',
      slug: auth.LEGACY_TENANT_SLUG,
      createdAt: Date.now(),
      market: null,
      marketDefined: false,
      legacy: true,
    };
    await auth.kvSet(auth.tenantMetaKey(tenantId), legacy);
    await auth.kvSet(auth.tenantSlugKey(auth.LEGACY_TENANT_SLUG), auth.LEGACY_TENANT_ID);
    await appendTenantIndex(tenantId);
    return await auth.backfillGericallTenant(legacy);
  }
  return null;
}

async function ensureUserHasTenant(user) {
  // Migratie: pre-multi-tenant users zonder tenantId krijgen LEGACY_TENANT_ID
  if (user && !user.tenantId) {
    user.tenantId = auth.LEGACY_TENANT_ID;
    user.role = user.role || 'admin';
    await auth.kvSet(auth.KV_USER_PREFIX + user.email, user);
    await appendTenantUserIndex(auth.LEGACY_TENANT_ID, user.email);
  }
  return user;
}

async function createTenant(tenantId, naam, founderEmail, requestedSlug) {
  const tenant = {
    id: tenantId,
    naam: naam || 'MarktRadar',
    slug: null,
    createdAt: Date.now(),
    createdBy: founderEmail,
    market: null,            // null = volledige baseline; array = subset instelling-IDs
    marketDefined: false,
  };
  // Slug bepalen: gevraagde slug → tenantNaam → email-prefix
  const baseSlug = (requestedSlug && auth.slugifyName(requestedSlug))
    || auth.slugifyName(naam)
    || auth.slugifyName((founderEmail || '').split('@')[0])
    || 'workspace';
  const slug = await ensureUniqueSlug(baseSlug, tenantId);
  if (slug) {
    tenant.slug = slug;
    await auth.kvSet(auth.tenantSlugKey(slug), tenantId);
  }
  await auth.kvSet(auth.tenantMetaKey(tenantId), tenant);
  await appendTenantIndex(tenantId);
  return tenant;
}

// Gemeenschappelijke flow voor bootstrap + register: maak tenant + admin-user.
async function registerNewTenant(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const naam = String(body.naam || '').trim();
  const password = String(body.password || '');
  const tenantNaam = String(body.tenantNaam || '').trim() || naam || 'Mijn werkomgeving';
  const requestedSlug = String(body.slug || body.tenantSlug || '').trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Ongeldig email-adres' });
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });

  const existing = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (existing) return res.status(409).json({ error: 'Er bestaat al een account voor dit email-adres. Log in of gebruik een ander adres.' });

  const tenantId = auth.slugifyEmailForTenant(email);
  // Voorkom collision: als de tenant al bestaat (extreem onwaarschijnlijk),
  // hang er een random suffix aan.
  let finalTenantId = tenantId;
  const tenantsList = await getTenantsIndex();
  if (tenantsList.includes(tenantId)) {
    finalTenantId = tenantId + '_' + auth.makeId('').slice(0, 6);
  }
  const tenant = await createTenant(finalTenantId, tenantNaam, email, requestedSlug);
  const user = await newUserRecord(email, naam, password, {
    tenantId: finalTenantId,
    role: 'admin',
    mustChangePassword: false,
  });
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  await appendGlobalUserIndex(email);
  await appendTenantUserIndex(finalTenantId, email);
  const token = await createSession(email, user.id, finalTenantId);
  return res.status(200).json({ user: publicUser(user), tenant: publicTenant(tenant), token });
}

async function needsBootstrap(req, res) {
  // 'needs-bootstrap' blijft true totdat er minstens één tenant + user bestaat.
  // Daarna toont de gate 'login + registreer' modus, waarbij registreer
  // een nieuwe tenant per email aanmaakt.
  const list = await getGlobalUsersIndex();
  return res.status(200).json({ needs: list.length === 0 });
}

async function bootstrap(req, res) {
  const list = await getGlobalUsersIndex();
  if (list.length > 0) {
    return res.status(403).json({
      error: 'Bootstrap niet meer mogelijk; gebruikers bestaan al. Gebruik /api/auth?action=register voor een nieuwe tenant.',
    });
  }
  return registerNewTenant(req, res);
}

async function register(req, res) {
  // Open registratie: elk nieuw email-adres krijgt een eigen tenant.
  return registerNewTenant(req, res);
}

async function login(req, res) {
  const body = await readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email en wachtwoord verplicht' });
  let user = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (!user) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  const ok = await auth.verifyPassword(password, user.salt, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
  user = await ensureUserHasTenant(user);
  const tenant = await loadTenant(user.tenantId);
  const token = await createSession(email, user.id, user.tenantId);
  return res.status(200).json({ user: publicUser(user), tenant: publicTenant(tenant), token });
}

async function me(req, res) {
  const session = await auth.getSession(req);
  if (!session) return res.status(401).json({ error: 'Niet ingelogd' });
  let user = await auth.kvGet(auth.KV_USER_PREFIX + session.email);
  if (!user) return res.status(401).json({ error: 'Account niet gevonden' });
  user = await ensureUserHasTenant(user);
  const tenant = await loadTenant(user.tenantId);
  return res.status(200).json({ user: publicUser(user), tenant: publicTenant(tenant) });
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
    tenantId: session.tenantId,
    role: 'member',
    createdBy: session.email,
    mustChangePassword: true,
  });
  await auth.kvSet(auth.KV_USER_PREFIX + email, user);
  await appendGlobalUserIndex(email);
  await appendTenantUserIndex(session.tenantId, email);
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
  const emails = await getTenantUsersIndex(session.tenantId);
  // Migratie: als de tenant-index nog leeg is maar deze user wel in de
  // legacy-tenant zit, bouw de tenant-index op uit de globale index.
  if (emails.length === 0 && session.tenantId === auth.LEGACY_TENANT_ID) {
    const all = await getGlobalUsersIndex();
    for (const e of all) {
      let u = await auth.kvGet(auth.KV_USER_PREFIX + e);
      if (!u) continue;
      u = await ensureUserHasTenant(u);
      if (u.tenantId === auth.LEGACY_TENANT_ID) emails.push(e);
    }
  }
  const users = [];
  for (const e of emails) {
    const u = await auth.kvGet(auth.KV_USER_PREFIX + e);
    if (u && u.tenantId === session.tenantId) users.push(publicUser(u));
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
  const target = await auth.kvGet(auth.KV_USER_PREFIX + email);
  if (!target) return res.status(404).json({ error: 'Account niet gevonden' });
  if (target.tenantId !== session.tenantId) {
    return res.status(403).json({ error: 'Account hoort niet bij jouw tenant' });
  }
  const count = (await getTenantUsersIndex(session.tenantId)).length;
  if (count <= 1) return res.status(400).json({ error: 'Kan niet de laatste gebruiker van je tenant verwijderen' });
  await auth.kvDel(auth.KV_USER_PREFIX + email);
  await removeGlobalUserIndex(email);
  await removeTenantUserIndex(session.tenantId, email);
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
  if (user.tenantId !== session.tenantId) {
    return res.status(403).json({ error: 'Account hoort niet bij jouw tenant' });
  }
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

// ---------------- Google OAuth (sign-in side-door) ----------------
// Volledige redirect-flow (geen popup-flow), zodat we geen client-id
// in de browser-bundle hoeven te tonen voor de PKCE-variant. State-
// CSRF-bescherming via een HTTP-only cookie die we tijdens de start-
// stap zetten en op de callback verifiëren.
//
// Endpoints:
//   GET  /api/auth?action=oauth-google-start     → 302 → Google consent
//   GET  /api/auth?action=oauth-google-callback  → 302 → /?token=…
//
// Vereiste env-vars in Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//
// Authorized redirect URI in Google Cloud Console moet exact zijn:
//   https://<jouw-vercel-domain>/api/auth?action=oauth-google-callback
//
// Bij eerste login matched op email; geen account → nieuwe tenant
// (zelfde flow als register). Bestaand account → koppelt en logt in.
const OAUTH_STATE_COOKIE = 'mr_oauth_state';
const OAUTH_REDIRECT_DEFAULT = '/';

function buildOAuthRedirectUri(req) {
  // Vercel zet x-forwarded-host / x-forwarded-proto bij elke request.
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth?action=oauth-google-callback`;
}

function setStateCookie(res, value) {
  // HTTP-only, Secure, SameSite=Lax (voldoende voor de redirect-roundtrip
  // via Google). Max-Age 10 minuten — meer dan genoeg voor de flow.
  res.setHeader('Set-Cookie', [
    `${OAUTH_STATE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);
}
function clearStateCookie(res) {
  res.setHeader('Set-Cookie', [
    `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}
function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

async function oauthGoogleStart(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(503).send('Google OAuth niet geconfigureerd: zet GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in Vercel env-vars.');
  }
  const state = randomBytes(24).toString('hex');
  setStateCookie(res, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: buildOAuthRedirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.statusCode = 302;
  res.setHeader('Location', 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  return res.end();
}

async function googleExchangeCode(code, redirectUri) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!r.ok) throw new Error('Google token-exchange mislukt: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
async function googleFetchUserInfo(accessToken) {
  const r = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) throw new Error('Google userinfo mislukt: ' + r.status);
  return r.json();
}

function redirectToGate(res, params) {
  // Token + foutmelding via URL-fragment (#…) i.p.v. query-param zodat
  // deze niet in server-logs of de Referer-header terecht komt.
  const frag = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader('Location', OAUTH_REDIRECT_DEFAULT + '#' + frag);
  return res.end();
}

async function oauthGoogleCallback(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).send('Google OAuth niet geconfigureerd');
  }
  const q = req.query || {};
  const code = String(q.code || '');
  const state = String(q.state || '');
  const cookieState = getCookie(req, OAUTH_STATE_COOKIE);
  clearStateCookie(res);
  if (q.error) return redirectToGate(res, { oauthError: String(q.error) });
  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectToGate(res, { oauthError: 'state-mismatch' });
  }
  try {
    const redirectUri = buildOAuthRedirectUri(req);
    const tok = await googleExchangeCode(code, redirectUri);
    const info = await googleFetchUserInfo(tok.access_token);
    const email = String(info.email || '').toLowerCase().trim();
    if (!email) return redirectToGate(res, { oauthError: 'no-email' });
    if (info.verified_email === false) return redirectToGate(res, { oauthError: 'email-unverified' });
    const naam = String(info.name || email.split('@')[0]).trim();

    // Bestaand account? Direct sessie aanmaken.
    let user = await auth.kvGet(auth.KV_USER_PREFIX + email);
    let tenantId;
    if (user) {
      // Markeer Google-koppeling op de user-record (idempotent).
      if (!user.googleId && info.id) {
        user.googleId = info.id;
        await auth.kvSet(auth.KV_USER_PREFIX + email, user);
      }
      tenantId = user.tenantId;
    } else {
      // Nieuw account → eigen tenant aanmaken (zelfde pad als register).
      // Wachtwoord wordt random gegenereerd; user kan later via 'Wachtwoord
      // wijzigen' een eigen wachtwoord instellen om óók via password te
      // kunnen inloggen.
      const baseTenantId = auth.slugifyEmailForTenant(email);
      const tenantsList = await getTenantsIndex();
      tenantId = tenantsList.includes(baseTenantId) ? (baseTenantId + '_' + auth.makeId('').slice(0, 6)) : baseTenantId;
      const tenantNaam = naam || (email.split('@')[0]) || 'Mijn werkomgeving';
      await createTenant(tenantId, tenantNaam, email, '');
      const tempPw = generateTempPassword(20);
      user = await newUserRecord(email, naam, tempPw, {
        tenantId,
        role: 'admin',
        mustChangePassword: false,
      });
      user.googleId = info.id || null;
      await auth.kvSet(auth.KV_USER_PREFIX + email, user);
      await appendGlobalUserIndex(email);
      await appendTenantUserIndex(tenantId, email);
    }
    const token = await createSession(email, user.id, tenantId);
    return redirectToGate(res, { token, email });
  } catch (e) {
    return redirectToGate(res, { oauthError: String(e.message || e).slice(0, 200) });
  }
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
    if (action === 'register' && req.method === 'POST') return register(req, res);
    if (action === 'login' && req.method === 'POST') return login(req, res);
    if (action === 'me' && (req.method === 'GET' || req.method === 'POST')) return me(req, res);
    if (action === 'logout' && req.method === 'POST') return logout(req, res);
    if (action === 'change-password' && req.method === 'POST') return changePassword(req, res);
    if (action === 'list-users' && (req.method === 'GET' || req.method === 'POST')) return listUsers(req, res);
    if (action === 'create-user' && req.method === 'POST') return createUser(req, res);
    if (action === 'delete-user' && req.method === 'POST') return deleteUser(req, res);
    if (action === 'reset-password' && req.method === 'POST') return resetPassword(req, res);
    if (action === 'oauth-google-start' && req.method === 'GET') return oauthGoogleStart(req, res);
    if (action === 'oauth-google-callback' && req.method === 'GET') return oauthGoogleCallback(req, res);
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
