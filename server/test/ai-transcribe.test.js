'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory, addMedia } = require('./helpers/world');
const { makeTranscribeHandler, recomposeTranscript } = require('../src/ai/transcribe');
const { NoEligibleNode } = require('../src/ai/errors');
const { hydrate } = require('../src/memories');

const job = (memoryId, mediaId) => ({ id: 'j', kind: 'transcribe', memory_id: memoryId, media_id: mediaId });
const mem = (db, id) => db.prepare('SELECT transcript, transcript_source, transcript_languages FROM memories WHERE id = ?').get(id);

test('transcribes a family recording, indexes the text and queues embedding; audio reaches the node, not the disk', async () => {
  const fake = await startFakeNode({
    transcribe: () => ({ text: 'Grandpa told us about the apple orchard', language: 'en', segments: [{ start: 0, end: 2, text: 'Grandpa told us about the apple orchard' }] }),
  });
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note', title: 'Orchard' });
  const f = addMedia(w, { memoryId: m });
  await makeTranscribeHandler(w)(job(m, f.id));

  assert.deepEqual(mem(w.db, m), { transcript: 'Grandpa told us about the apple orchard', transcript_source: 'machine', transcript_languages: '["en"]' });
  assert.deepEqual(w.db.prepare("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH 'orchard'").all().map((r) => r.memory_id), [m]);
  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM ai_jobs WHERE kind='embed' AND memory_id=?").get(m).c, 1);
  assert.ok(fake.calls[0].body.includes(f.data), 'decrypted audio was streamed to the node');
  assert.deepEqual(fs.readdirSync(w.config.dirs.tmp), [], 'no temp files');
  assert.ok(fs.readdirSync(w.config.dirs.vault).every((n) => n.endsWith('.enc')), 'vault holds only .enc files');
  await fake.close(); w.close();
});

test('multiple recordings are joined in upload order (by rowid); languages are de-duplicated', async () => {
  let n = 0;
  const texts = [['first part', 'pa'], ['second part', 'en'], ['third part', 'pa']];
  const fake = await startFakeNode({ transcribe: () => { const [text, language] = texts[n++]; return { text, language, segments: [] }; } });
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  const files = [addMedia(w, { memoryId: m }), addMedia(w, { memoryId: m }), addMedia(w, { memoryId: m })];
  const handler = makeTranscribeHandler(w);
  for (const f of files) await handler(job(m, f.id));
  const row = mem(w.db, m);
  assert.equal(row.transcript, 'first part\n\nsecond part\n\nthird part');
  assert.equal(row.transcript_languages, '["pa","en"]');
  await fake.close(); w.close();
});

test('a transcript written by a person is never overwritten, and the node is not even called', async () => {
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note', transcript: 'my careful correction' });
  const f = addMedia(w, { memoryId: m });
  assert.deepEqual(await makeTranscribeHandler(w)(job(m, f.id)), { skip: 'transcript was written by a person' });
  assert.equal(mem(w.db, m).transcript, 'my careful correction');
  assert.equal(fake.calls.length, 0);
  await fake.close(); w.close();
});

test('private recordings never reach a non-local node; a local node may transcribe them', async () => {
  const remote = await startFakeNode();
  const local = await startFakeNode({ transcribe: () => ({ text: 'private words', language: 'en', segments: [] }) });
  const w1 = makeWorld({ nodes: [nodeCfg(remote)] });
  const u = addUser(w1.db);
  const m = addMemory(w1.db, { by: u, type: 'voice_note', privacy: 'private' });
  const f = addMedia(w1, { memoryId: m });
  await assert.rejects(makeTranscribeHandler(w1)(job(m, f.id)), NoEligibleNode);
  assert.equal(remote.calls.length, 0);
  w1.close();

  const w2 = makeWorld({ nodes: [nodeCfg(remote), nodeCfg(local, { name: 'nas', local: true, priority: 50 })] });
  const u2 = addUser(w2.db);
  const m2 = addMemory(w2.db, { by: u2, type: 'voice_note', privacy: 'private' });
  const f2 = addMedia(w2, { memoryId: m2 });
  await makeTranscribeHandler(w2)(job(m2, f2.id));
  assert.equal(mem(w2.db, m2).transcript, 'private words');
  assert.equal(remote.calls.length, 0, 'still nothing on the remote node');
  w2.close(); await remote.close(); await local.close();
});

test('fails over to the next node; skips deleted media and non-audio media', async () => {
  const bad = await startFakeNode({ failStatus: 500 });
  const good = await startFakeNode({ transcribe: () => ({ text: 'from the second node', language: 'en', segments: [] }) });
  const w = makeWorld({ nodes: [nodeCfg(bad, { name: 'a', priority: 1 }), nodeCfg(good, { name: 'b', priority: 2 })] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  const f = addMedia(w, { memoryId: m });
  const photo = addMedia(w, { memoryId: m, kind: 'image', mime: 'image/png' });
  const h = makeTranscribeHandler(w);
  await h(job(m, f.id));
  assert.equal(mem(w.db, m).transcript, 'from the second node');
  assert.deepEqual(await h(job(m, 'does-not-exist')), { skip: 'file no longer exists' });
  assert.deepEqual(await h(job(m, photo.id)), { skip: 'not audio or video' });
  await bad.close(); await good.close(); w.close();
});

test('recomposeTranscript clears machine text when no media transcript remains', async () => {
  const w = makeWorld();
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  const f = addMedia(w, { memoryId: m });
  w.db.prepare("UPDATE media SET transcript='abc', transcript_language='en' WHERE id=?").run(f.id);
  recomposeTranscript(w.db, m);
  assert.equal(mem(w.db, m).transcript, 'abc');
  w.db.prepare("UPDATE media SET transcript='' WHERE id=?").run(f.id);
  recomposeTranscript(w.db, m);
  assert.deepEqual(mem(w.db, m), { transcript: '', transcript_source: '', transcript_languages: '[]' });
  w.close();
});

test('hydrate exposes transcript source, languages and job status', () => {
  const w = makeWorld();
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  const row = () => hydrate(w.db, [w.db.prepare('SELECT * FROM memories WHERE id=?').get(m)])[0];
  assert.deepEqual([row().transcriptSource, row().transcriptJob], ['', null]);
  require('../src/ai/jobs').enqueue(w.db, { kind: 'transcribe', memoryId: m, mediaId: 'f', key: 'k' });
  assert.equal(row().transcriptJob, 'pending');
  w.db.prepare("UPDATE ai_jobs SET status='failed'").run();
  assert.equal(row().transcriptJob, 'failed');
  w.db.prepare("UPDATE memories SET transcript='hi', transcript_source='machine', transcript_languages='[\"en\"]' WHERE id=?").run(m);
  assert.deepEqual([row().transcriptSource, row().transcriptLanguages, row().transcriptJob], ['machine', ['en'], null]);
  w.close();
});

test('a recording whose vault file is missing is skipped, not retried, and the path is not leaked', async () => {
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  const f = addMedia(w, { memoryId: m });
  fs.unlinkSync(require('../src/uploads').vaultPath(w.config, f.id));
  assert.deepEqual(await makeTranscribeHandler(w)(job(m, f.id)), { skip: 'file missing from the vault' });
  assert.equal(fake.calls.length, 0);
  await fake.close(); w.close();
});
