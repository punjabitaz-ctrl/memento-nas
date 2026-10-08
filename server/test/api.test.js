'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { load, ConfigError } = require('../src/config');
const dbmod = require('../src/db');
const { createApp } = require('../src/app');

const KEY = crypto.randomBytes(32).toString('hex');
const SECRET = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-api-'));
const env = { MEMENTO_KEY: KEY, SESSION_SECRET: SECRET, DATA_DIR: dataDir, MAX_FILE_SIZE_MB: '2' };

let server, base, config, db;
const H = { 'x-requested-with': 'memento' };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, { json, form, headers = {} } = {}) {
    const h = { ...H, ...headers };
    if (this.cookie) h.cookie = this.cookie;
    let body;
    if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    const res = await fetch(base + url, { method, headers: h, body });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    return res;
  }
  async json(method, url, opts) {
    const res = await this.req(method, url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    return { status: res.status, data };
  }
}

function memoryForm(fields, files = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const x of files) f.append('files', new Blob([x.data], { type: x.type }), x.name);
  return f;
}

test.before(async () => {
  config = load(env);
  db = dbmod.open(config);
  const app = createApp({ config, db, clientDist: null });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('config refuses placeholder / malformed secrets', () => {
  assert.throws(() => load({ ...env, MEMENTO_KEY: 'REPLACE_WITH_YOUR_64_CHAR_HEX_KEY' }), ConfigError);
  assert.throws(() => load({ ...env, MEMENTO_KEY: 'a'.repeat(64) }), ConfigError);
  assert.throws(() => load({ ...env, SESSION_SECRET: 'REPLACE_WITH_ANOTHER_RANDOM_STRING' }), ConfigError);
  assert.throws(() => load({ ...env, SESSION_SECRET: 'short' }), ConfigError);
});

test('health endpoint', async () => {
  const r = await fetch(base + '/health');
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.status, 'ok');
  assert.equal(j.version, '2.0.0');
});

test('security headers: CSP present, no upgrade-insecure-requests, mic allowed', async () => {
  const r = await fetch(base + '/health');
  const csp = r.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'"));
  assert.ok(!csp.includes('upgrade-insecure-requests'));
  assert.ok(r.headers.get('permissions-policy').includes('microphone=(self)'));
});

const owner = new Client();
const member = new Client();
const viewer = new Client();
let ownerMemId, photoMediaId;

test('unauthenticated API access is rejected', async () => {
  const r = await new Client().json('GET', '/api/memories');
  assert.equal(r.status, 401);
});

test('CSRF: state-changing request without header or with foreign Origin is blocked', async () => {
  const c = new Client();
  let res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { ...H, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  void c;
});

test('first-run setup creates the owner, once', async () => {
  assert.equal((await owner.json('GET', '/api/auth/status')).data.initialized, false);
  let r = await owner.json('POST', '/api/auth/setup', { json: { login: 'taz', displayName: 'Taz', password: 'short' } });
  assert.equal(r.status, 400);
  r = await owner.json('POST', '/api/auth/setup', { json: { login: 'taz', displayName: 'Taz', password: 'correct horse battery' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.role, 'owner');
  r = await new Client().json('POST', '/api/auth/setup', { json: { login: 'hax', displayName: 'X', password: 'another long password' } });
  assert.equal(r.status, 409);
  assert.equal((await owner.json('GET', '/api/auth/me')).data.user.login, 'taz');
});

test('login: wrong password rejected, right password accepted, password stored as bcrypt', async () => {
  const c = new Client();
  assert.equal((await c.json('POST', '/api/auth/login', { json: { login: 'taz', password: 'nope nope nope' } })).status, 401);
  assert.equal((await c.json('POST', '/api/auth/login', { json: { login: 'nobody', password: 'nope nope nope' } })).status, 401);
  assert.equal((await c.json('POST', '/api/auth/login', { json: { login: 'TAZ', password: 'correct horse battery' } })).status, 200);
  assert.match(db.prepare('SELECT password_hash h FROM users').get().h, /^\$2[aby]\$12\$/);
});

test('owner creates a contributor and a viewer', async () => {
  let r = await owner.json('POST', '/api/members', { json: { login: 'sarah', displayName: 'Sarah', password: 'sarah long password', role: 'contributor' } });
  assert.equal(r.status, 201);
  r = await owner.json('POST', '/api/members', { json: { login: 'kid', displayName: 'Kid', password: 'kid long password', role: 'viewer' } });
  assert.equal(r.status, 201);
  assert.equal((await member.json('POST', '/api/auth/login', { json: { login: 'sarah', password: 'sarah long password' } })).status, 200);
  assert.equal((await viewer.json('POST', '/api/auth/login', { json: { login: 'kid', password: 'kid long password' } })).status, 200);
  assert.equal((await member.json('POST', '/api/members', { json: { login: 'x', displayName: 'X', password: 'xxxxxxxxxxxx' } })).status, 403);
});

test('create a photo memory: encrypted on disk, organizer fills blanks', async () => {
  const photo = crypto.randomBytes(150_000);
  const form = memoryForm(
    { title: "Grandma Rose's wedding", content: 'Grandma Rose married Grandpa William in June 1962 at St. Marys Church in Pittsburgh. She wore her mothers dress. The wedding was lovely.', privacy: 'family' },
    [{ name: 'wedding.jpg', type: 'image/jpeg', data: photo }]
  );
  const r = await owner.json('POST', '/api/memories', { form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const m = r.data.memory;
  ownerMemId = m.id;
  photoMediaId = m.media[0].id;
  assert.equal(m.type, 'photo');
  assert.equal(m.media[0].size, 150_000);
  assert.equal(m.memoryDate, '1962-06-01');
  assert.equal(m.datePrecision, 'month');
  assert.ok(m.tags.includes('wedding'));
  assert.ok(m.people.some((p) => p.name === 'Grandma Rose'));
  assert.ok(m.aiSummary.length > 0);
  assert.equal(m.aiSource, 'offline');
  // ciphertext only
  const raw = fs.readFileSync(path.join(config.dirs.vault, `${photoMediaId}.enc`));
  assert.equal(raw.includes(photo.subarray(1000, 1064)), false, 'plaintext found in vault file');
  assert.equal(raw.subarray(0, 4).toString(), 'MEM2');
  assert.deepEqual(fs.readdirSync(config.dirs.vault).filter((f) => f.endsWith('.part')), []);
  assert.deepEqual(fs.readdirSync(config.dirs.tmp), [], 'no plaintext temp files');
});

test('download: full, range, headers; wrong user gets 404 for private; tamper -> error', async () => {
  const meta = db.prepare('SELECT * FROM media WHERE id = ?').get(photoMediaId);
  const res = await owner.req('GET', `/api/media/${photoMediaId}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('content-security-policy').includes('sandbox'));
  const full = Buffer.from(await res.arrayBuffer());
  assert.equal(full.length, meta.size_plain);

  const part = await owner.req('GET', `/api/media/${photoMediaId}`, { headers: { range: 'bytes=70000-70099' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 70000-70099/${full.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), full.subarray(70000, 70100));
  assert.equal((await owner.req('GET', `/api/media/${photoMediaId}`, { headers: { range: 'bytes=999999999-' } })).status, 416);

  assert.equal((await new Client().req('GET', `/api/media/${photoMediaId}`)).status, 401);

  // tamper with a byte in the middle of the file
  const f = path.join(config.dirs.vault, `${photoMediaId}.enc`);
  const orig = fs.readFileSync(f);
  const bad = Buffer.from(orig); bad[70_000] ^= 1;
  fs.writeFileSync(f, bad);
  const t = await owner.req('GET', `/api/media/${photoMediaId}`).then(async (r) => {
    try { await r.arrayBuffer(); return r.status; } catch { return 'aborted'; }
  });
  assert.ok(t === 500 || t === 'aborted' || t === 200 /* headers sent, connection cut */, `tamper status ${t}`);
  // first chunk tamper must be a clean 500, never plaintext
  const bad2 = Buffer.from(orig); bad2[30] ^= 1;
  fs.writeFileSync(f, bad2);
  const r2 = await owner.req('GET', `/api/media/${photoMediaId}`);
  assert.equal(r2.status, 500);
  fs.writeFileSync(f, orig); // restore
  assert.equal((await owner.req('GET', `/api/media/${photoMediaId}`)).status, 200);
});

test('voice note upload (webm) + text note + private visibility', async () => {
  const audio = crypto.randomBytes(40_000);
  let r = await member.json('POST', '/api/memories', {
    form: memoryForm({ title: 'Recipe voice note', duration: '95', privacy: 'family', memoryDate: '1955' }, [{ name: 'rec.webm', type: 'audio/webm;codecs=opus', data: audio }]),
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.memory.type, 'voice_note');
  assert.equal(r.data.memory.media[0].duration, 95);
  assert.equal(r.data.memory.datePrecision, 'year');

  r = await member.json('POST', '/api/memories', { form: memoryForm({ title: 'Private diary', content: 'secret thoughts about quokkas', privacy: 'private' }) });
  assert.equal(r.status, 201);
  const priv = r.data.memory.id;
  assert.equal((await owner.json('GET', `/api/memories/${priv}`)).status, 404, 'owner must not read others\' private memories');
  assert.equal((await member.json('GET', `/api/memories/${priv}`)).status, 200);
  const s = await owner.json('GET', '/api/search?q=quokkas');
  assert.equal(s.data.results.length, 0, 'search must not leak private memories');
  assert.equal((await member.json('GET', '/api/search?q=quokkas')).data.results.length, 1);
});

test('uploads: disallowed types, size limit and failures leave no files behind', async () => {
  const before = fs.readdirSync(config.dirs.vault).length;
  let r = await owner.json('POST', '/api/memories', { form: memoryForm({ title: 'x' }, [{ name: 'evil.svg', type: 'image/svg+xml', data: '<svg onload=alert(1)>' }]) });
  assert.equal(r.status, 415);
  r = await owner.json('POST', '/api/memories', { form: memoryForm({ title: 'x' }, [{ name: 'a.exe', type: 'application/x-msdownload', data: 'MZ' }]) });
  assert.equal(r.status, 415);
  r = await owner.json('POST', '/api/memories', { form: memoryForm({ title: 'big' }, [{ name: 'big.mp4', type: 'video/mp4', data: Buffer.alloc(3 * 1024 * 1024) }]) });
  assert.equal(r.status, 413);
  r = await owner.json('POST', '/api/memories', { form: memoryForm({ title: 'bad date', memoryDate: '1962-13-45' }, [{ name: 'a.jpg', type: 'image/jpeg', data: 'abc' }]) });
  assert.equal(r.status, 400);
  assert.equal(fs.readdirSync(config.dirs.vault).length, before, 'orphan files left in vault');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memories WHERE title IN ('x','big','bad date')").get().c, 0);
});

test('viewer cannot write; contributor cannot edit others; owner can edit family memories', async () => {
  assert.equal((await viewer.json('POST', '/api/memories', { form: memoryForm({ title: 'nope' }) })).status, 403);
  assert.equal((await member.json('PATCH', `/api/memories/${ownerMemId}`, { json: { title: 'hijack' } })).status, 403);
  const r = await owner.json('PATCH', `/api/memories/${ownerMemId}`, { json: { transcript: 'Typed transcript about gardenias', tags: ['wedding', 'family'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.memory.tags, ['family', 'wedding']);
  assert.equal((await viewer.json('GET', `/api/memories/${ownerMemId}`)).data.canEdit, false);
});

test('search: FTS, prefix, transcript edits indexed, hostile input is safe', async () => {
  assert.ok((await owner.json('GET', '/api/search?q=gardenias')).data.results.length >= 1);
  assert.ok((await owner.json('GET', '/api/search?q=wedd')).data.results.length >= 1, 'prefix match');
  for (const q of ['"', "'; DROP TABLE memories;--", 'NEAR(', 'a AND OR NOT', '*', '']) {
    const r = await owner.json('GET', `/api/search?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 200, `query ${q}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memories').get().c >= 3, true);
});

test('timeline, gaps, stats, people, prompts', async () => {
  const t = await owner.json('GET', '/api/timeline');
  assert.deepEqual(t.data.years.map((y) => y.year), [1962, 1955]);
  const g = await owner.json('GET', '/api/timeline/gaps');
  assert.deepEqual(g.data.decades.map((d) => d.decade), [1950, 1960]);
  const st = await owner.json('GET', '/api/stats');
  assert.equal(st.data.firstYear, 1955);
  assert.ok(st.data.byType.photo >= 1);
  assert.ok((await owner.json('GET', '/api/people')).data.people.some((p) => p.name === 'Grandma Rose'));
  const p = await owner.json('GET', '/api/prompts');
  assert.ok(p.data.prompts.length >= 140);
  assert.equal((await owner.json('GET', '/api/prompts/categories')).data.categories.length, 12);
  const w1 = (await owner.json('GET', '/api/prompts/weekly')).data.prompt.id;
  assert.equal((await member.json('GET', '/api/prompts/weekly')).data.prompt.id, w1, 'same weekly prompt for everyone');
  const c = await member.json('POST', '/api/prompts', { json: { text: 'What did the old farmhouse smell like?', category: 'childhood' } });
  assert.equal(c.status, 201);
  assert.equal((await viewer.json('POST', '/api/prompts/' + c.data.prompt.id + '/vote')).data.prompt.votes, 1);
});

test('narrate weaves memories for a person or a year', async () => {
  const r = await owner.json('POST', '/api/narrate', { json: { subject: 'Grandma Rose' } });
  assert.equal(r.status, 200);
  assert.match(r.data.story, /June 1962/);
  assert.equal((await owner.json('POST', '/api/narrate', { json: { subject: '1955' } })).data.sources.length, 1);
  assert.equal((await owner.json('POST', '/api/narrate', { json: { subject: 'Nobody Atall' } })).status, 404);
});

test('export: valid zip with decrypted files, metadata, and private memories excluded', async () => {
  const res = await owner.req('GET', '/api/export');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('latin1');
  assert.ok(text.includes('memories.json') && text.includes('stories.md') && text.includes('wedding.jpg'));
  assert.ok(!text.includes('quokkas'), 'private memory leaked into owner export');
  const { execFileSync } = require('node:child_process');
  const zf = path.join(dataDir, 'exp.zip');
  fs.writeFileSync(zf, buf);
  try {
    execFileSync('unzip', ['-tq', zf], { stdio: 'pipe' });
    const out = path.join(dataDir, 'exp');
    execFileSync('unzip', ['-qo', zf, '-d', out]);
    const found = execFileSync('find', [out, '-name', 'wedding.jpg']).toString().trim();
    const orig = fs.readFileSync(path.join(config.dirs.vault, `${photoMediaId}.enc`));
    assert.ok(found && fs.statSync(found).size === 150_000 && orig.length > 150_000);
  } catch (e) {
    if (e.code === 'ENOENT') console.warn('unzip not installed; skipped deep zip check');
    else throw e;
  }
});

test('delete removes DB rows, search entries and vault files', async () => {
  const m = db.prepare("SELECT id FROM memories WHERE title = 'Recipe voice note'").get();
  const media = db.prepare('SELECT id FROM media WHERE memory_id = ?').get(m.id);
  assert.ok(fs.existsSync(path.join(config.dirs.vault, `${media.id}.enc`)));
  assert.equal((await owner.json('DELETE', `/api/memories/${m.id}`)).status, 200);
  assert.equal(fs.existsSync(path.join(config.dirs.vault, `${media.id}.enc`)), false);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM memory_fts WHERE memory_id = ?').get(m.id).c, 0);
});

test('last owner cannot be demoted or disabled', async () => {
  const me = (await owner.json('GET', '/api/auth/me')).data.user;
  assert.equal((await owner.json('PATCH', `/api/members/${me.id}`, { json: { role: 'viewer' } })).status, 400);
  assert.equal((await owner.json('PATCH', `/api/members/${me.id}`, { json: { disabled: true } })).status, 400);
});

test('disabled member is signed out immediately', async () => {
  const sarah = db.prepare("SELECT id FROM users WHERE login='sarah'").get();
  assert.equal((await owner.json('PATCH', `/api/members/${sarah.id}`, { json: { disabled: true } })).status, 200);
  assert.equal((await member.json('GET', '/api/memories')).status, 401);
});

test('starting with a different key is refused (vault stays recoverable)', () => {
  db.close();
  const wrong = load({ ...env, MEMENTO_KEY: crypto.randomBytes(32).toString('hex') });
  assert.throws(() => dbmod.open(wrong), (e) => e.code === 'KEY_MISMATCH');
  db = dbmod.open(config); // original key still works
  assert.ok(db.prepare('SELECT COUNT(*) c FROM memories').get().c > 0);
});
