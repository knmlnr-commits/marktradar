// Admin-endpoint — alleen toegankelijk voor e-mails in lib.ADMIN_EMAILS.
// Acties: tenants beheren (list/create/delete/transfer) + users beheren
// (list/add/reset-password/remove). Audit-log is bewust geen feature
// hier (separate event-pipeline; follow-up).
//
// Alle write-acties zijn idempotent waar mogelijk; delete is destructive
// en eist een explicit confirm-token in de body.

const lib = require('./_lib/auth');
const authMod = require('./auth');
const demoReq = require('./demo-request');

async function requireAdminSession(req, res) {
  // Sessie-cookie → e-mail. Daarna alleen door als de e-mail in
  // lib.ADMIN_EMAILS staat. Zo niet: 403, geen leak van wat er wél is.
  if (!lib.kvConfigured()) {
    res.status(503).json({ error: 'Vercel KV niet geconfigureerd' });
    return null;
  }
  const cookieHeader = req.headers.cookie || '';
  const match = /(?:^|;\s*)mr_session=([^;]+)/.exec(cookieHeader);
  if (!match) {
    res.status(401).json({ error: 'Niet ingelogd' });
    return null;
  }
  const session = await lib.kvGet(lib.KV_SESSION_PREFIX + match[1]);
  if (!session || (session.expires && session.expires < Date.now())) {
    res.status(401).json({ error: 'Sessie verlopen' });
    return null;
  }
  if (!lib.isAdminEmail(session.email)) {
    res.status(403).json({ error: 'Niet geautoriseerd' });
    return null;
  }
  return session;
}

async function loadTenantMeta(tenantId) {
  return await lib.kvGet(lib.tenantMetaKey(tenantId));
}

async function listTenants(res) {
  const ids = await authMod.getTenantsIndex();
  const out = [];
  for (const id of ids) {
    const t = await loadTenantMeta(id);
    if (!t) continue;
    const userEmails = await authMod.getTenantUsersIndex(id);
    out.push({
      id: t.id,
      naam: t.naam || '',
      slug: t.slug || null,
      createdAt: t.createdAt || null,
      createdBy: t.createdBy || null,
      updatedAt: t.updatedAt || null,
      userCount: userEmails.length,
      isLegacy: t.id === lib.LEGACY_TENANT_ID,
    });
  }
  out.sort((a, b) => (a.naam || '').localeCompare(b.naam || ''));
  return res.status(200).json({ tenants: out });
}

async function listAllUsers(res) {
  // Globale users-index → user-records. Geen wachtwoord-hashes naar de
  // client; alleen publieke velden.
  const emails = await authMod.getGlobalUsersIndex();
  const out = [];
  for (const email of emails) {
    const u = await lib.kvGet(lib.KV_USER_PREFIX + email);
    if (!u) continue;
    out.push(authMod.publicUser(u));
  }
  out.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  return res.status(200).json({ users: out });
}

async function listAuditLog(req, res) {
  const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '200', 10) || 200, 1), 500);
  const list = (await lib.kvGet(lib.KV_AUDIT_LOG)) || [];
  // Newest-first; respecteer limit.
  const sorted = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, limit);
  return res.status(200).json({ events: sorted, total: list.length, cap: lib.AUDIT_LOG_MAX });
}

async function createTenantAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const tenantNaam = String(body.tenantNaam || '').trim();
  const slug = String(body.slug || '').trim();
  const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
  const adminNaam = String(body.adminNaam || '').trim();
  let adminPassword = String(body.adminPassword || '');
  if (!tenantNaam) return res.status(400).json({ error: 'Tenant-naam verplicht' });
  if (!adminEmail || !adminEmail.includes('@')) return res.status(400).json({ error: 'Geldig admin-email-adres verplicht' });
  if (!adminNaam) return res.status(400).json({ error: 'Admin-naam verplicht' });

  // Naam-uniqueness: lowercase-trim-vergelijking over alle tenants.
  const ids = await authMod.getTenantsIndex();
  const wanted = tenantNaam.toLowerCase();
  for (const id of ids) {
    const t = await loadTenantMeta(id);
    if (t && String(t.naam || '').toLowerCase().trim() === wanted) {
      return res.status(409).json({ error: 'Er bestaat al een werkomgeving met deze naam' });
    }
  }
  // Admin-email mag nog geen ander account hebben.
  const existing = await lib.kvGet(lib.KV_USER_PREFIX + adminEmail);
  if (existing) {
    return res.status(409).json({ error: 'Er bestaat al een gebruiker met dit e-mail-adres' });
  }
  // Genereer tenant-ID + tijdelijke password als die niet meegestuurd is.
  let tenantId = lib.slugifyEmailForTenant(adminEmail);
  const existingIds = ids;
  if (existingIds.includes(tenantId)) {
    tenantId = tenantId + '_' + lib.makeId('').slice(0, 6);
  }
  const tempGenerated = !adminPassword;
  if (tempGenerated) adminPassword = authMod.generateTempPassword(12);
  if (adminPassword.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });

  const tenant = await authMod.createTenant(tenantId, tenantNaam, adminEmail, slug);
  const user = await authMod.newUserRecord(adminEmail, adminNaam, adminPassword, {
    tenantId,
    role: 'admin',
    mustChangePassword: tempGenerated,
    createdBy: session.email,
  });
  await lib.kvSet(lib.KV_USER_PREFIX + adminEmail, user);
  await authMod.appendGlobalUserIndex(adminEmail);
  await authMod.appendTenantUserIndex(tenantId, adminEmail);
  await lib.appendAuditEvent({
    actor: session.email, action: 'tenant.create', target: tenantId, targetType: 'tenant',
    meta: { naam: tenantNaam, slug: tenant.slug, adminEmail },
  });
  return res.status(200).json({
    tenant: authMod.publicTenant(tenant),
    user: authMod.publicUser(user),
    tempPassword: tempGenerated ? adminPassword : null,
  });
}

async function addUserToTenantAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const tenantId = String(body.tenantId || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const naam = String(body.naam || '').trim();
  let password = String(body.password || '');
  const role = String(body.role || 'user').trim() || 'user';
  if (!tenantId) return res.status(400).json({ error: 'tenantId verplicht' });
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Geldig e-mail-adres verplicht' });
  if (!naam) return res.status(400).json({ error: 'Naam verplicht' });
  const tenant = await loadTenantMeta(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Werkomgeving niet gevonden' });
  const existing = await lib.kvGet(lib.KV_USER_PREFIX + email);
  if (existing) return res.status(409).json({ error: 'Er bestaat al een gebruiker met dit e-mail-adres' });
  const tempGenerated = !password;
  if (tempGenerated) password = authMod.generateTempPassword(12);
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
  const user = await authMod.newUserRecord(email, naam, password, {
    tenantId,
    role,
    mustChangePassword: tempGenerated,
    createdBy: session.email,
  });
  await lib.kvSet(lib.KV_USER_PREFIX + email, user);
  await authMod.appendGlobalUserIndex(email);
  await authMod.appendTenantUserIndex(tenantId, email);
  await lib.appendAuditEvent({
    actor: session.email, action: 'user.create', target: email, targetType: 'user',
    meta: { tenantId, role, naam },
  });
  return res.status(200).json({
    user: authMod.publicUser(user),
    tempPassword: tempGenerated ? password : null,
  });
}

async function resetUserPasswordAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  let password = String(body.password || '');
  if (!email) return res.status(400).json({ error: 'email verplicht' });
  const user = await lib.kvGet(lib.KV_USER_PREFIX + email);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  const tempGenerated = !password;
  if (tempGenerated) password = authMod.generateTempPassword(12);
  if (password.length < 8) return res.status(400).json({ error: 'Wachtwoord moet minimaal 8 tekens zijn' });
  user.salt = lib.makeSalt();
  user.passwordHash = await lib.hashPassword(password, user.salt);
  user.mustChangePassword = tempGenerated;
  user.updatedAt = Date.now();
  await lib.kvSet(lib.KV_USER_PREFIX + email, user);
  await lib.appendAuditEvent({
    actor: session.email, action: 'user.reset-password', target: email, targetType: 'user',
    meta: { tempGenerated },
  });
  return res.status(200).json({
    user: authMod.publicUser(user),
    tempPassword: tempGenerated ? password : null,
  });
}

async function removeUserAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email verplicht' });
  if (email === session.email) return res.status(400).json({ error: 'Je kunt jezelf niet verwijderen' });
  const user = await lib.kvGet(lib.KV_USER_PREFIX + email);
  if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  await lib.kvDel(lib.KV_USER_PREFIX + email);
  await authMod.removeGlobalUserIndex(email);
  if (user.tenantId) await authMod.removeTenantUserIndex(user.tenantId, email);
  await lib.appendAuditEvent({
    actor: session.email, action: 'user.delete', target: email, targetType: 'user',
    meta: { tenantId: user.tenantId || null },
  });
  return res.status(200).json({ ok: true });
}

async function transferTenantAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const tenantId = String(body.tenantId || '').trim();
  const newOwnerEmail = String(body.newOwnerEmail || '').trim().toLowerCase();
  if (!tenantId) return res.status(400).json({ error: 'tenantId verplicht' });
  if (!newOwnerEmail) return res.status(400).json({ error: 'newOwnerEmail verplicht' });
  const tenant = await loadTenantMeta(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Werkomgeving niet gevonden' });
  const owner = await lib.kvGet(lib.KV_USER_PREFIX + newOwnerEmail);
  if (!owner) return res.status(404).json({ error: 'Nieuwe eigenaar moet al een gebruiker zijn' });
  if (owner.tenantId !== tenantId) {
    return res.status(400).json({ error: 'Nieuwe eigenaar moet al lid zijn van deze werkomgeving' });
  }
  const previousOwner = tenant.createdBy || null;
  tenant.createdBy = newOwnerEmail;
  tenant.updatedAt = Date.now();
  await lib.kvSet(lib.tenantMetaKey(tenantId), tenant);
  await lib.appendAuditEvent({
    actor: session.email, action: 'tenant.transfer', target: tenantId, targetType: 'tenant',
    meta: { from: previousOwner, to: newOwnerEmail },
  });
  return res.status(200).json({ tenant: authMod.publicTenant(tenant) });
}

async function deleteTenantAction(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const tenantId = String(body.tenantId || '').trim();
  const confirm = String(body.confirm || '').trim();
  if (!tenantId) return res.status(400).json({ error: 'tenantId verplicht' });
  if (tenantId === lib.LEGACY_TENANT_ID) {
    return res.status(400).json({ error: 'De legacy-tenant kan niet verwijderd worden' });
  }
  const tenant = await loadTenantMeta(tenantId);
  if (!tenant) return res.status(404).json({ error: 'Werkomgeving niet gevonden' });
  // Required confirm-string = tenant-naam (identiek matchen).
  if (confirm !== (tenant.naam || tenantId)) {
    return res.status(400).json({
      error: 'Bevestiging vereist: stuur het exacte tenant-naam in body.confirm',
      expected: tenant.naam || tenantId,
    });
  }
  // Cascade: users + indexen + state-keys + slug-mapping + meta + tenant-index.
  const userEmails = await authMod.getTenantUsersIndex(tenantId);
  for (const email of userEmails) {
    const u = await lib.kvGet(lib.KV_USER_PREFIX + email);
    if (u && u.tenantId === tenantId) {
      await lib.kvDel(lib.KV_USER_PREFIX + email);
      await authMod.removeGlobalUserIndex(email);
    }
  }
  await lib.kvDel(lib.tenantUsersIndexKey(tenantId));
  // State-keys (zie state.js ALLOWED_KEYS):
  const STATE_KEYS = ['todos', 'dmu-overrides', 'spec-overrides', 'overrides',
    'dropdowns', 'owners', 'signal-history', 'opportunities',
    'supplier-overrides', 'coaching', 'account-plans'];
  for (const k of STATE_KEYS) {
    await lib.kvDel(lib.tenantStateKey(tenantId, k));
  }
  await lib.kvDel(lib.tenantAssignmentsKey(tenantId));
  if (tenant.slug) await lib.kvDel(lib.tenantSlugKey(tenant.slug));
  await lib.kvDel(lib.tenantMetaKey(tenantId));
  // Verwijder uit globale tenant-index
  const ids = await authMod.getTenantsIndex();
  const remaining = ids.filter((id) => id !== tenantId);
  await lib.kvSet(lib.KV_TENANTS_INDEX, remaining);
  await lib.appendAuditEvent({
    actor: session.email, action: 'tenant.delete', target: tenantId, targetType: 'tenant',
    meta: { naam: tenant.naam || tenantId, removedUsers: userEmails.length },
  });
  return res.status(200).json({ ok: true, removedUsers: userEmails.length, removedBy: session.email });
}

async function listRequests(req, res) {
  // Demo + workspace aanvragen. Newest first. Index bevat lightweight
  // records; we hydrateren elk record via kvGet voor de volledige data.
  const filter = String((req.query && req.query.type) || '').trim().toLowerCase();
  const index = (await lib.kvGet(demoReq.INDEX_KEY)) || [];
  const out = [];
  for (const entry of index) {
    const full = await lib.kvGet(demoReq.KEY_PREFIX + entry.id);
    if (!full) continue;
    if (filter && (full.type || 'demo') !== filter) continue;
    out.push({
      id: full.id,
      type: full.type || 'demo',
      naam: full.naam || '',
      organisatie: full.organisatie || '',
      email: full.email || '',
      telefoon: full.telefoon || '',
      rol: full.rol || '',
      bericht: full.bericht || '',
      werkomgevingNaam: full.werkomgevingNaam || '',
      marktNaam: full.marktNaam || '',
      status: full.status || 'nieuw',
      createdAt: full.createdAt || 0,
      handledAt: full.handledAt || null,
      handledBy: full.handledBy || null,
    });
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return res.status(200).json({ requests: out });
}

async function updateRequestStatus(req, res, session) {
  const body = await authMod.readJsonBody(req);
  const id = String(body.id || '').trim();
  const status = String(body.status || '').trim().toLowerCase();
  if (!id) return res.status(400).json({ error: 'id verplicht' });
  if (!['nieuw', 'bezig', 'klaar', 'afgewezen'].includes(status)) {
    return res.status(400).json({ error: 'Ongeldige status' });
  }
  const record = await lib.kvGet(demoReq.KEY_PREFIX + id);
  if (!record) return res.status(404).json({ error: 'Aanvraag niet gevonden' });
  record.status = status;
  if (status !== 'nieuw') {
    record.handledAt = Date.now();
    record.handledBy = session.email;
  }
  await lib.kvSet(demoReq.KEY_PREFIX + id, record);
  return res.status(200).json({ ok: true, status });
}

async function deleteRequest(req, res) {
  const body = await authMod.readJsonBody(req);
  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id verplicht' });
  await lib.kvDel(demoReq.KEY_PREFIX + id);
  const index = (await lib.kvGet(demoReq.INDEX_KEY)) || [];
  const remaining = index.filter((e) => e.id !== id);
  await lib.kvSet(demoReq.INDEX_KEY, remaining);
  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const session = await requireAdminSession(req, res);
    if (!session) return;
    const action = (req.query && req.query.action) || '';
    if (action === 'list-tenants' && (req.method === 'GET' || req.method === 'POST')) {
      return listTenants(res);
    }
    if (action === 'list-users' && (req.method === 'GET' || req.method === 'POST')) {
      return listAllUsers(res);
    }
    if (action === 'create-tenant' && req.method === 'POST') {
      return createTenantAction(req, res, session);
    }
    if (action === 'add-user' && req.method === 'POST') {
      return addUserToTenantAction(req, res, session);
    }
    if (action === 'reset-password' && req.method === 'POST') {
      return resetUserPasswordAction(req, res, session);
    }
    if (action === 'remove-user' && req.method === 'POST') {
      return removeUserAction(req, res, session);
    }
    if (action === 'transfer-tenant' && req.method === 'POST') {
      return transferTenantAction(req, res, session);
    }
    if (action === 'list-audit-log' && (req.method === 'GET' || req.method === 'POST')) {
      return listAuditLog(req, res);
    }
    if (action === 'delete-tenant' && req.method === 'POST') {
      return deleteTenantAction(req, res, session);
    }
    if (action === 'list-requests' && (req.method === 'GET' || req.method === 'POST')) {
      return listRequests(req, res);
    }
    if (action === 'update-request' && req.method === 'POST') {
      return updateRequestStatus(req, res, session);
    }
    if (action === 'delete-request' && req.method === 'POST') {
      return deleteRequest(req, res);
    }
    return res.status(400).json({ error: 'Onbekende actie of method' });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
};
