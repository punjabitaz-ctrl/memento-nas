'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory } = require('./helpers/world');
const { makeEmbedHandler } = require('../src/ai/embed');
const { retrieve } = require('../src/ai/retrieve');
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
