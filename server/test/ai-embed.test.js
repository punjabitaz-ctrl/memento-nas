'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg, fakeEmbed } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory } = require('./helpers/world');
const { chunkText, toBlob, normalize, makeEmbedHandler } = require('../src/ai/embed');
const { NoEligibleNode } = require('../src/ai/errors');

test('chunkText: short text is one chunk; long text splits on sentences within the limit', () => {
  assert.deepEqual(chunkText('One short story.'), ['One short story.']);
  const sentence = 'The family walked to the orchard every autumn. ';
  const chunks = chunkText(sentence.repeat(40), 60);
  assert.ok(chunks.length > 3);
  for (const c of chunks) assert.ok(c.length <= 60 * 3, `chunk too long: ${c.length}`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), sentence.repeat(40).replace(/\s+/g, ' ').trim());
});

test('chunkText: splits on the Devanagari/Gurmukhi danda and Urdu full stop', () => {
  const t = 'ਉਹ ਪਿੰਡ ਵਿੱਚ ਰਹਿੰਦੇ ਸਨ। ' + 'ਫਿਰ ਉਹ ਸ਼ਹਿਰ ਚਲੇ ਗਏ। '.repeat(30) + 'وہ گاؤں میں رہتے تھے۔ ' .repeat(30);
  const chunks = chunkText(t, 40);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.length <= 40 * 3 + 40));
});

test('chunkText: a very long unbroken sentence is hard-split; empty input gives no chunks', () => {
  const chunks = chunkText('word '.repeat(500).trim(), 50);
  assert.ok(chunks.length > 5);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('toBlob stores a unit-length float32 vector', () => {
  const b = toBlob([3, 4]);
  assert.equal(b.length, 8);
  assert.ok(Math.abs(b.readFloatLE(0) - 0.6) < 1e-6 && Math.abs(b.readFloatLE(4) - 0.8) < 1e-6);
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});

function setup(nodes) {
  const w = makeWorld({ nodes });
  const u = addUser(w.db, { name: 'Sarah' });
  return { w, u };
}
const jobFor = (memoryId) => ({ id: 'j', kind: 'embed', memory_id: memoryId });

test('embeds a memory: header context goes to the node, raw chunk text and unit vectors are stored', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Apple orchard', content: 'Grandpa planted forty apple trees. They bloomed every spring.', date: '1962-06-01' });
  w.db.prepare("INSERT INTO memory_people (memory_id, name) VALUES (?, 'Grandpa William')").run(m);
  await makeEmbedHandler(w)(jobFor(m));

  const rows = w.db.prepare('SELECT * FROM chunks WHERE memory_id = ? ORDER BY ord').all(m);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'e');
  assert.equal(rows[0].dim, 64);
  assert.ok(rows[0].text.includes('forty apple trees') && !rows[0].text.includes('Sarah'), 'stored text is the raw chunk, no header');
  const sent = JSON.parse(fake.calls[0].body.toString()).input[0];
  assert.match(sent, /^Apple orchard \| 1962-06-01 \| by Sarah \| people: Grandpa William\n/);
  let norm = 0;
  for (let i = 0; i < 64; i++) norm += rows[0].embedding.readFloatLE(i * 4) ** 2;
  assert.ok(Math.abs(norm - 1) < 1e-4);
  await fake.close(); w.close();
});

test('re-running replaces the old chunks; a memory with no text clears them', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'T', content: 'first version' });
  const h = makeEmbedHandler(w);
  await h(jobFor(m));
  w.db.prepare("UPDATE memories SET content='second version, rewritten' WHERE id=?").run(m);
  await h(jobFor(m));
  const rows = w.db.prepare('SELECT text FROM chunks WHERE memory_id = ?').all(m);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].text.includes('second version'));
  w.db.prepare("UPDATE memories SET title='', content='' WHERE id=?").run(m);
  await h(jobFor(m));
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM chunks').get().c, 0);
  assert.deepEqual(await h(jobFor('gone')), { skip: 'memory no longer exists' });
  await fake.close(); w.close();
});

test('batches requests (16 chunks each) and rejects dimension mismatches', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Long', content: 'A fairly long sentence about the harvest festival. '.repeat(400) });
  await makeEmbedHandler(w)(jobFor(m));
  const n = w.db.prepare('SELECT COUNT(*) c FROM chunks WHERE memory_id = ?').get(m).c;
  assert.ok(n > 16);
  assert.equal(fake.calls.length, Math.ceil(n / 16));
  let k = 0;
  fake.state.embed = () => (k++ === 0 ? [1, 0, 0] : [1, 0]);
  await assert.rejects(makeEmbedHandler(w)(jobFor(m)), /dimension/);
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM chunks WHERE memory_id = ?').get(m).c, n, 'old chunks untouched on failure');
  await fake.close(); w.close();
});

test('private memories are never embedded on a non-local node', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Secret', content: 'only for me', privacy: 'private' });
  await assert.rejects(makeEmbedHandler(w)(jobFor(m)), NoEligibleNode);
  assert.equal(fake.calls.length, 0);
  assert.ok(fakeEmbed('x').length === 64);
  await fake.close(); w.close();
});
