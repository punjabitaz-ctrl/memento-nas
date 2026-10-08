'use strict';
const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld, addUser, addMemory, addMedia } = require('./helpers/world');
const { Client, memoryForm } = require('./helpers/http');
const { createApp } = require('../src/app');
const { makeEmbedHandler } = require('../src/ai/embed');
const { retrieve } = require('../src/ai/retrieve');
const { backfill } = require('../src/ai/backfill');
const { invalidateChunks } = require('../src/ai/hooks');
const { recomposeTranscript } = require('../src/ai/transcribe');

const audio = () => ({ data: crypto.randomBytes(800), type: 'audio/webm', name: 'rec.webm' });

const open = [];
// A failed assertion must not leave a server running (it would hang the test process).
afterEach(async () => { while (open.length) await open.pop().close(); });

/** A running app + world. `withNode:false` = local AI disabled (no nodes). */
async function boot({ withNode = true } = {}) {
  const realLog = console.log;
  console.log = () => {};
  const fake = withNode ? await startFakeNode() : null;
  const w = makeWorld({ nodes: withNode ? [nodeCfg(fake)] : [] });
  assert.equal(w.config.ai.enabled, withNode);
  const app = createApp({ config: w.config, db: w.db, clientDist: null, registry: withNode ? w.registry : null });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const c = new Client(`http://127.0.0.1:${server.address().port}`);
  const r = await c.json('POST', '/api/auth/setup', { json: { login: 'owner', displayName: 'Owner', password: 'correct horse battery' } });
  assert.equal(r.status, 201);
  const uid = w.db.prepare('SELECT id FROM users').get().id;
  const handle = {
    w, c, uid, fake,
    user: () => w.db.prepare('SELECT * FROM users WHERE id = ?').get(uid),
    embed: (id) => makeEmbedHandler(w)({ memory_id: id }),
    closed: false,
    async close() {
      if (handle.closed) return;
      handle.closed = true;
      await new Promise((res) => { server.closeAllConnections(); server.close(res); });
      if (fake) await fake.close();
      w.close();
      console.log = realLog;
    },
  };
  open.push(handle);
  return handle;
}

const chunkCount = (db, id) => db.prepare('SELECT COUNT(*) c FROM chunks WHERE memory_id = ?').get(id).c;
const seedChunk = (db, id) =>
  db.prepare("INSERT INTO chunks (id, memory_id, ord, text, model, dim, embedding, created_at) VALUES (?,?,0,'old',?,1,?,?)")
    .run(crypto.randomUUID(), id, 'e', Buffer.alloc(4), new Date().toISOString());
const jobsOf = (db, kind, id, status) => {
  const args = [kind, id];
  if (status) args.push(status);
  return db.prepare(`SELECT COUNT(*) c FROM ai_jobs WHERE kind = ? AND memory_id = ?${status ? ' AND status = ?' : ''}`).get(...args).c;
};
const ask = (t, question) => retrieve({ db: t.w.db, registry: t.w.registry, config: t.w.config, user: t.user(), question });
const allText = (r) => r.passages.map((p) => p.text).join('\n');

test('organize re-queues embedding: exactly one pending embed job', async () => {
  const t = await boot();
  const m = addMemory(t.w.db, { by: t.uid, title: 'Trip', content: 'We drove to Lisbon with Aunt Rose in 1994.' });
  assert.equal(jobsOf(t.w.db, 'embed', m), 0);
  const r = await t.c.json('POST', `/api/memories/${m}/organize`, { json: {} });
  assert.equal(r.status, 200);
  assert.equal(jobsOf(t.w.db, 'embed', m, 'pending'), 1);
  assert.equal(jobsOf(t.w.db, 'embed', m), 1);
  await t.close();
});

test('organize while an embed job is running: the changed memory ends up with a fresh pending job', async () => {
  const t = await boot();
  const m = addMemory(t.w.db, { by: t.uid, title: 'Trip', content: 'We drove to Lisbon with Aunt Rose in 1994.' });
  await t.c.json('POST', `/api/memories/${m}/organize`, { json: {} });
  // the first job "starts running" (no longer pending), then organize runs again and must queue a new one
  t.w.db.prepare("UPDATE ai_jobs SET status = 'running' WHERE memory_id = ?").run(m);
  await t.c.json('POST', `/api/memories/${m}/organize`, { json: {} });
  assert.equal(jobsOf(t.w.db, 'embed', m, 'pending'), 1);
  await t.close();
});

test('editing content: removed text is never retrieved, even before any re-embed job runs', async () => {
  const t = await boot();
  const create = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Harbour', content: 'We sailed at dawn. Uncle Basil kept a pet zeppelin in the barn.' }) });
  const id = create.data.memory.id;
  await t.embed(id);
  assert.ok(chunkCount(t.w.db, id) > 0);
  const before = await ask(t, 'pet zeppelin barn');
  assert.match(allText(before), /zeppelin/);

  const r = await t.c.json('PATCH', `/api/memories/${id}`, { json: { content: 'We sailed at dawn.' } });
  assert.equal(r.status, 200);
  assert.equal(chunkCount(t.w.db, id), 0, 'old chunks dropped in the same transaction');
  const after = await ask(t, 'pet zeppelin barn sailed dawn');
  assert.ok(after.passages.some((p) => p.memoryId === id), 'memory still found');
  assert.doesNotMatch(allText(after), /zeppelin/);
  assert.match(allText(after), /sailed at dawn/);
  await t.close();
});

test('editing title, description, transcript, story or privacy drops the chunks (AI disabled too); an unchanged save keeps them', async () => {
  const t = await boot({ withNode: false });
  const id = addMemory(t.w.db, { by: t.uid, title: 'T', content: 'body text here' });
  const patch = (json) => t.c.json('PATCH', `/api/memories/${id}`, { json });
  for (const body of [{ title: 'T2' }, { description: 'now with a description' }, { transcript: 'spoken words' }, { privacy: 'private' }, { content: 'other body' }]) {
    seedChunk(t.w.db, id);
    assert.equal((await patch(body)).status, 200);
    assert.equal(chunkCount(t.w.db, id), 0, `chunks dropped for ${Object.keys(body)[0]}`);
  }
  seedChunk(t.w.db, id);
  await patch({ content: 'other body', title: 'T2' }); // identical to what is stored
  assert.equal(chunkCount(t.w.db, id), 1, 'nothing about the text changed');
  await t.close();
});

test('organize drops chunks only when tags, people or location changed', async () => {
  const t = await boot({ withNode: false });
  const id = addMemory(t.w.db, { by: t.uid, title: 'Visit', content: 'Aunt Rose came to dinner in Boston.' });
  seedChunk(t.w.db, id);
  const tagsBefore = t.w.db.prepare('SELECT COUNT(*) c FROM memory_tags WHERE memory_id = ?').get(id).c;
  await t.c.json('POST', `/api/memories/${id}/organize`, { json: {} });
  const tagsAfter = t.w.db.prepare('SELECT COUNT(*) c FROM memory_tags WHERE memory_id = ?').get(id).c;
  assert.ok(tagsAfter > tagsBefore, 'the organizer added something');
  assert.equal(chunkCount(t.w.db, id), 0, 'first organize adds tags/people/location');
  seedChunk(t.w.db, id);
  await t.c.json('POST', `/api/memories/${id}/organize`, { json: {} });
  assert.equal(chunkCount(t.w.db, id), 1, 'second organize finds nothing new');
  await t.close();
});

test('POST media drops chunks', async () => {
  const t = await boot();
  const create = await t.c.json('POST', '/api/memories', { form: memoryForm({ title: 'Later', content: 'Some words.' }) });
  const id = create.data.memory.id;
  await t.embed(id);
  assert.ok(chunkCount(t.w.db, id) > 0);
  const r = await t.c.json('POST', `/api/memories/${id}/media`, { form: memoryForm({}, [audio()]) });
  assert.equal(r.status, 201);
  assert.equal(chunkCount(t.w.db, id), 0);
  await t.close();
});

test('DELETE media recomposes the transcript and invalidates chunks, so the deleted recording is never retrieved', async () => {
  const t = await boot();
  const m = addMemory(t.w.db, { by: t.uid, type: 'voice_note', title: 'Two tapes' });
  const a = addMedia(t.w, { memoryId: m });
  const b = addMedia(t.w, { memoryId: m });
  t.w.db.prepare("UPDATE media SET transcript = 'zebra crossing story', transcript_language = 'en' WHERE id = ?").run(a.id);
  t.w.db.prepare("UPDATE media SET transcript = 'walrus harbour story', transcript_language = 'en' WHERE id = ?").run(b.id);
  t.w.db.prepare("UPDATE memories SET transcript_source = '' WHERE id = ?").run(m);
  recomposeTranscript(t.w.db, m);
  await t.embed(m);
  assert.ok(chunkCount(t.w.db, m) > 0);
  assert.match(allText(await ask(t, 'zebra crossing')), /zebra/);

  const r = await t.c.json('DELETE', `/api/memories/${m}/media/${a.id}`);
  assert.equal(r.status, 200);
  assert.equal(chunkCount(t.w.db, m), 0);
  const after = await ask(t, 'zebra walrus story');
  assert.doesNotMatch(allText(after), /zebra/);
  assert.match(allText(after), /walrus/);
  await t.close();
});

test('recomposeTranscript invalidates chunks only when the text actually changes', () => {
  const w = makeWorld();
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, type: 'voice_note', title: 'Tape' });
  const a = addMedia(w, { memoryId: m });
  w.db.prepare("UPDATE media SET transcript = 'hello there' WHERE id = ?").run(a.id);
  seedChunk(w.db, m);
  recomposeTranscript(w.db, m);
  assert.equal(chunkCount(w.db, m), 0, 'transcript changed');
  seedChunk(w.db, m);
  recomposeTranscript(w.db, m);
  assert.equal(chunkCount(w.db, m), 1, 'same text: chunks stay');
  invalidateChunks(w.db, m);
  assert.equal(chunkCount(w.db, m), 0);
  w.close();
});

test('backfill re-queues memories whose chunks are older than the memory, and is idempotent afterwards', async () => {
  const t = await boot();
  const m = addMemory(t.w.db, { by: t.uid, title: 'Old chunks', content: 'The original wording.' });
  await t.embed(m);
  t.w.db.prepare('DELETE FROM ai_jobs').run();
  assert.deepEqual(backfill(t.w.db, t.w.config), { transcribe: 0, embed: 0 }, 'fresh chunks: nothing to do');

  // The memory changed after its chunks were written (e.g. edited before invalidation existed).
  t.w.db.prepare("UPDATE chunks SET created_at = '2000-01-01T00:00:00.000Z' WHERE memory_id = ?").run(m);
  assert.deepEqual(backfill(t.w.db, t.w.config), { transcribe: 0, embed: 1 });
  assert.deepEqual(backfill(t.w.db, t.w.config), { transcribe: 0, embed: 0 }, 'a pending job exists: idempotent');

  // once the job has run the chunks are fresh again and backfill stays quiet
  await t.embed(m);
  t.w.db.prepare("UPDATE ai_jobs SET status = 'done'").run();
  assert.deepEqual(backfill(t.w.db, t.w.config), { transcribe: 0, embed: 0 });
  await t.close();
});

test('backfill enqueues everything in one transaction: a failure part-way leaves no partial queue', async () => {
  const t = await boot();
  const ids = [1, 2, 3].map((i) => addMemory(t.w.db, { by: t.uid, title: `M${i}`, content: `text ${i}` }));
  let n = 0;
  t.w.db.function('boom_on_second', () => { if (++n === 2) throw new Error('disk full'); return 1; });
  t.w.db.exec('CREATE TRIGGER bf_fail BEFORE INSERT ON ai_jobs WHEN boom_on_second() = 0 BEGIN SELECT 1; END');
  assert.throws(() => backfill(t.w.db, t.w.config), /disk full/);
  assert.equal(t.w.db.prepare('SELECT COUNT(*) c FROM ai_jobs').get().c, 0);
  t.w.db.exec('DROP TRIGGER bf_fail');
  assert.equal(backfill(t.w.db, t.w.config).embed, ids.length);
  await t.close();
});

test('PATCH sending only an unchanged machine transcript keeps its source as machine', async () => {
  const t = await boot();
  const id = addMemory(t.w.db, { by: t.uid, type: 'voice_note', title: 'Tape' });
  t.w.db.prepare("UPDATE memories SET transcript = 'machine words', transcript_source = 'machine' WHERE id = ?").run(id);
  const r = await t.c.json('PATCH', `/api/memories/${id}`, { json: { transcript: 'machine words' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.memory.transcriptSource, 'machine');
  assert.equal(r.data.memory.transcript, 'machine words');
  await t.close();
});
