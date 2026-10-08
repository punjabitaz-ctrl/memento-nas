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

// ---- Fix wave A: a memory made private WHILE a transcription runs --------------------------------

const http = require('node:http');
const crypto = require('node:crypto');
const jobs = require('../src/ai/jobs');
const { createWorker } = require('../src/ai/worker');

/** A bare http server the test controls completely. */
function rawNode(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  })));
}

test('reviewer race: node A fails AFTER the memory turned private => non-local B gets ZERO requests, local C is used', async () => {
  let w;
  let memoryId;
  let aCalls = 0;
  const a = await rawNode((req, res) => {
    aCalls += 1;
    req.resume();
    req.on('end', () => {
      // The owner makes the memory private while node A is still working on it ...
      w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(memoryId);
      // ... and then node A falls over, so the registry fails over.
      res.writeHead(500);
      res.end('{}');
    });
  });
  const b = await startFakeNode({ transcribe: () => ({ text: 'LEAKED VIA B', language: 'en', segments: [] }) });
  const c = await startFakeNode({ transcribe: () => ({ text: 'from the local node', language: 'en', segments: [] }) });
  w = makeWorld({ nodes: [
    nodeCfg(a, { name: 'a', priority: 1 }),
    nodeCfg(b, { name: 'b', priority: 2 }),
    nodeCfg(c, { name: 'c', priority: 3, local: true }),
  ] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const f = addMedia(w, { memoryId });
  await makeTranscribeHandler(w)(job(memoryId, f.id));
  assert.equal(aCalls, 1);
  assert.equal(b.calls.length, 0, 'the non-local node B never received the now-private recording');
  assert.equal(c.calls.length, 1, 'the local node C may still transcribe it');
  assert.equal(mem(w.db, memoryId).transcript, 'from the local node');
  await a.close(); await b.close(); await c.close(); w.close();
});

test('reviewer race without a local node: failover stops, nothing reaches B, the job is skipped as not eligible', async () => {
  let w;
  let memoryId;
  const a = await rawNode((req) => {
    req.resume();
    req.on('end', () => {
      w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(memoryId);
      req.socket.destroy(); // node A drops the connection
    });
  });
  const b = await startFakeNode();
  w = makeWorld({ nodes: [nodeCfg(a, { name: 'a', priority: 1 }), nodeCfg(b, { name: 'b', priority: 2 })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const f = addMedia(w, { memoryId });
  await assert.rejects(makeTranscribeHandler(w)(job(memoryId, f.id)), NoEligibleNode);
  assert.equal(b.calls.length, 0);
  assert.equal(mem(w.db, memoryId).transcript, '');
  await a.close(); await b.close(); w.close();
});

test('privacy flips mid-upload to a slow non-local node => upload aborted, job skipped, transcript unchanged', async () => {
  let w;
  let memoryId;
  let received = 0;
  let ended = false;
  let flipped = false;
  let serverSawClose;
  const closed = new Promise((r) => { serverSawClose = r; });
  const slow = await rawNode((req, res) => {
    req.on('data', (d) => {
      received += d.length;
      if (!flipped) {
        flipped = true;
        req.pause(); // a slow node: reads a little, then stalls while the owner changes the privacy
        w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(memoryId);
        setTimeout(() => req.resume(), 50);
      }
    });
    req.on('end', () => {
      ended = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'LEAKED TRANSCRIPT', language: 'en', segments: [] }));
    });
    req.on('close', () => serverSawClose());
  });
  w = makeWorld({ nodes: [nodeCfg(slow, { name: 'slow' })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const size = 12 * 1024 * 1024;
  const f = addMedia(w, { memoryId, data: crypto.randomBytes(size) });
  jobs.enqueue(w.db, { kind: 'transcribe', memoryId, mediaId: f.id, key: `t-${f.id}` });
  const handler = makeTranscribeHandler({ ...w, privacyCheckBytes: 64 * 1024 });
  const worker = createWorker({ db: w.db, handlers: { transcribe: handler }, log: { warn() {} } });
  assert.equal(await worker.tick(), true);
  await closed;
  const row = w.db.prepare("SELECT status, last_error FROM ai_jobs WHERE kind = 'transcribe' AND media_id = ?").get(f.id);
  assert.deepEqual({ ...row }, { status: 'skipped', last_error: 'memory became private while transcribing' });
  assert.equal(ended, false, 'the node never received the whole recording');
  assert.ok(received < size, `upload was cut short (${received} of ${size} bytes)`);
  assert.deepEqual(mem(w.db, memoryId), { transcript: '', transcript_source: '', transcript_languages: '[]' });
  assert.equal(w.db.prepare('SELECT transcript FROM media WHERE id = ?').get(f.id).transcript, '');
  await slow.close(); w.close();
});

test('a LOCAL node keeps transcribing when the memory turns private mid-upload', async () => {
  let w;
  let memoryId;
  let flipped = false;
  const local = await rawNode((req, res) => {
    req.on('data', () => {
      if (!flipped) { flipped = true; w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(memoryId); }
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'kept local', language: 'en', segments: [] }));
    });
  });
  w = makeWorld({ nodes: [nodeCfg(local, { name: 'nas', local: true })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const f = addMedia(w, { memoryId, data: crypto.randomBytes(1024 * 1024) });
  await makeTranscribeHandler({ ...w, privacyCheckBytes: 64 * 1024 })(job(memoryId, f.id));
  assert.equal(mem(w.db, memoryId).transcript, 'kept local');
  await local.close(); w.close();
});

// ---- Fix wave D: an aborted upload does not condemn the node, and a local node can take over -------

/** A remote node that stalls after the first bytes while the owner makes the memory private. */
function stallingRemote(getWorld, getMemoryId, seen) {
  return rawNode((req, res) => {
    req.on('data', (d) => {
      seen.received += d.length;
      if (!seen.flipped) {
        seen.flipped = true;
        req.pause();
        getWorld().db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(getMemoryId());
        setTimeout(() => req.resume(), 50);
      }
    });
    req.on('end', () => {
      seen.ended = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'LEAKED TRANSCRIPT', language: 'en', segments: [] }));
    });
  });
}
const nodeNamed = (w, name) => w.registry.nodes.find((n) => n.name === name);

test('mid-upload privacy flip to remote A: A is aborted but stays healthy, and local node C transcribes the recording', async () => {
  let w; let memoryId;
  const seen = { received: 0, flipped: false, ended: false };
  const a = await stallingRemote(() => w, () => memoryId, seen);
  const c = await startFakeNode({ transcribe: () => ({ text: 'from the local node', language: 'en', segments: [] }) });
  w = makeWorld({ nodes: [nodeCfg(a, { name: 'a', priority: 1 }), nodeCfg(c, { name: 'c', priority: 2, local: true })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const size = 2 * 1024 * 1024;
  const f = addMedia(w, { memoryId, data: crypto.randomBytes(size) });
  const out = await makeTranscribeHandler({ ...w, privacyCheckBytes: 64 * 1024 })(job(memoryId, f.id));
  assert.equal(out, undefined, 'not skipped: the job completed on the local node');
  assert.equal(seen.ended, false, 'A never received the whole recording');
  assert.ok(seen.received < size);
  assert.equal(nodeNamed(w, 'a').healthy, true, 'an aborted upload is not a node failure');
  assert.equal(c.calls.length, 1);
  assert.equal(mem(w.db, memoryId).transcript, 'from the local node');
  await a.close(); await c.close(); w.close();
});

test('mid-upload privacy flip with NO local node: the job is skipped as before and A stays healthy', async () => {
  let w; let memoryId;
  const seen = { received: 0, flipped: false, ended: false };
  const a = await stallingRemote(() => w, () => memoryId, seen);
  const b = await startFakeNode({ transcribe: () => ({ text: 'LEAKED VIA B', language: 'en', segments: [] }) });
  w = makeWorld({ nodes: [nodeCfg(a, { name: 'a', priority: 1 }), nodeCfg(b, { name: 'b', priority: 2 })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const f = addMedia(w, { memoryId, data: crypto.randomBytes(2 * 1024 * 1024) });
  const out = await makeTranscribeHandler({ ...w, privacyCheckBytes: 64 * 1024 })(job(memoryId, f.id));
  assert.deepEqual(out, { skip: 'memory became private while transcribing' });
  assert.equal(seen.ended, false);
  assert.equal(b.calls.length, 0, 'the other remote node never saw it');
  assert.equal(nodeNamed(w, 'a').healthy, true);
  assert.equal(mem(w.db, memoryId).transcript, '');
  await a.close(); await b.close(); w.close();
});

test('a recording shorter than the check interval is still checked once before its first byte is sent', async () => {
  let w; let memoryId;
  const b = await startFakeNode();
  w = makeWorld({ nodes: [nodeCfg(b, { name: 'b' })] });
  const u = addUser(w.db);
  memoryId = addMemory(w.db, { by: u, type: 'voice_note', privacy: 'family' });
  const f = addMedia(w, { memoryId, data: crypto.randomBytes(800) }); // far below the default 4 MiB
  // The per-attempt check has passed by now; the memory turns private right after the stream was opened.
  const client = {
    ...require('../src/ai/client'),
    transcribe(node, body, opts) {
      w.db.prepare("UPDATE memories SET privacy = 'private' WHERE id = ?").run(memoryId);
      return require('../src/ai/client').transcribe(node, body, opts);
    },
  };
  const out = await makeTranscribeHandler({ ...w, client })(job(memoryId, f.id)); // default privacyCheckBytes (4 MiB)
  assert.deepEqual(out, { skip: 'memory became private while transcribing' });
  assert.ok(!b.calls.some((c) => c.path === '/v1/audio/transcriptions' && c.body.includes(f.data)), 'the recording never reached the node');
  assert.equal(mem(w.db, memoryId).transcript, '');
  assert.equal(nodeNamed(w, 'b').healthy, true);
  await b.close(); w.close();
});
