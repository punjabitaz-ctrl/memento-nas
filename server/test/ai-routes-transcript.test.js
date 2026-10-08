'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory, addMedia } = require('./helpers/world');
const { Client, memoryForm } = require('./helpers/http');
const { createApp } = require('../src/app');
const { vaultPath } = require('../src/uploads');
const { queueEmbed, queueTranscribe, onMemorySaved, memoryText } = require('../src/ai/hooks');
const { recomposeTranscript } = require('../src/ai/transcribe');

const audio = () => ({ data: crypto.randomBytes(800), type: 'audio/webm', name: 'rec.webm' });

async function boot() {
  const realLog = console.log;
  console.log = () => {}; // the app logs one line per request
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  assert.equal(w.config.ai.enabled, true);
  const app = createApp({ config: w.config, db: w.db, clientDist: null });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const c = new Client(`http://127.0.0.1:${server.address().port}`);
  const r = await c.json('POST', '/api/auth/setup', { json: { login: 'owner', displayName: 'Owner', password: 'correct horse battery' } });
  assert.equal(r.status, 201);
  return {
    w, c,
    async close() {
      await new Promise((res) => { server.closeAllConnections(); server.close(res); });
      await fake.close();
      w.close();
      console.log = realLog;
    },
  };
}

/** Makes every enqueue fail while leaving the table readable (hydrate still reads job state). */
const rejectEnqueue = (db) => db.exec("CREATE TRIGGER no_enqueue BEFORE INSERT ON ai_jobs BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END");
const row = (db, id) => db.prepare('SELECT transcript, transcript_source FROM memories WHERE id = ?').get(id);
const jobs = (db, kind, id) => db.prepare('SELECT COUNT(*) c FROM ai_jobs WHERE kind = ? AND memory_id = ?').get(kind, id).c;

test('create: a typed transcript is marked human, none is marked empty; audio queues one transcribe and one embed job', async () => {
  const t = await boot();
  let r = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'With words', transcript: 'typed by hand' }) });
  assert.equal(r.status, 201);
  assert.deepEqual(row(t.w.db, r.data.memory.id), { transcript: 'typed by hand', transcript_source: 'human' });
  assert.equal(r.data.memory.transcriptSource, 'human');

  r = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'No words' }) });
  assert.equal(row(t.w.db, r.data.memory.id).transcript_source, '');

  r = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Recording' }, [audio()]) });
  assert.equal(r.status, 201);
  const id = r.data.memory.id;
  assert.equal(row(t.w.db, id).transcript_source, '');
  assert.equal(jobs(t.w.db, 'transcribe', id), 1);
  assert.equal(jobs(t.w.db, 'embed', id), 1);
  await t.close();
});

test('PATCH transcript-source matrix', async () => {
  const t = await boot();
  const create = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Matrix' }) });
  const id = create.data.memory.id;
  const patch = (json) => t.c.json('PATCH', `/api/memories/${id}`, { json });

  // changed, non-empty -> human
  const r = await patch({ transcript: 'first words' });
  assert.equal(r.status, 200);
  assert.deepEqual(row(t.w.db, id), { transcript: 'first words', transcript_source: 'human' });

  // cleared -> ''
  await patch({ transcript: '' });
  assert.deepEqual(row(t.w.db, id), { transcript: '', transcript_source: '' });

  // sent unchanged -> source preserved (set to machine directly in the DB)
  t.w.db.prepare("UPDATE memories SET transcript = 'machine text', transcript_source = 'machine' WHERE id = ?").run(id);
  await patch({ transcript: 'machine text', title: 'Renamed' });
  assert.deepEqual(row(t.w.db, id), { transcript: 'machine text', transcript_source: 'machine' });

  // field absent -> unchanged
  await patch({ title: 'Renamed again' });
  assert.deepEqual(row(t.w.db, id), { transcript: 'machine text', transcript_source: 'machine' });

  // a person editing the machine text takes ownership
  await patch({ transcript: 'machine text, corrected' });
  assert.deepEqual(row(t.w.db, id), { transcript: 'machine text, corrected', transcript_source: 'human' });
  await t.close();
});

test('adding a recording to an existing memory queues a transcribe job for it', async () => {
  const t = await boot();
  const create = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Later' }) });
  const id = create.data.memory.id;
  assert.equal(jobs(t.w.db, 'transcribe', id), 0);
  const r = await t.c.json('POST', `/api/memories/${id}/media`, { form: memoryForm({}, [audio()]) });
  assert.equal(r.status, 201);
  const mediaId = t.w.db.prepare('SELECT id FROM media WHERE memory_id = ?').get(id).id;
  const q = t.w.db.prepare("SELECT media_id FROM ai_jobs WHERE kind = 'transcribe' AND memory_id = ?").all(id);
  assert.deepEqual(q.map((x) => x.media_id), [mediaId]);
  await t.close();
});

test('deleting a recording removes its machine transcript from the memory and the search index', async () => {
  const t = await boot();
  const uid = t.w.db.prepare('SELECT id FROM users').get().id;
  const m = addMemory(t.w.db, { by: uid, type: 'voice_note', title: 'Two tapes' });
  const a = addMedia(t.w, { memoryId: m });
  const b = addMedia(t.w, { memoryId: m });
  t.w.db.prepare("UPDATE media SET transcript = 'zebra crossing story', transcript_language = 'en' WHERE id = ?").run(a.id);
  t.w.db.prepare("UPDATE media SET transcript = 'walrus harbour story', transcript_language = 'en' WHERE id = ?").run(b.id);
  recomposeTranscript(t.w.db, m);
  const hits = (q) => t.w.db.prepare('SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?').all(q).map((x) => x.memory_id);
  assert.deepEqual(hits('zebra'), [m]);
  assert.equal(row(t.w.db, m).transcript, 'zebra crossing story\n\nwalrus harbour story');

  const r = await t.c.json('DELETE', `/api/memories/${m}/media/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(row(t.w.db, m).transcript, 'walrus harbour story');
  assert.deepEqual(hits('zebra'), []);
  assert.deepEqual(hits('walrus'), [m]);
  assert.equal(jobs(t.w.db, 'embed', m), 1, 'embedding is re-queued');
  await t.close();
});

test('deleting a recording leaves a human-written transcript alone', async () => {
  const t = await boot();
  const uid = t.w.db.prepare('SELECT id FROM users').get().id;
  const m = addMemory(t.w.db, { by: uid, type: 'voice_note', transcript: 'my own words' });
  const a = addMedia(t.w, { memoryId: m });
  t.w.db.prepare("UPDATE media SET transcript = 'machine words' WHERE id = ?").run(a.id);
  await t.c.json('DELETE', `/api/memories/${m}/media/${a.id}`);
  assert.deepEqual(row(t.w.db, m), { transcript: 'my own words', transcript_source: 'human' });
  await t.close();
});

test('hooks: queueEmbed does not double-queue and ignores empty memories', () => {
  const w = makeWorld();
  const u = addUser(w.db);
  const empty = addMemory(w.db, { by: u });
  assert.equal(queueEmbed(w.db, empty), false);
  assert.equal(queueEmbed(w.db, 'nope'), false);
  const m = addMemory(w.db, { by: u, title: 'Has text' });
  assert.equal(queueEmbed(w.db, m), true);
  assert.equal(queueEmbed(w.db, m), false, 'one is already pending');
  assert.equal(jobs(w.db, 'embed', m), 1);
  w.close();
});

test('hooks: queueTranscribe is idempotent per media unless forced', () => {
  const w = makeWorld();
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note' });
  addMedia(w, { memoryId: m });
  addMedia(w, { memoryId: m, kind: 'image', mime: 'image/png' });
  assert.equal(queueTranscribe(w.db, m), 1, 'only the audio file');
  assert.equal(queueTranscribe(w.db, m), 0);
  assert.equal(jobs(w.db, 'transcribe', m), 1);
  assert.equal(queueTranscribe(w.db, m, { force: true }), 1);
  assert.equal(jobs(w.db, 'transcribe', m), 2);
  w.close();
});

test('hooks: memoryText joins non-empty fields with blank lines', () => {
  assert.equal(memoryText({ title: 'T', description: '  ', content: 'C', transcript: 'X' }), 'T\n\nC\n\nX');
  assert.equal(memoryText({ title: '', description: '', content: '', transcript: '' }), '');
});

test('hooks: onMemorySaved is best-effort - a queueing failure is logged (message only) and swallowed', async (t) => {
  const fake = await startFakeNode();
  const w = makeWorld({ nodes: [nodeCfg(fake)] });
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note', title: 'secret user text' });
  addMedia(w, { memoryId: m });
  rejectEnqueue(w.db);
  const warn = t.mock.method(console, 'warn', () => {});
  assert.doesNotThrow(() => onMemorySaved(w.db, w.config, m));
  assert.equal(warn.mock.callCount(), 1);
  const args = warn.mock.calls[0].arguments;
  assert.equal(args[0], '[ai] could not queue AI work:');
  assert.ok(!args.join(' ').includes('secret user text'));
  warn.mock.restore();
  await fake.close();
  w.close();
});

test('create route: a queueing failure does not turn a committed save into an error or delete its files', async (t) => {
  const tt = await boot();
  rejectEnqueue(tt.w.db);
  const warn = t.mock.method(console, 'warn', () => {});
  const r = await tt.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Survives' }, [audio()]) });
  warn.mock.restore();
  assert.equal(r.status, 201);
  const mediaId = tt.w.db.prepare('SELECT id FROM media WHERE memory_id = ?').get(r.data.memory.id).id;
  assert.ok(fs.existsSync(vaultPath(tt.w.config, mediaId)));
  await tt.close();
});
