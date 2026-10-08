'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld, addUser, addMemory } = require('./helpers/world');
const jobs = require('../src/ai/jobs');
const { createWorker } = require('../src/ai/worker');
const { NoEligibleNode, NodeUnavailable } = require('../src/ai/errors');

function setup() {
  const w = makeWorld();
  const u = addUser(w.db);
  const m = addMemory(w.db, { by: u, title: 'x' });
  return { w, m };
}
const row = (db, key) => db.prepare('SELECT * FROM ai_jobs WHERE idempotency_key = ?').get(key);

test('enqueue is idempotent on the key', () => {
  const { w, m } = setup();
  assert.equal(jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'k1' }), true);
  assert.equal(jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'k1' }), false);
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM ai_jobs').get().c, 1);
  w.close();
});

test('enqueue throws on an invalid kind instead of reporting a duplicate', () => {
  const { w, m } = setup();
  assert.throws(() => jobs.enqueue(w.db, { kind: 'bogus', memoryId: m, key: 'bad-kind' }), /CHECK constraint failed/);
  assert.equal(row(w.db, 'bad-kind'), undefined);
  w.close();
});

test('enqueue throws on a null idempotency key or memory id instead of dropping the job', () => {
  const { w, m } = setup();
  assert.throws(() => jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: null }), /NOT NULL constraint failed/);
  assert.throws(() => jobs.enqueue(w.db, { kind: 'embed', memoryId: null, key: 'no-memory' }), /NOT NULL constraint failed/);
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM ai_jobs').get().c, 0);
  w.close();
});

test('claim honours next_run_at and marks running; empty queue returns null', () => {
  const { w, m } = setup();
  assert.equal(jobs.claim(w.db), null);
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'later', delayMs: 60_000 });
  assert.equal(jobs.claim(w.db), null);
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'now' });
  const j = jobs.claim(w.db);
  assert.equal(j.idempotency_key, 'now');
  assert.equal(j.status, 'running');
  assert.equal(j.attempts, 1);
  assert.equal(jobs.claim(w.db), null);
  assert.ok(jobs.claim(w.db, Date.now() + 120_000), 'delayed job becomes due');
  w.close();
});

test('fail backs off exponentially, then gives up after MAX_ATTEMPTS', () => {
  const { w, m } = setup();
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'f' });
  let t = Date.now();
  const delays = [];
  for (let i = 1; i <= jobs.MAX_ATTEMPTS; i++) {
    const j = jobs.claim(w.db, t);
    assert.ok(j, `attempt ${i} claimable`);
    jobs.fail(w.db, j, new Error('boom'), t);
    const r = row(w.db, 'f');
    if (i < jobs.MAX_ATTEMPTS) {
      assert.equal(r.status, 'pending');
      delays.push(Date.parse(r.next_run_at) - t);
      t = Date.parse(r.next_run_at);
    } else {
      assert.equal(r.status, 'failed');
      assert.match(r.last_error, /boom/);
    }
  }
  assert.deepEqual(delays, [60_000, 120_000, 240_000, 480_000, 960_000]);
  w.close();
});

test('defer does not consume an attempt; resetRunning recovers crashed jobs; retryFailed requeues', () => {
  const { w, m } = setup();
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'd' });
  const j = jobs.claim(w.db);
  jobs.defer(w.db, j.id, 1000, 'node down');
  assert.deepEqual({ s: row(w.db, 'd').status, a: row(w.db, 'd').attempts }, { s: 'pending', a: 0 });
  jobs.claim(w.db, Date.now() + 5000);
  jobs.resetRunning(w.db);
  assert.equal(row(w.db, 'd').status, 'pending');
  w.db.prepare("UPDATE ai_jobs SET status='failed', attempts=6 WHERE idempotency_key='d'").run();
  assert.equal(jobs.retryFailed(w.db), 1);
  assert.deepEqual({ s: row(w.db, 'd').status, a: row(w.db, 'd').attempts }, { s: 'pending', a: 0 });
  assert.deepEqual(jobs.stats(w.db), { pending: 1, running: 0, done: 0, failed: 0, skipped: 0 });
  w.close();
});

test('worker maps handler outcomes onto job states', async () => {
  const { w, m } = setup();
  const outcomes = {
    ok: async () => undefined,
    skipped: async () => ({ skip: 'not audio' }),
    noNode: async () => { throw new NoEligibleNode('nope'); },
    down: async () => { throw new NodeUnavailable('desktop asleep'); },
    bug: async () => { throw new Error('bug'); },
  };
  // kind is CHECK-constrained to transcribe|embed, so every job is 'embed' and the handler routes on the idempotency key.
  for (const k of Object.keys(outcomes)) assert.equal(jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: k }), true);
  const worker = createWorker({ db: w.db, handlers: { embed: (job) => outcomes[job.idempotency_key](job) }, deferMs: 300_000, log: { warn() {} } });
  await worker.drain();
  const st = (k) => row(w.db, k);
  assert.equal(st('ok').status, 'done');
  assert.equal(st('skipped').status, 'skipped');
  assert.match(st('skipped').last_error, /not audio/);
  assert.equal(st('noNode').status, 'skipped');
  assert.equal(st('down').status, 'pending');
  assert.equal(st('down').attempts, 0);
  assert.equal(st('bug').status, 'pending');
  assert.equal(st('bug').attempts, 1);
  assert.match(st('bug').last_error, /bug/);
  w.close();
});

test('worker start/stop runs due jobs in the background and stop waits for the in-flight job', async () => {
  const { w, m } = setup();
  let finished = false;
  const worker = createWorker({
    db: w.db, pollMs: 20, log: { warn() {} },
    handlers: { embed: async () => { await new Promise((r) => setTimeout(r, 80)); finished = true; } },
  });
  worker.start();
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'bg' });
  await waitFor(() => row(w.db, 'bg') && row(w.db, 'bg').status === 'running', 2000); // job is now in flight
  await worker.stop();
  assert.equal(finished, true);
  assert.equal(row(w.db, 'bg').status, 'done');
  w.close();
});

test('worker treats an empty skip reason as a skip, not a completion', async () => {
  const { w, m } = setup();
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'empty-skip' });
  const worker = createWorker({ db: w.db, handlers: { embed: async () => ({ skip: '' }) }, log: { warn() {} } });
  await worker.drain();
  assert.equal(row(w.db, 'empty-skip').status, 'skipped');
  assert.equal(row(w.db, 'empty-skip').last_error, 'skipped');
  w.close();
});

test('stop waits only for the in-flight job and leaves the rest of the backlog pending', async () => {
  const { w, m } = setup();
  const ran = [];
  const worker = createWorker({
    db: w.db, pollMs: 10, log: { warn() {} },
    handlers: { embed: async (job) => { ran.push(job.idempotency_key); await new Promise((r) => setTimeout(r, 50)); } },
  });
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'a' });
  jobs.enqueue(w.db, { kind: 'embed', memoryId: m, key: 'b' });
  worker.start();
  await waitFor(() => w.db.prepare("SELECT COUNT(*) c FROM ai_jobs WHERE status = 'running'").get().c === 1);
  await worker.stop();
  assert.equal(ran.length, 1, 'no second job started after stop');
  const [first] = ran;
  const other = first === 'a' ? 'b' : 'a';
  assert.equal(row(w.db, first).status, 'done');
  assert.equal(row(w.db, other).status, 'pending');
  w.close();
});

/** Polls a condition (no fixed sleep) until it holds or the deadline passes. */
async function waitFor(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
