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
    loginCount: u.loginCount || 0,
    lastLogin: u.lastLogin || null,
    lastLoginMethod: u.lastLoginMethod || null,
  };
}

// Eenmalige login-stats-update; idempotent en best-effort. Faalt deze
// schrijfactie dan blokkeert dat de login niet — auth blijft werken
// ook al kunnen we de stats niet bijhouden.
async function recordLogin(user, method) {
  try {
    user.loginCount = (user.loginCount || 0) + 1;
    user.lastLogin = Date.now();
    user.lastLoginMethod = method || 'password';
    await auth.kvSet(auth.KV_USER_PREFIX + user.email, user);
  } catch (e) { /* swallow */ }
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
    klantSchema: Array.isArray(t.klantSchema) ? t.klantSchema : [],
    theme: t.theme && typeof t.theme === 'object' ? t.theme : null,
  };
}

async function ensureUniqueSlug(base, ownTenantId) {
  const cleaned = auth.slugifyName(base);
  if (!cleaned) return null;
  // Reserveer de 'gericall'-slug-family voor de legacy seed-tenant.
  // Nieuwe tenants die via een naam-clash op 'gericall' uit zouden komen
  // moeten geen 'gericall-2/3/...' krijgen — anders verschijnt er
  // GeriCall-jargon in een totaal andere werkomgeving (bv. Van Ameyde).
  // De caller valt terug op een andere slug-base als wij null teruggeven.
  if (ownTenantId !== auth.LEGACY_TENANT_ID && /^gericall(-|$)/.test(cleaned)) {
    return null;
  }
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

// Free-mail-providers waarvoor de email-domain géén goede tenant-naam
// is (bv. gmail.com, hotmail.com). Voor deze accounts vallen we terug
// op de displayName van de user of de email-prefix.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com',
  'live.com', 'yahoo.com', 'icloud.com', 'me.com',
  'protonmail.com', 'proton.me', 'aol.com', 'mac.com',
]);

// Leid een natuurlijke tenant-naam + slug-base af voor B2B-SSO. Bij een
// custom email-domain (vanameyde.nl, anthropic.com, etc.) is dat domein
// veruit de logischste werkomgeving-naam — beter dan de Google/Microsoft
// displayName, die vaak persoonlijk is ('Jan de Vries', 'GeriCall', …).
function deriveTenantInfoFromEmail(email, fallbackName) {
  const e = String(email || '').toLowerCase().trim();
  const domain = e.split('@')[1] || '';
  if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
    const base = domain.split('.')[0]; // 'vanameyde.nl' → 'vanameyde'
    const naam = base.charAt(0).toUpperCase() + base.slice(1);
    return { naam, slugBase: base };
  }
  const name = String(fallbackName || '').trim();
  if (name) {
    return { naam: name, slugBase: auth.slugifyName(name) };
  }
  const prefix = e.split('@')[0] || 'workspace';
  return { naam: prefix, slugBase: prefix };
}

async function createTenant(tenantId, naam, founderEmail, requestedSlug) {
  // Slug-keuze: probeer in volgorde gevraagde-slug → tenantNaam → email-
  // domain (voor B2B-SSO de natuurlijkste fallback) → email-prefix →
  // 'workspace'. Een kandidaat kan ook null teruggeven (bv. omdat 'ie
  // op de gereserveerde gericall-family valt); we lopen dan door naar
  // de volgende kandidaat. Tenant.naam vervangen we óók als de gegeven
  // naam tot 'gericall' zou slugifien — dat voorkomt 'GeriCall' in een
  // Van-Ameyde-werkomgeving die per ongeluk dezelfde displayName had.
  const derived = deriveTenantInfoFromEmail(founderEmail, naam);
  const requestedSlugged = requestedSlug && auth.slugifyName(requestedSlug);
  const naamSlugged = auth.slugifyName(naam);
  const candidates = [
    requestedSlugged,
    naamSlugged,
    derived.slugBase,
    auth.slugifyName((founderEmail || '').split('@')[0]),
    'workspace',
  ].filter(Boolean);

  let slug = null;
  for (const c of candidates) {
    slug = await ensureUniqueSlug(c, tenantId);
    if (slug) break;
  }

  // Als de display-naam slugified naar gericall (of variant), gebruik
  // dan ook de van-domein afgeleide naam — anders blijft 'GeriCall' in
  // de werkomgeving-titel staan ondanks dat 'ie op een andere slug
  // belandt.
  let finalNaam = naam || 'MarktRadar';
  if (naamSlugged && /^gericall(-|$)/.test(naamSlugged) && tenantId !== auth.LEGACY_TENANT_ID) {
    finalNaam = derived.naam || 'MarktRadar';
  }

  const tenant = {
    id: tenantId,
    naam: finalNaam,
    slug: null,
    createdAt: Date.now(),
    createdBy: founderEmail,
    market: null,            // null = volledige baseline; array = subset instelling-IDs
    marketDefined: false,
  };
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
  await recordLogin(user, 'register');
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
  await recordLogin(user, 'password');
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

// ---------------- OAuth (sign-in side-door, generic) ----------------
// Authorization-code-flow met state-CSRF-bescherming via een HTTP-only
// cookie. De flow is identiek voor Google en Microsoft Entra; alleen
// de endpoints, scopes en user-info-mapping verschillen. Vandaar de
// PROVIDERS-config en gedeelde oauthStart/oauthCallback-helpers.
//
// Endpoints:
//   GET  /api/auth?action=oauth-google-start        → 302 → Google consent
//   GET  /api/auth?action=oauth-google-callback     → 302 → /#token=…
//   GET  /api/auth?action=oauth-microsoft-start     → 302 → Microsoft consent
//   GET  /api/auth?action=oauth-microsoft-callback  → 302 → /#token=…
//
// Vereiste env-vars:
//   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
//   MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET (+ optioneel
//     MICROSOFT_TENANT, default 'organizations' = alle work-accounts;
//     'common' = + persoonlijke accounts; tenant-id voor één org).
//
// Authorized redirect URI in Google Cloud Console / Microsoft Azure
// Portal moet exact zijn:
//   https://<vercel-domain>/api/auth?action=oauth-<provider>-callback
//
// Bij eerste login wordt op email gematched: bestaand account →
// koppelt provider-id en logt in; geen account → nieuwe tenant
// (zelfde pad als register).

const PROVIDERS = {
  google: {
    label: 'Google',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile',
    extraAuthParams: { access_type: 'online', prompt: 'select_account' },
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extractUser(info) {
      return {
        email: String(info.email || '').toLowerCase().trim(),
        naam: String(info.name || '').trim(),
        providerId: info.id || null,
        emailVerified: info.verified_email !== false,
        userField: 'googleId',
      };
    },
  },
  microsoft: {
    label: 'Microsoft',
    // Microsoft is per-tenant gerouteerd; de placeholder {tenant} wordt
    // bij gebruik vervangen. 'organizations' (default) accepteert alle
    // werk-accounts maar weert persoonlijke Hotmail/Outlook-accounts.
    authUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scope: 'openid email profile User.Read',
    extraAuthParams: { prompt: 'select_account' },
    clientIdEnv: 'MICROSOFT_CLIENT_ID',
    clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
    tenantEnv: 'MICROSOFT_TENANT',
    tenantDefault: 'organizations',
    extractUser(info) {
      // Microsoft Graph /me velden: id, displayName, mail (kan null zijn
      // bij guest-accounts), userPrincipalName (altijd aanwezig).
      return {
        email: String(info.mail || info.userPrincipalName || '').toLowerCase().trim(),
        naam: String(info.displayName || '').trim(),
        providerId: info.id || null,
        emailVerified: true,
        userField: 'microsoftId',
      };
    },
  },
};

const OAUTH_STATE_COOKIE = 'mr_oauth_state';
const OAUTH_REDIRECT_DEFAULT = '/';

function resolveProviderUrl(template, provider) {
  if (!template.includes('{tenant}')) return template;
  const tenant = (provider.tenantEnv && process.env[provider.tenantEnv]) || provider.tenantDefault || 'common';
  return template.replace('{tenant}', encodeURIComponent(tenant));
}

function buildOAuthRedirectUri(req, providerKey) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}/api/auth?action=oauth-${providerKey}-callback`;
}

function setStateCookie(res, value) {
  // HTTP-only, Secure, SameSite=Lax (voldoende voor de redirect-roundtrip
  // via de IdP). Max-Age 10 minuten — meer dan genoeg voor de flow.
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

async function exchangeCodeForToken(provider, code, redirectUri) {
  const r = await fetch(resolveProviderUrl(provider.tokenUrl, provider), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env[provider.clientIdEnv],
      client_secret: process.env[provider.clientSecretEnv],
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!r.ok) throw new Error(provider.label + ' token-exchange mislukt: ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}
async function fetchUserInfo(provider, accessToken) {
  const r = await fetch(provider.userInfoUrl, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) throw new Error(provider.label + ' userinfo mislukt: ' + r.status);
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

async function oauthStart(providerKey, req, res) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return res.status(404).send('Unknown OAuth provider');
  const clientId = process.env[provider.clientIdEnv];
  if (!clientId) {
    return res.status(503).send(provider.label + ' OAuth niet geconfigureerd: zet ' + provider.clientIdEnv + ' + ' + provider.clientSecretEnv + ' in Vercel env-vars.');
  }
  const state = randomBytes(24).toString('hex');
  setStateCookie(res, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: buildOAuthRedirectUri(req, providerKey),
    response_type: 'code',
    scope: provider.scope,
    state,
    ...(provider.extraAuthParams || {}),
  });
  res.statusCode = 302;
  res.setHeader('Location', resolveProviderUrl(provider.authUrl, provider) + '?' + params.toString());
  return res.end();
}

async function oauthCallback(providerKey, req, res) {
  const provider = PROVIDERS[providerKey];
  if (!provider) return res.status(404).send('Unknown OAuth provider');
  const clientId = process.env[provider.clientIdEnv];
  const clientSecret = process.env[provider.clientSecretEnv];
  if (!clientId || !clientSecret) {
    return res.status(503).send(provider.label + ' OAuth niet geconfigureerd');
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
    const redirectUri = buildOAuthRedirectUri(req, providerKey);
    const tok = await exchangeCodeForToken(provider, code, redirectUri);
    const info = await fetchUserInfo(provider, tok.access_token);
    const u = provider.extractUser(info);
    if (!u.email) return redirectToGate(res, { oauthError: 'no-email' });
    if (!u.emailVerified) return redirectToGate(res, { oauthError: 'email-unverified' });
    const naam = u.naam || u.email.split('@')[0];

    // Bestaand account? Direct sessie aanmaken.
    let user = await auth.kvGet(auth.KV_USER_PREFIX + u.email);
    let tenantId;
    if (user) {
      // Provider-id idempotent koppelen (bv. user logde eerst in via
      // password en nu via Google; we slaan de google-id op zodat we
      // 'm later kunnen herkennen).
      if (!user[u.userField] && u.providerId) {
        user[u.userField] = u.providerId;
        await auth.kvSet(auth.KV_USER_PREFIX + u.email, user);
      }
      tenantId = user.tenantId;
    } else {
      // Nieuw account → eigen tenant (zelfde pad als register). Random
      // temp-wachtwoord zodat user later óók via password kan inloggen
      // na 'Wachtwoord wijzigen'.
      const baseTenantId = auth.slugifyEmailForTenant(u.email);
      const tenantsList = await getTenantsIndex();
      tenantId = tenantsList.includes(baseTenantId) ? (baseTenantId + '_' + auth.makeId('').slice(0, 6)) : baseTenantId;
      // Tenant-naam afgeleid van het email-domein (B2B): 'jan@vanameyde.nl'
      // wordt 'Vanameyde'. Voor free-mail-accounts (gmail, hotmail) valt
      // 'ie terug op de Google/MS displayName of de email-prefix. Anders
      // zou een collega van GeriCall die een Van-Ameyde-account aanmaakt
      // de werkomgeving 'GeriCall' krijgen omdat dat z'n displayName is.
      const derived = deriveTenantInfoFromEmail(u.email, naam);
      const tenantNaam = derived.naam || naam || u.email.split('@')[0] || 'Mijn werkomgeving';
      await createTenant(tenantId, tenantNaam, u.email, '');
      const tempPw = generateTempPassword(20);
      user = await newUserRecord(u.email, naam, tempPw, {
        tenantId,
        role: 'admin',
        mustChangePassword: false,
      });
      user[u.userField] = u.providerId || null;
      await auth.kvSet(auth.KV_USER_PREFIX + u.email, user);
      await appendGlobalUserIndex(u.email);
      await appendTenantUserIndex(tenantId, u.email);
    }
    const token = await createSession(u.email, user.id, tenantId);
    await recordLogin(user, providerKey === 'google' ? 'google' : providerKey === 'microsoft' ? 'microsoft' : 'oauth');
    return redirectToGate(res, { token, email: u.email });
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
    if (req.method === 'GET' && /^oauth-([a-z]+)-start$/.test(action)) {
      return oauthStart(action.match(/^oauth-([a-z]+)-start$/)[1], req, res);
    }
    if (req.method === 'GET' && /^oauth-([a-z]+)-callback$/.test(action)) {
      return oauthCallback(action.match(/^oauth-([a-z]+)-callback$/)[1], req, res);
    }
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
