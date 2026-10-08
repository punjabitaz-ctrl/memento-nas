'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeNode, nodeCfg } = require('./helpers/fake-node');
const { makeWorld } = require('./helpers/world');
const { Client, memoryForm } = require('./helpers/http');
const { createApp } = require('../src/app');
const { createAi } = require('../src/ai');
const { backfill } = require('../src/ai/backfill');

async function boot({ withNode = true, local = false, capabilities = null } = {}) {
  const fake = withNode
    ? await startFakeNode({
        transcribe: () => ({ text: 'Grandpa told us about the apple orchard', language: 'en', segments: [] }),
        chat: () => 'Grandpa told stories about the apple orchard [S1].',
      })
    : null;
  const w = makeWorld({ nodes: withNode ? [nodeCfg(fake, { local, ...(capabilities ? { capabilities } : {}) })] : [] });
  const ai = createAi({ db: w.db, config: w.config, autoStart: false });
  const app = createApp({ config: w.config, db: w.db, clientDist: null, registry: ai ? ai.registry : null });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = new Client(base);
  const kid = new Client(base);
  await owner.json('POST', '/api/auth/setup', { json: { login: 'owner', displayName: 'Owner', password: 'correct horse battery', persona: 'archivist' } });
  await owner.json('POST', '/api/members', { json: { login: 'kid', displayName: 'Kid', password: 'kid long password', role: 'contributor', persona: 'explorer' } });
  await owner.json('POST', '/api/members', { json: { login: 'gran', displayName: 'Gran', password: 'gran long password', role: 'contributor', persona: 'elder' } });
  await owner.json('POST', '/api/members', { json: { login: 'view', displayName: 'Viewer', password: 'view long password', role: 'viewer', persona: 'explorer' } });
  await kid.json('POST', '/api/auth/login', { json: { login: 'kid', password: 'kid long password' } });
  const viewer = new Client(base);
  await viewer.json('POST', '/api/auth/login', { json: { login: 'view', password: 'view long password' } });
  const close = async () => {
    const attempt = async (fn) => { try { await fn(); } catch { /* best-effort cleanup */ } };
    await attempt(() => new Promise((r) => { server.close(r); if (server.closeAllConnections) server.closeAllConnections(); }));
    if (ai) await attempt(() => ai.stop());
    await attempt(() => app.locals.close());
    await attempt(() => w.close());
    if (fake) await attempt(() => fake.close());
  };
  return { fake, w, ai, owner, kid, viewer, close };
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

test('Ask answers 502 with a friendly message (never the node error text) when the chat node refuses the request', async () => {
  const s = await boot();
  try {
    await s.owner.json('POST', '/api/memories', { form: voice() });
    await s.ai.worker.drain();
    for (const status of [401, 400]) {
      s.fake.state.failStatus = status; // e.g. wrong token, or "context too long"
      const r = await s.kid.json('POST', '/api/ask', { json: { question: 'What did Grandpa say about the orchard?' } });
      assert.equal(r.status, 502, String(status));
      assert.equal(r.data.error, 'The AI helper could not answer that. Ask the vault owner to check the AI node settings.');
      const raw = JSON.stringify(r.data);
      assert.ok(!raw.includes('desk') && !raw.includes(String(status)) && !raw.includes('HTTP'), raw);
    }
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

test('forward is writer-only: a viewer may ask but not send a question to the family', async () => {
  const s = await boot();
  try {
    const r = await s.viewer.json('POST', '/api/ask', { json: { question: 'Where was great-grandmother born?' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.outcome, 'no_record');
    const before = s.w.db.prepare('SELECT COUNT(*) c FROM prompts').get().c;
    assert.equal((await s.viewer.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} })).status, 403);
    assert.equal(s.w.db.prepare('SELECT COUNT(*) c FROM prompts').get().c, before, 'no prompt created');
  } finally {
    await s.close();
  }
});

test('forward only for unanswered questions, and idempotent per question', async () => {
  const s = await boot();
  try {
    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'Where was great-grandmother born?' } });
    assert.equal(r.data.outcome, 'no_record');

    await s.owner.json('POST', '/api/memories', { form: voice() });
    await s.ai.worker.drain();
    const answered = await s.kid.json('POST', '/api/ask', { json: { question: 'What did Grandpa say about the orchard?' } });
    assert.equal(answered.data.outcome, 'answered');
    const bad = await s.kid.json('POST', `/api/ask/${answered.data.id}/forward`, { json: {} });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /Only questions the archive could not answer can be sent to the family/);

    const count = () => s.w.db.prepare("SELECT COUNT(*) c FROM prompts WHERE source = 'ask'").get().c;
    const f1 = await s.kid.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} });
    const f2 = await s.kid.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} });
    assert.deepEqual([f1.status, f2.status], [200, 200]);
    assert.equal(f2.data.prompt.id, f1.data.prompt.id, 'same prompt returned');
    assert.equal(count(), 1, 'exactly one prompt row');
    const gran = s.w.db.prepare("SELECT id FROM users WHERE login='gran'").get().id;
    assert.deepEqual(f1.data.prompt.addressedTo, [gran]);
    assert.deepEqual(f2.data.prompt.addressedTo, [gran]);

    // A reported question is no longer a plain "no record" and cannot be forwarded.
    await s.kid.json('POST', `/api/ask/${r.data.id}/report`, { json: {} });
    assert.equal((await s.kid.json('POST', `/api/ask/${r.data.id}/forward`, { json: {} })).status, 400);
  } finally {
    await s.close();
  }
});

test('transcribe: no media => 400 and nothing changes; a repeated request does not double-queue', async () => {
  const s = await boot();
  try {
    const form = memoryForm({ title: 'Typed', privacy: 'family', content: 'Written by hand.', transcript: 'my own words' });
    const tid = (await s.owner.json('POST', '/api/memories', { form })).data.memory.id;
    const src = () => s.w.db.prepare('SELECT transcript_source s FROM memories WHERE id=?').get(tid).s;
    assert.equal(src(), 'human');
    const bad = await s.owner.json('POST', `/api/memories/${tid}/transcribe`, { json: { overwrite: true } });
    assert.equal(bad.status, 400);
    assert.equal(src(), 'human', 'human transcript untouched');
    assert.equal(s.w.db.prepare("SELECT COUNT(*) c FROM ai_jobs WHERE kind = 'transcribe' AND memory_id = ?").get(tid).c, 0);

    const id = (await s.owner.json('POST', '/api/memories', { form: voice() })).data.memory.id;
    await s.ai.worker.drain();
    const a = await s.owner.json('POST', `/api/memories/${id}/transcribe`, { json: {} });
    const b = await s.owner.json('POST', `/api/memories/${id}/transcribe`, { json: {} });
    assert.deepEqual([a.status, a.data.queued], [202, 1]);
    assert.deepEqual([b.status, b.data.queued, b.data.alreadyQueued], [202, 0, true]);
    assert.equal(s.w.db.prepare("SELECT COUNT(*) c FROM ai_jobs WHERE kind = 'transcribe' AND memory_id = ? AND status = 'pending'").get(id).c, 1);
  } finally {
    await s.close();
  }
});

test('backfill queues missing work once; the owner endpoint reports counts and retries failed jobs', async () => {
  const s = await boot();
  try {
    const id = (await s.owner.json('POST', '/api/memories', { form: voice() })).data.memory.id;
    const wipe = () => {
      s.w.db.prepare('DELETE FROM ai_jobs').run();
      s.w.db.prepare('DELETE FROM chunks').run();
    };
    wipe();
    assert.deepEqual(backfill(s.w.db, s.w.config), { transcribe: 1, embed: 1 });
    assert.deepEqual(backfill(s.w.db, s.w.config), { transcribe: 0, embed: 0 }, 'second call finds nothing to add');

    wipe();
    assert.equal((await s.kid.json('POST', '/api/ai/backfill', { json: {} })).status, 403);
    const viaApi = await s.owner.json('POST', '/api/ai/backfill', { json: {} });
    assert.equal(viaApi.status, 200);
    assert.deepEqual(viaApi.data, { transcribe: 1, embed: 1, retried: 0 });

    s.w.db.prepare("UPDATE ai_jobs SET status = 'failed' WHERE kind = 'transcribe' AND memory_id = ?").run(id);
    const again = await s.owner.json('POST', '/api/ai/backfill', { json: {} });
    assert.equal(again.data.retried, 1);
    assert.equal(s.w.db.prepare("SELECT status FROM ai_jobs WHERE kind = 'transcribe' AND memory_id = ?").get(id).status, 'pending');
  } finally {
    await s.close();
  }
});

test('Ask tells "no AI helper set up for this" apart from "helper not reachable"', async () => {
  const s = await boot({ capabilities: ['transcribe', 'embed'] });
  try {
    const form = memoryForm({ title: 'Orchard', privacy: 'family', content: 'Grandpa told us about the apple orchard.' });
    assert.equal((await s.owner.json('POST', '/api/memories', { form })).status, 201);
    await s.ai.worker.drain();
    const r = await s.kid.json('POST', '/api/ask', { json: { question: 'What did Grandpa say about the orchard?' } });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /No AI helper is set up for this kind of question yet\./);
    assert.doesNotMatch(r.data.error, /not reachable/);
  } finally {
    await s.close();
  }
});

test('createAi autoStart: backfills, runs the worker, and stops cleanly', async () => {
  const s = await boot();
  let ai2 = null;
  try {
    const id = (await s.owner.json('POST', '/api/memories', { form: voice() })).data.memory.id;
    ai2 = createAi({ db: s.w.db, config: s.w.config, autoStart: true, log: { log() {}, warn() {}, error() {} } });
    const text = () => s.w.db.prepare('SELECT transcript t FROM memories WHERE id = ?').get(id).t;
    const deadline = Date.now() + 10_000;
    while (!text() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(text(), 'Grandpa told us about the apple orchard');
    await ai2.stop();
    ai2 = null;
  } finally {
    if (ai2) { try { await ai2.stop(); } catch { /* best-effort */ } }
    await s.close();
  }
});
