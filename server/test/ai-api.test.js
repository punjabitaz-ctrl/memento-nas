'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld } = require('./helpers/world');
const { Client, memoryForm } = require('./helpers/http');
const { createApp } = require('../src/app');
const { createAi } = require('../src/ai');
const { backfill } = require('../src/ai/backfill');

async function boot({ withNode = true, local = false } = {}) {
  const fake = withNode
    ? await startFakeNode({
        transcribe: () => ({ text: 'Grandpa told us about the apple orchard', language: 'en', segments: [] }),
        chat: () => 'Grandpa told stories about the apple orchard [S1].',
      })
    : null;
  const w = makeWorld({ nodes: withNode ? [nodeCfg(fake, { local })] : [] });
  const ai = createAi({ db: w.db, config: w.config, autoStart: false });
  const app = createApp({ config: w.config, db: w.db, clientDist: null, registry: ai ? ai.registry : null });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = new Client(base);
  const kid = new Client(base);
  await owner.json('POST', '/api/auth/setup', { json: { login: 'owner', displayName: 'Owner', password: 'correct horse battery', persona: 'archivist' } });
  await owner.json('POST', '/api/members', { json: { login: 'kid', displayName: 'Kid', password: 'kid long password', role: 'contributor', persona: 'explorer' } });
  await owner.json('POST', '/api/members', { json: { login: 'gran', displayName: 'Gran', password: 'gran long password', role: 'contributor', persona: 'elder' } });
  await kid.json('POST', '/api/auth/login', { json: { login: 'kid', password: 'kid long password' } });
  const close = async () => {
    const attempt = async (fn) => { try { await fn(); } catch { /* best-effort cleanup */ } };
    await attempt(() => new Promise((r) => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); }));
    if (ai) await attempt(() => ai.stop());
    await attempt(() => app.locals.close());
    await attempt(() => w.close());
    if (fake) await attempt(() => fake.close());
  };
  return { fake, w, ai, owner, kid, close };
}

const voice = () => memoryForm({ title: 'Orchard story', privacy: 'family' }, [{ name: 'story.webm', type: 'audio/webm', data: Buffer.alloc(3000, 7) }]);

test('AI off: endpoints answer 503 and config says so', async () => {
  const s = await boot({ withNode: false });
  try {
    assert.equal((await s.kid.json('GET', '/api/config')).data.localAi, false);
    assert.equal((await s.kid.json('POST', '/api/ask', { json: { question: 'who planted the trees' } })).status, 503);
    const st = (await s.kid.json('GET', '/api/ai/status')).data;
    assert.deepEqual([st.enabled, st.nodes], [false, []]);
    assert.equal((await s.owner.json('POST', '/api/memories', { form: voice() })).status, 201, 'saving still works');
    assert.equal(s.w.db.prepare('SELECT COUNT(*) c FROM ai_jobs').get().c, 0, 'no jobs when AI is off');
  } finally {
    await s.close();
  }
});

test('record -> transcript -> ask -> cited answer (end to end through the API)', async () => {
  const s = await boot();
  try {
    const created = await s.owner.json('POST', '/api/memories', { form: voice() });
    assert.equal(created.status, 201);
    const id = created.data.memory.id;
    assert.equal(created.data.memory.transcriptJob, 'pending');

    await s.ai.worker.drain();
    const mem = (await s.kid.json('GET', `/api/memories/${id}`)).data.memory;
    assert.equal(mem.transcript, 'Grandpa told us about the apple orchard');
    assert.deepEqual([mem.transcriptSource, mem.transcriptLanguages, mem.transcriptJob], ['machine', ['en'], null]);
    assert.equal((await s.kid.json('GET', '/api/search?q=orchard')).data.results[0].id, id, 'transcript is searchable');

    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'What did Grandpa say about the orchard?', lang: 'en' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.outcome, 'answered');
    assert.equal(r.data.citations[0].memoryId, id);

    const hist = (await s.kid.json('GET', '/api/ask/history')).data.history;
    assert.equal(hist.length, 1);
    assert.equal((await s.owner.json('GET', '/api/ask/history')).data.history.length, 0, 'history is per user');
    assert.equal((await s.kid.json('POST', `/api/ask/${r.data.id}/report`, { json: {} })).status, 200);
    assert.equal(s.w.db.prepare('SELECT outcome FROM ask_log WHERE id=?').get(r.data.id).outcome, 'reported');
    assert.equal((await s.owner.json('DELETE', `/api/ask/${r.data.id}`)).status, 404, 'cannot touch someone else\'s log');
    assert.equal((await s.kid.json('DELETE', `/api/ask/${r.data.id}`)).status, 200);
  } finally {
    await s.close();
  }
});

test('private memories never leak through Ask, and never reach a remote node', async () => {
  const s = await boot();
  try {
    const form = memoryForm({ title: 'Secret', privacy: 'private', content: 'The secret recipe uses cardamom.', transcript: 'typed by owner' });
    assert.equal((await s.owner.json('POST', '/api/memories', { form })).status, 201);
    await s.ai.worker.drain();
    const kid = await s.kid.json('POST', '/api/ask', { json: { question: 'what is the secret recipe cardamom' } });
    assert.equal(kid.data.outcome, 'no_record');
    const mine = await s.owner.json('POST', '/api/ask', { json: { question: 'what is the secret recipe cardamom' } });
    assert.deepEqual([mine.data.outcome, mine.data.excludedPrivate], ['no_record', 1], 'even the author is protected from the remote node');
    assert.ok(!s.fake.calls.some((c) => c.body.toString().includes('The secret recipe uses cardamom')), 'private text never sent to the (remote) node');
    assert.equal(s.fake.calls.filter((c) => c.path === '/v1/chat/completions').length, 0, 'no chat call was made');
  } finally {
    await s.close();
  }
});

test('forwarding a "no record" question creates a custom prompt for the elders', async () => {
  const s = await boot();
  try {
    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'Where was great-grandmother born?' } });
    assert.equal(r.data.outcome, 'no_record');
    const f = await s.kid.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} });
    assert.equal(f.status, 200, JSON.stringify(f.data));
    const row = s.w.db.prepare('SELECT * FROM prompts WHERE id = ?').get(f.data.prompt.id);
    assert.match(row.text, /Where was great-grandmother born\?/);
    assert.deepEqual([row.source, row.is_custom], ['ask', 1]);
    const gran = s.w.db.prepare("SELECT id FROM users WHERE login='gran'").get().id;
    assert.deepEqual(JSON.parse(row.addressed_to), [gran]);
    assert.equal((await s.owner.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} })).status, 404);
  } finally {
    await s.close();
  }
});

test('input validation and rate limiting on /api/ask', async () => {
  const s = await boot();
  try {
    assert.equal((await s.kid.json('POST', '/api/ask', { json: { question: 'hi' } })).status, 400);
    assert.equal((await s.kid.json('POST', '/api/ask', { json: { question: 'x'.repeat(501) } })).status, 400);
    assert.equal((await s.kid.json('POST', '/api/ask', { json: { question: 'valid question here', lang: 'not a lang!' } })).status, 400);
    assert.equal((await new Client(s.kid.base).json('POST', '/api/ask', { json: { question: 'valid question here' } })).status, 401);
    let last;
    for (let i = 0; i < 22; i++) last = await s.kid.json('POST', '/api/ask', { json: { question: 'valid question here' } });
    assert.equal(last.status, 429);
  } finally {
    await s.close();
  }
});

test('transcribe endpoint: owner/author only, protects human transcripts unless overwrite', async () => {
  const s = await boot();
  try {
    const id = (await s.owner.json('POST', '/api/memories', { form: voice() })).data.memory.id;
    await s.ai.worker.drain();
    assert.equal((await s.kid.json('POST', `/api/memories/${id}/transcribe`, { json: {} })).status, 403);
    await s.owner.json('PATCH', `/api/memories/${id}`, { json: { transcript: 'I corrected this by hand' } });
    assert.equal((await s.owner.json('POST', `/api/memories/${id}/transcribe`, { json: {} })).status, 409);
    const ok = await s.owner.json('POST', `/api/memories/${id}/transcribe`, { json: { overwrite: true } });
    assert.deepEqual([ok.status, ok.data.queued], [202, 1]);
    await s.ai.worker.drain();
    assert.equal(s.w.db.prepare('SELECT transcript_source s FROM memories WHERE id=?').get(id).s, 'machine');
  } finally {
    await s.close();
  }
});

test('status: owners see URLs and queue counts, others do not; backfill is owner-only and idempotent', async () => {
  const s = await boot();
  try {
    await s.owner.json('POST', '/api/memories', { form: voice() });
    const o = (await s.owner.json('GET', '/api/ai/status')).data;
    assert.equal(o.enabled, true);
    assert.ok(o.nodes[0].url.startsWith('http://127.0.0.1:'));
    assert.equal(o.queue.pending >= 1, true);
    const k = (await s.kid.json('GET', '/api/ai/status')).data;
    assert.equal(k.nodes[0].url, undefined);
    assert.equal(k.queue, null);
    assert.equal((await s.kid.json('POST', '/api/ai/backfill', { json: {} })).status, 403);
    await s.ai.worker.drain();
    const first = backfill(s.w.db, s.w.config);
    const second = backfill(s.w.db, s.w.config);
    assert.deepEqual(second, { transcribe: 0, embed: 0 });
    void first;
  } finally {
    await s.close();
  }
});


test('ownership: ask rows are per user, the limiter is per user, transcribe hides unseen memories', async () => {
  const s = await boot();
  try {
    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'Where was great-grandmother born?' } });
    assert.equal(r.status, 200);
    assert.equal((await s.owner.json('POST', `/api/ask/${r.data.id}/report`, { json: {} })).status, 404, 'cannot report someone else\'s row');
    assert.equal(s.w.db.prepare('SELECT outcome FROM ask_log WHERE id=?').get(r.data.id).outcome, 'no_record', 'row untouched');
    assert.equal((await s.kid.json('POST', `/api/ask/does-not-exist/report`, { json: {} })).status, 404);

    // The kid exhausts their own allowance; the owner is not affected.
    for (let i = 0; i < 20; i++) await s.kid.json('POST', '/api/ask', { json: { question: 'valid question here' } });
    assert.equal((await s.kid.json('POST', '/api/ask', { json: { question: 'valid question here' } })).status, 429);
    assert.equal((await s.owner.json('POST', '/api/ask', { json: { question: 'valid question here' } })).status, 200, 'limiter is per user, not per IP');

    // A private memory by the kid does not exist as far as the owner is concerned.
    const form = memoryForm({ title: 'Mine', privacy: 'private' }, [{ name: 's.webm', type: 'audio/webm', data: Buffer.alloc(3000, 3) }]);
    const pid = (await s.kid.json('POST', '/api/memories', { form })).data.memory.id;
    assert.equal((await s.owner.json('POST', `/api/memories/${pid}/transcribe`, { json: {} })).status, 404);
    assert.equal((await s.owner.json('POST', `/api/memories/nope/transcribe`, { json: {} })).status, 404);
  } finally {
    await s.close();
  }
});

test('Ask answers 503 (not 500) when the chat node fails', async () => {
  const s = await boot();
  try {
    await s.owner.json('POST', '/api/memories', { form: voice() });
    await s.ai.worker.drain();
    await s.fake.close(); // node goes away after the memory was indexed
    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'What did Grandpa say about the orchard?' } });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /not reachable/);
  } finally {
    await s.close();
  }
});
