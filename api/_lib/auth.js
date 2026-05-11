// Gedeelde helpers voor api/auth.js, api/state.js, api/assignments.js, api/tenant.js.
//
// Backend wordt automatisch gekozen:
//   - REDIS_URL (TCP via 'redis' npm) - Vercel "Redis" marketplace, Redis Cloud
//   - KV_REST_API_URL + KV_REST_API_TOKEN (HTTPS REST) - Vercel KV / Upstash
// Eerstgenoemde voorkeur als beide aanwezig zijn (lagere latency na warme start).
//
// Vanaf v1.12 is de omgeving multi-tenant: elke email krijgt bij registratie
// een eigen tenant. State, assignments en gebruikers zijn per-tenant gescoped.
// Tenants kunnen hun eigen markt-scope (subset van instellingen) definieren.

const { scrypt: scryptCb, randomBytes, timingSafeEqual, createHash } = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(scryptCb);

const KV_USER_PREFIX = 'marktradar:user:';
const KV_SESSION_PREFIX = 'marktradar:session:';
const KV_USERS_INDEX = 'marktradar:users:index';
const KV_TENANTS_INDEX = 'marktradar:tenants:index';
const KV_TENANT_SLUG_PREFIX = 'marktradar:tenant-slug:';
const KV_AUDIT_LOG = 'marktradar:audit-log';
const AUDIT_LOG_MAX = 500;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

// Default-tenant voor pre-multi-tenant data. Bestaande state/assignments/users
// zonder tenantId worden hieronder ingelezen tijdens migratie.
const LEGACY_TENANT_ID = 'gericall';
const LEGACY_TENANT_SLUG = 'gericall';

function tenantMetaKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':meta'; }
function tenantUsersIndexKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':users:index'; }
function tenantStateKey(tenantId, name) { return 'marktradar:tenant:' + tenantId + ':state:v1:' + name; }
function tenantAssignmentsKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':assignments:v1'; }
function tenantSlugKey(slug) { return KV_TENANT_SLUG_PREFIX + slug; }

function slugifyEmailForTenant(email) {
  const e = String(email || '').toLowerCase().trim();
  // 8-byte hash (16 hex tekens) is uniek genoeg voor onze schaal en geeft
  // korte, voorspelbare keys zonder de email zelf in de key te hebben.
  const hash = createHash('sha256').update(e).digest('hex').slice(0, 16);
  return 't_' + hash;
}

// Vanity-slug uit een vrije naam afleiden: lowercase, alleen [a-z0-9-],
// max 40 tekens. Wordt gebruikt voor de URL /app/<slug>.
function slugifyName(naam) {
  const s = String(naam || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || '';
}

function hasRedisUrl() { return !!process.env.REDIS_URL; }
function hasRestKv() { return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN); }
function kvConfigured() { return hasRedisUrl() || hasRestKv(); }

let _redisClient = null;
let _redisLib = null;
function getRedisLib() {
  if (_redisLib !== null) return _redisLib;
  try { _redisLib = require('redis'); }
  catch (e) { _redisLib = false; }
  return _redisLib;
}
async function getRedisClient() {
  if (!hasRedisUrl()) return null;
  const lib = getRedisLib();
  if (!lib) return null;
  if (_redisClient && _redisClient.isReady) return _redisClient;
  if (!_redisClient) {
    _redisClient = lib.createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 5000 },
    });
    _redisClient.on('error', () => {});
  }
  if (!_redisClient.isOpen) {
    try { await _redisClient.connect(); }
    catch (e) { _redisClient = null; return null; }
  }
  return _redisClient.isReady ? _redisClient : null;
}

async function kvFetchRest(path, init) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`KV REST ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function kvGet(key) {
  if (hasRedisUrl()) {
    const c = await getRedisClient();
    if (c) {
      const v = await c.get(key);
      if (v === null || v === undefined) return null;
      try { return JSON.parse(v); }
      catch (e) { return v; }
    }
  }
  if (hasRestKv()) {
    const data = await kvFetchRest('/get/' + encodeURIComponent(key));
    if (!data || data.result === null || data.result === undefined) return null;
    try { return JSON.parse(data.result); }
    catch (e) { return data.result; }
  }
  const e = new Error('No KV configured');
  e.code = 'NO_KV';
  throw e;
}

async function kvSet(key, value, opts) {
  const json = JSON.stringify(value);
  const ttlSec = opts && opts.ttlSec;
  if (hasRedisUrl()) {
    const c = await getRedisClient();
    if (c) {
      if (ttlSec) await c.set(key, json, { EX: ttlSec });
      else await c.set(key, json);
      return;
    }
  }
  if (hasRestKv()) {
    const restPath = ttlSec
      ? `/set/${encodeURIComponent(key)}?EX=${ttlSec}`
      : `/set/${encodeURIComponent(key)}`;
    await kvFetchRest(restPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    return;
  }
  const e = new Error('No KV configured');
  e.code = 'NO_KV';
  throw e;
}

async function kvDel(key) {
  if (hasRedisUrl()) {
    const c = await getRedisClient();
    if (c) { await c.del(key); return; }
  }
  if (hasRestKv()) {
    await kvFetchRest('/del/' + encodeURIComponent(key), { method: 'POST' });
    return;
  }
}

function makeId(prefix) { return (prefix || '') + randomBytes(8).toString('hex'); }
function makeToken() { return randomBytes(32).toString('hex'); }
function makeSalt() { return randomBytes(16).toString('hex'); }

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
    // Migratie: oude sessies zonder tenantId krijgen LEGACY_TENANT_ID
    if (!session.tenantId) session.tenantId = LEGACY_TENANT_ID;
    return { ...session, token };
  } catch (e) {
    if (e.code === 'NO_KV') return null;
    throw e;
  }
}
async function requireAuth(req, res) {
  if (!kvConfigured()) return null;
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return false;
  }
  return session;
}

// Canonical backfill voor de GeriCall seed-tenant. Hier centraal zodat
// zowel api/auth.js (login + me) als api/tenant.js (info-endpoint)
// dezelfde upgrade-paden volgen voor bestaande KV-records.
const GERICALL_BACKFILL = {
  naam: 'GeriCall',
  propositie: 'GeriCall biedt VVT-organisaties 24/7 ANW-bereikbaarheid van specialisten ouderengeneeskunde, zodat hun eigen artsen geen avond-, nacht- en weekenddiensten hoeven te draaien.',
  marktNaam: 'VVT — verpleeg-, verzorgings- en thuiszorg Nederland',
  marktBeschrijving: 'Nederlandse VVT-instellingen met intramurale capaciteit (verpleeghuiszorg, GRZ, ELV) waar specialisten ouderengeneeskunde nodig zijn voor avond-, nacht- en weekendzorg. Focus op organisaties met 200+ cliënten waar eigen SO-capaciteit ontoereikend is voor 24/7 dekking; secundair de thuiszorg- en VPT-segmenten waar ANW-bereikbaarheid via samenwerkingsverbanden loopt (ThoeZ, AWIZ, NOB Green Deal).',
  feeds: [
    { url: 'https://www.skipr.nl/feed/', label: 'Skipr', type: 'rss' },
    { url: 'https://www.zorgvisie.nl/feed/', label: 'Zorgvisie', type: 'rss' },
    { url: 'https://www.icthealth.nl/feed/', label: 'ICTHealth', type: 'rss' },
    { url: 'https://www.nationalezorggids.nl/rss-nieuws.xml', label: 'NationaleZorggids', type: 'rss' },
  ],
};
const GERICALL_OLD_PROPOSITIES = ['GeriCall · ANW-zorg & VVT-marktintelligentie voor zorgleveranciers'];
const GERICALL_OLD_MARKTNAAMEN = ['VVT (verpleeg-, verzorgings- en thuiszorg)'];

// Lazy-load van de 64 VVT-instellingen die als seed in tenant.entiteiten
// worden gepopuleerd. Voorheen bestonden ze alleen in DATA.instellingen
// (frontend); door ze ook backend-zijde aan tenant.entiteiten te koppelen
// kan de signal-cron artikel-titels matchen op deze namen.
let _gericallEntiteitenCache = null;
function loadGericallEntiteitenSeed() {
  if (_gericallEntiteitenCache) return _gericallEntiteitenCache;
  try {
    const path = require('path').join(__dirname, 'gericall-entiteiten.json');
    _gericallEntiteitenCache = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  } catch (e) {
    _gericallEntiteitenCache = [];
  }
  return _gericallEntiteitenCache;
}

async function backfillGericallTenant(t) {
  if (!t || t.id !== LEGACY_TENANT_ID) return t;
  let dirty = false;
  if (!t.naam || t.naam === 'MarktRadar') { t.naam = GERICALL_BACKFILL.naam; dirty = true; }
  if (!t.slug) { t.slug = LEGACY_TENANT_SLUG; dirty = true; await kvSet(tenantSlugKey(LEGACY_TENANT_SLUG), t.id).catch(() => {}); }
  if (!t.onboardingDone) { t.onboardingDone = true; dirty = true; }
  if (!t.propositie || GERICALL_OLD_PROPOSITIES.includes(t.propositie)) {
    t.propositie = GERICALL_BACKFILL.propositie; dirty = true;
  }
  if (!t.marktNaam || GERICALL_OLD_MARKTNAAMEN.includes(t.marktNaam)) {
    t.marktNaam = GERICALL_BACKFILL.marktNaam; dirty = true;
  }
  if (!t.marktBeschrijving) { t.marktBeschrijving = GERICALL_BACKFILL.marktBeschrijving; dirty = true; }
  if (!Array.isArray(t.feeds) || t.feeds.length === 0) { t.feeds = GERICALL_BACKFILL.feeds.slice(); dirty = true; }
  // Entiteiten-seed: vul met de 64 VVT-instellingen-namen zodat de
  // signal-cron artikel-titels kan matchen. Alleen seeden als nog leeg
  // — als de gebruiker later via Beheer eigen lijst aanmaakt blijft
  // die staan.
  if (!Array.isArray(t.entiteiten) || t.entiteiten.length === 0) {
    const seed = loadGericallEntiteitenSeed();
    if (seed.length > 0) {
      t.entiteiten = seed.slice();
      // Sync klanten[] uit entiteiten.klant
      t.klanten = seed.filter(e => e.klant).map(e => e.id);
      dirty = true;
    }
  }
  if (dirty) {
    t.backfilledAt = Date.now();
    await kvSet(tenantMetaKey(t.id), t).catch(() => {});
  }
  return t;
}

// ============================================================
// ADMIN-LIST — handmatig onderhouden, hardcoded in code.
// Alleen e-mails op deze lijst krijgen toegang tot /api/admin
// en de /app/admin route. Lege lijst = geen admin (admin-pane
// is dan onbereikbaar). E-mails MOETEN lowercase zijn.
//
// PAS DEZE LIJST AAN VOOR JE DEPLOYT. Voorbeeld:
//   const ADMIN_EMAILS = ['rene@knmlnr.nl'];
// ============================================================
const ADMIN_EMAILS = [
  'koen@salesday.nl',
];
function isAdminEmail(email) {
  if (!email) return false;
  return ADMIN_EMAILS.includes(String(email).toLowerCase().trim());
}

// Audit-log append. Rolling-buffer (laatste AUDIT_LOG_MAX events). Best-
// effort: failures worden gelogd maar laten de oorspronkelijke actie
// niet falen — een audit-log-fout mag een tenant-delete niet blokkeren.
async function appendAuditEvent(event) {
  if (!kvConfigured()) return;
  try {
    const entry = {
      ts: Date.now(),
      actor: String((event && event.actor) || '').toLowerCase(),
      action: String((event && event.action) || ''),
      target: event && event.target ? String(event.target) : null,
      targetType: event && event.targetType ? String(event.targetType) : null,
      meta: event && event.meta && typeof event.meta === 'object' ? event.meta : null,
    };
    const list = (await kvGet(KV_AUDIT_LOG)) || [];
    list.push(entry);
    // Capped: hou de laatste AUDIT_LOG_MAX events.
    const trimmed = list.length > AUDIT_LOG_MAX ? list.slice(list.length - AUDIT_LOG_MAX) : list;
    await kvSet(KV_AUDIT_LOG, trimmed);
  } catch (e) {
    // Bewust slikken — een falende audit-log mag niet doorwerken in
    // de calling action.
  }
}

module.exports = {
  ADMIN_EMAILS,
  isAdminEmail,
  KV_USER_PREFIX,
  KV_SESSION_PREFIX,
  KV_USERS_INDEX,
  KV_TENANTS_INDEX,
  KV_TENANT_SLUG_PREFIX,
  KV_AUDIT_LOG,
  AUDIT_LOG_MAX,
  appendAuditEvent,
  SESSION_TTL_MS,
  SESSION_TTL_SEC,
  LEGACY_TENANT_ID,
  LEGACY_TENANT_SLUG,
  tenantMetaKey,
  tenantUsersIndexKey,
  tenantStateKey,
  tenantAssignmentsKey,
  tenantSlugKey,
  slugifyEmailForTenant,
  slugifyName,
  kvConfigured,
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
  backfillGericallTenant,
};
