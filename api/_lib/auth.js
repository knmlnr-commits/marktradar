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
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

// Default-tenant voor pre-multi-tenant data. Bestaande state/assignments/users
// zonder tenantId worden hieronder ingelezen tijdens migratie.
const LEGACY_TENANT_ID = 'gericall';

function tenantMetaKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':meta'; }
function tenantUsersIndexKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':users:index'; }
function tenantStateKey(tenantId, name) { return 'marktradar:tenant:' + tenantId + ':state:v1:' + name; }
function tenantAssignmentsKey(tenantId) { return 'marktradar:tenant:' + tenantId + ':assignments:v1'; }

function slugifyEmailForTenant(email) {
  const e = String(email || '').toLowerCase().trim();
  // 8-byte hash (16 hex tekens) is uniek genoeg voor onze schaal en geeft
  // korte, voorspelbare keys zonder de email zelf in de key te hebben.
  const hash = createHash('sha256').update(e).digest('hex').slice(0, 16);
  return 't_' + hash;
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

module.exports = {
  KV_USER_PREFIX,
  KV_SESSION_PREFIX,
  KV_USERS_INDEX,
  KV_TENANTS_INDEX,
  SESSION_TTL_MS,
  SESSION_TTL_SEC,
  LEGACY_TENANT_ID,
  tenantMetaKey,
  tenantUsersIndexKey,
  tenantStateKey,
  tenantAssignmentsKey,
  slugifyEmailForTenant,
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
};
