'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
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
  assert.ok(chunks.every((c) => c.length <= 40 * 3), 'chunks never exceed 3*maxTokens chars');
});

test('chunkText: a very long unbroken sentence is hard-split; empty input gives no chunks', () => {
  const input = 'word '.repeat(500).trim();
  const chunks = chunkText(input, 50);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 50 * 3), 'every chunk within 3*maxTokens');
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), input);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

const startsWithMark = (c) => /^\p{M}/u.test(c);
function assertSafeChunks(input, chunks, maxChars) {
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input, 'concatenation equals input');
  for (const c of chunks) {
    assert.equal(c, c.toWellFormed(), 'no lone surrogates');
    assert.ok(!startsWithMark(c), 'no chunk starts with a combining mark');
    assert.ok(c.length <= maxChars);
  }
}

test('chunkText: hard split never cuts a surrogate pair (emoji-only text)', () => {
  const input = '\u{1F600}'.repeat(300);
  assertSafeChunks(input, chunkText(input, 7), 21);
});

test('chunkText: hard split never separates a combining mark / matra from its base', () => {
  const dev = '\u0915\u093F'.repeat(80); // Devanagari KA + vowel sign I, no spaces
  assertSafeChunks(dev, chunkText(dev, 7), 21);
  const gur = '\u0A15\u0A3F'.repeat(80); // Gurmukhi KA + vowel sign I
  assertSafeChunks(gur, chunkText(gur, 7), 21);
  const combining = 'e\u0301'.repeat(80); // e + combining acute
  assertSafeChunks(combining, chunkText(combining, 7), 21);
});

test('chunkText: splits CJK text after full-width sentence marks even without whitespace', () => {
  const sentence = '\u6628\u65E5\u306F\u53CB\u9054\u3068\u516C\u5712\u3078\u884C\u304D\u307E\u3057\u305F\u3002';
  const input = sentence.repeat(60);
  const chunks = chunkText(input, 20);
  assert.ok(chunks.length > 5);
  for (const c of chunks) {
    assert.ok(c.endsWith('\u3002'), 'chunk ends at a sentence mark');
    assert.ok(c.length <= 20 * 3);
  }
  assert.equal(chunks.join('').replace(/\s+/g, ''), input);
  const q = chunkText('\u4F60\u597D\u5417\uFF1F\u6211\u5F88\u597D\uFF01\u8C22\u8C22\u3002', 2);
  assert.deepEqual(q, ['\u4F60\u597D\u5417\uFF1F', '\u6211\u5F88\u597D\uFF01', '\u8C22\u8C22\u3002']);
  assert.deepEqual(chunkText('a\u0965 b', 1), ['a\u0965', 'b'], 'double danda ends a sentence');
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

const chunkCount = (w, m) => w.db.prepare('SELECT COUNT(*) c FROM chunks WHERE memory_id = ?').get(m).c;
const LONG = 'A fairly long sentence about the harvest festival. '.repeat(400);

test('batches: dimension mismatch across batches is rejected and old chunks stay', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Long', content: LONG });
  await makeEmbedHandler(w)(jobFor(m));
  const n = chunkCount(w, m);
  assert.ok(n > 16);
  let k = 0;
  fake.state.embed = () => (k++ < 16 ? [1, 0, 0] : [1, 0]);
  await assert.rejects(makeEmbedHandler(w)(jobFor(m)), /dimension/);
  assert.equal(chunkCount(w, m), n, 'old chunks untouched on failure');
  await fake.close(); w.close();
});

test('privacy is re-read before every batch: a memory flipped to private mid-flight never reaches the node again', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Long', content: LONG });
  await makeEmbedHandler(w)(jobFor(m));
  const n = chunkCount(w, m);
  assert.ok(n > 16);
  const before = w.db.prepare('SELECT id FROM chunks WHERE memory_id = ? ORDER BY ord').all(m).map((r) => r.id);
  fake.calls.length = 0;
  let k = 0;
  fake.state.embed = (t) => {
    if (k++ === 0) w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(m);
    return [1, 0, 0];
  };
  await assert.rejects(makeEmbedHandler(w)(jobFor(m)), NoEligibleNode);
  assert.equal(fake.calls.length, 1, 'batch 2 never reached the non-local node');
  const after = w.db.prepare('SELECT id FROM chunks WHERE memory_id = ? ORDER BY ord').all(m).map((r) => r.id);
  assert.deepEqual(after, before, 'old chunks untouched');
  await fake.close(); w.close();
});

test('a memory edited while embedding is not committed (a fresh embed job is queued by the edit)', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'T', content: 'first version' });
  await makeEmbedHandler(w)(jobFor(m));
  const before = w.db.prepare('SELECT id, text FROM chunks WHERE memory_id = ?').all(m);
  let k = 0;
  fake.state.embed = () => {
    if (k++ === 0) w.db.prepare("UPDATE memories SET content = 'edited', updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(m);
    return [1, 0, 0];
  };
  assert.deepEqual(await makeEmbedHandler(w)(jobFor(m)), { skip: 'memory changed while embedding' });
  assert.deepEqual(w.db.prepare('SELECT id, text FROM chunks WHERE memory_id = ?').all(m), before);
  await fake.close(); w.close();
});

test('a memory deleted while embedding is skipped without throwing', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Long', content: LONG });
  let k = 0;
  fake.state.embed = () => {
    if (k++ === 0) w.db.prepare('DELETE FROM memories WHERE id = ?').run(m);
    return [1, 0, 0];
  };
  assert.deepEqual(await makeEmbedHandler(w)(jobFor(m)), { skip: 'memory no longer exists' });
  assert.equal(chunkCount(w, m), 0);
  await fake.close(); w.close();
});

test('non-finite or all-zero vectors fail the job and leave old chunks alone', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'T', content: 'some text' });
  await makeEmbedHandler(w)(jobFor(m));
  const before = w.db.prepare('SELECT id FROM chunks WHERE memory_id = ?').all(m);
  const withVec = (vec) => makeEmbedHandler({ ...w, client: { embed: async (_node, batch) => batch.map(() => vec) } });
  await assert.rejects(withVec([1, NaN, 0])(jobFor(m)), /non-finite/);
  await assert.rejects(withVec([1, Infinity])(jobFor(m)), /non-finite/);
  await assert.rejects(withVec([0, 0, 0])(jobFor(m)), /all zeros/);
  assert.deepEqual(w.db.prepare('SELECT id FROM chunks WHERE memory_id = ?').all(m), before);
  await fake.close(); w.close();
});

test('private memories are never embedded on a non-local node', async () => {
  const fake = await startFakeNode();
  const { w, u } = setup([nodeCfg(fake)]);
  const m = addMemory(w.db, { by: u, title: 'Secret', content: 'only for me', privacy: 'private' });
  await assert.rejects(makeEmbedHandler(w)(jobFor(m)), NoEligibleNode);
  assert.equal(fake.calls.length, 0);
  await fake.close(); w.close();
});
