'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory } = require('./helpers/world');
const { makeEmbedHandler } = require('../src/ai/embed');
const { retrieve, scanChunks } = require('../src/ai/retrieve');
const { toBlob, normalize } = require('../src/ai/embed');
const { NodeError } = require('../src/ai/client');
const { ftsQuery } = require('../src/util');
const { NoEligibleNode } = require('../src/ai/errors');

test('ftsQuery: default mode keeps the search-box behaviour; "or" mode drops stop words', () => {
  assert.equal(ftsQuery('apple pie'), '"apple" "pie"*');
  assert.equal(ftsQuery('  '), null);
  assert.equal(ftsQuery('Who was my grandfather\'s brother?', { mode: 'or' }), '"grandfather" OR "brother"');
  assert.equal(ftsQuery('the and of', { mode: 'or' }), null);
});

async function world() {
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const owner = addUser(w.db, { id: 'owner', name: 'Owner' });
  const sarah = addUser(w.db, { id: 'sarah', role: 'contributor', name: 'Sarah' });
  const embed = makeEmbedHandler(w);
  // private memories are (correctly) not embeddable on a remote node: that is the point of several tests
  const add = async (o) => { const id = addMemory(w.db, o); await embed({ memory_id: id }).catch((e) => { if (!(e instanceof NoEligibleNode)) throw e; }); return id; };
  return { fake, w, owner, sarah, add, user: (id) => w.db.prepare('SELECT * FROM users WHERE id=?').get(id) };
}

test('hybrid retrieval finds the right memory by keyword and by vector, and fuses the ranking', async () => {
  const { fake, w, owner, add, user } = await world();
  const orchard = await add({ by: owner, title: 'The orchard', content: 'Grandpa William planted forty apple trees behind the farmhouse.', date: '1962-06-01' });
  await add({ by: owner, title: 'Wedding', content: 'Rose wore her mother dress at St Mary church.' });
  await add({ by: owner, title: 'Cricket', content: 'We played cricket on the roof every summer evening.' });
  const r = await retrieve({ db: w.db, registry: w.registry, config: w.config, user: user('owner'), question: 'who planted the apple trees' });
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.degraded, false);
  assert.equal(r.passages[0].memoryId, orchard);
  assert.deepEqual([...r.passages[0].via].sort(), ['fts', 'vec']);
  assert.match(r.passages[0].text, /apple trees/);
  assert.equal(r.passages[0].memoryDate, '1962-06-01');
  await fake.close(); w.close();
});

test('never returns another member\'s private memory, through keyword or vector search', async () => {
  const { fake, w, owner, sarah, add, user } = await world();
  const secret = await add({ by: owner, title: 'Secret recipe', content: 'The secret recipe uses cardamom and burnt sugar.', privacy: 'private' });
  const open = await add({ by: owner, title: 'Open recipe', content: 'The family recipe uses flour and butter.' });
  const ask = (u) => retrieve({ db: w.db, registry: w.registry, config: w.config, user: user(u), question: 'what is the secret recipe with cardamom' });
  const asSarah = await ask('sarah');
  assert.ok(!asSarah.passages.some((p) => p.memoryId === secret), 'private memory leaked to a family member');
  assert.ok(asSarah.passages.some((p) => p.memoryId === open));
  const asOwner = await ask('owner');
  assert.ok(asOwner.passages.some((p) => p.memoryId === secret && p.privacy === 'private'), 'author still finds their own');
  void sarah;
  await fake.close(); w.close();
});

test('falls back to keyword-only (degraded) when the embed node is down, and works with no embed node at all', async () => {
  const { fake, w, owner, add, user } = await world();
  const m = await add({ by: owner, title: 'Orchard', content: 'Forty apple trees in the orchard.' });
  fake.state.failStatus = 500;
  const down = await retrieve({ db: w.db, registry: w.registry, config: w.config, user: user('owner'), question: 'apple orchard' });
  assert.equal(down.degraded, true);
  assert.equal(down.mode, 'keyword');
  assert.equal(down.passages[0].memoryId, m);
  assert.deepEqual(down.passages[0].via, ['fts']);
  await fake.close(); w.close();

  const bare = makeWorld();
  const o = addUser(bare.db, { id: 'o' });
  const mm = addMemory(bare.db, { by: o, title: 'Orchard', content: 'Forty apple trees.' });
  const none = await retrieve({ db: bare.db, registry: bare.registry, config: bare.config, user: bare.db.prepare('SELECT * FROM users WHERE id=?').get('o'), question: 'apple trees' });
  assert.equal(none.degraded, false);
  assert.equal(none.mode, 'keyword');
  assert.equal(none.passages[0].memoryId, mm);
  bare.close();
});

test('returns nothing for a question with no words or no matches in an empty archive', async () => {
  const { fake, w, owner, user } = await world();
  void owner;
  const r = await retrieve({ db: w.db, registry: w.registry, config: w.config, user: user('owner'), question: '???' });
  assert.deepEqual(r.passages, []);
  await fake.close(); w.close();
});

test('vector path alone cannot leak a private memory that really has embedded chunks (local node)', async () => {
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake, { local: true })] });
  const owner = addUser(w.db, { id: 'owner', name: 'Owner' });
  addUser(w.db, { id: 'sarah', role: 'contributor', name: 'Sarah' });
  const embed = makeEmbedHandler(w);
  const secret = addMemory(w.db, { by: owner, title: 'Diary', content: 'Saffron and cardamom notes for the wedding feast.', privacy: 'private' });
  await embed({ memory_id: secret });
  assert.ok(w.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE memory_id = ?').get(secret).n > 0, 'private chunk exists on the local node');
  const ask = (id) => retrieve({ db: w.db, registry: w.registry, config: w.config, user: w.db.prepare('SELECT * FROM users WHERE id=?').get(id), question: 'saffron cardamom wedding feast' });
  const asOwner = await ask('owner');
  assert.ok(asOwner.passages.some((p) => p.memoryId === secret && p.via.includes('vec')), 'author finds it through the vector path');
  const asSarah = await ask('sarah');
  assert.equal(asSarah.mode, 'hybrid');
  assert.deepEqual(asSarah.passages, []);
  await fake.close(); w.close();
});

const askAs = (w, id, question, extra = {}) =>
  retrieve({ db: w.db, registry: w.registry, config: w.config, user: w.db.prepare('SELECT * FROM users WHERE id=?').get(id), question, ...extra });

function addChunk(db, memoryId, text, vec, model, ord = 0) {
  db.prepare('INSERT INTO chunks (id, memory_id, ord, text, model, dim, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(`c-${memoryId}-${ord}-${text.length}`, memoryId, ord, text, model, vec.length, toBlob(vec), new Date().toISOString());
}

test('any embed failure (HTTP 400/401, malformed reply) degrades to keyword-only; programmer errors still throw', async () => {
  for (const status of [400, 401]) {
    const { fake, w, owner, add } = await world();
    const m = await add({ by: owner, title: 'Orchard', content: 'Forty apple trees in the orchard.' });
    fake.state.failStatus = status;
    const r = await askAs(w, 'owner', 'apple orchard');
    assert.equal(r.degraded, true, `status ${status}`);
    assert.equal(r.mode, 'keyword');
    assert.equal(r.passages[0].memoryId, m);
    await fake.close(); w.close();
  }
  const { fake, w, owner, add } = await world();
  await add({ by: owner, title: 'Orchard', content: 'Forty apple trees in the orchard.' });
  const bad = { embed: async () => { throw new NodeError('desk answered HTTP 400', false); } };
  assert.equal((await askAs(w, 'owner', 'apple orchard', { client: bad })).degraded, true);
  const bug = { embed: async () => { throw new TypeError('programmer error'); } };
  await assert.rejects(askAs(w, 'owner', 'apple orchard', { client: bug }), TypeError);
  await fake.close(); w.close();
});

test('vector path alone surfaces a memory with no lexical overlap with the question', async () => {
  const { fake, w, owner } = await world();
  const vec = new Array(64).fill(0); vec[3] = 1; vec[9] = 0.5;
  fake.state.embed = () => vec; // the question embeds to exactly this vector
  const m = addMemory(w.db, { by: owner, title: 'Harbour', content: 'Boats rocked gently at the quay.' });
  addChunk(w.db, m, 'Boats rocked gently at the quay.', vec, w.config.ai.embedModel);
  const r = await askAs(w, 'owner', 'zzqx plorb');
  assert.equal(r.mode, 'hybrid');
  assert.equal(r.passages.length, 1);
  assert.equal(r.passages[0].memoryId, m);
  assert.deepEqual(r.passages[0].via, ['vec']);
  assert.match(r.passages[0].text, /quay/);
  await fake.close(); w.close();
});

test('scanChunks keeps the top-k by similarity, best first', async () => {
  const w = makeWorld();
  const o = addUser(w.db, { id: 'owner' });
  const model = 'm1';
  const near = addMemory(w.db, { by: o, title: 'a', content: 'near' });
  const mid = addMemory(w.db, { by: o, title: 'b', content: 'mid' });
  const far = addMemory(w.db, { by: o, title: 'c', content: 'far' });
  addChunk(w.db, far, 'far text', [0, 1, 0], model);
  addChunk(w.db, near, 'near text', [1, 0.05, 0], model);
  addChunk(w.db, mid, 'mid text', [1, 1, 0], model);
  const q = normalize([1, 0, 0]);
  const top1 = scanChunks(w.db, q, { uid: 'owner', model, limit: 1 });
  assert.deepEqual(top1.map((h) => [h.memoryId, h.text]), [[near, 'near text']]);
  const top2 = scanChunks(w.db, q, { uid: 'owner', model, limit: 2 });
  assert.deepEqual(top2.map((h) => h.memoryId), [near, mid]);
  assert.ok(top2[0].score > top2[1].score);
  w.close();
});

test('scanChunks enforces visibility in SQL, independent of the canView backstop', async () => {
  const w = makeWorld();
  const o = addUser(w.db, { id: 'owner' });
  addUser(w.db, { id: 'sarah', role: 'contributor' });
  const secret = addMemory(w.db, { by: o, title: 'Diary', content: 'secret', privacy: 'private' });
  addChunk(w.db, secret, 'secret text', [1, 0, 0], 'm1');
  const q = normalize([1, 0, 0]);
  assert.deepEqual(scanChunks(w.db, q, { uid: 'sarah', model: 'm1', limit: 5 }), []);
  assert.equal(scanChunks(w.db, q, { uid: 'owner', model: 'm1', limit: 5 }).length, 1);
  w.close();
});

test('scanChunks skips rows whose similarity is not finite', async () => {
  const w = makeWorld();
  const o = addUser(w.db, { id: 'owner' });
  const bad = addMemory(w.db, { by: o, title: 'bad', content: 'bad' });
  const good = addMemory(w.db, { by: o, title: 'good', content: 'good' });
  addChunk(w.db, good, 'good text', [1, 0, 0], 'm1');
  const nan = Buffer.alloc(12); nan.writeFloatLE(NaN, 0);
  w.db.prepare('INSERT INTO chunks (id, memory_id, ord, text, model, dim, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('c-nan', bad, 0, 'bad text', 'm1', 3, nan, new Date().toISOString());
  const hits = scanChunks(w.db, normalize([1, 0, 0]), { uid: 'owner', model: 'm1', limit: 5 });
  assert.deepEqual(hits.map((h) => h.memoryId), [good]);
  w.close();
});

test('reports keyword mode when no stored chunk belongs to the configured embedding model', async () => {
  const { fake, w, owner, add } = await world();
  const m = await add({ by: owner, title: 'Orchard', content: 'Forty apple trees in the orchard.' });
  assert.ok(w.db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n > 0);
  const switched = { ...w.config, ai: { ...w.config.ai, embedModel: 'a-newer-model' } };
  const r = await askAs({ ...w, config: switched }, 'owner', 'apple orchard');
  assert.equal(r.mode, 'keyword');
  assert.equal(r.degraded, false);
  assert.equal(r.passages[0].memoryId, m);
  assert.deepEqual(r.passages[0].via, ['fts']);
  await fake.close(); w.close();
});

test('a question without letters or digits makes no node call', async () => {
  const { fake, w } = await world();
  const r = await askAs(w, 'owner', '???');
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(r, { passages: [], degraded: false, mode: 'keyword' });
  await fake.close(); w.close();
});

test('ftsQuery keeps combining marks inside words and short non-ASCII words in "or" mode', () => {
  assert.equal(ftsQuery('ਉਹ ਪਿੰਡ ਵਿੱਚ', { mode: 'or' }), '"ਉਹ" OR "ਪਿੰਡ" OR "ਵਿੱਚ"');
  assert.equal(ftsQuery('ਉਹ ਪਿੰਡ', { mode: 'and' }), '"ਉਹ" "ਪਿੰਡ"*');
  assert.equal(ftsQuery('is it ok to go', { mode: 'or' }), null); // short ASCII words still dropped
});

test('keyword retrieval finds a memory by a Gurmukhi word with combining marks', async () => {
  const w = makeWorld();
  const o = addUser(w.db, { id: 'owner' });
  const m = addMemory(w.db, { by: o, title: 'ਪਿੰਡ', content: 'ਸਾਡਾ ਪਿੰਡ ਬਹੁਤ ਸੋਹਣਾ ਸੀ।' });
  addMemory(w.db, { by: o, title: 'Other', content: 'Nothing relevant here.' });
  const r = await askAs(w, 'owner', 'ਉਹ ਪਿੰਡ ਵਿੱਚ ਕੀ ਸੀ');
  assert.equal(r.passages[0].memoryId, m);
  assert.deepEqual(r.passages[0].via, ['fts']);
  w.close();
});
