'use strict';
const crypto = require('node:crypto');

const MAX_ATTEMPTS = 6;
const iso = (ms) => new Date(ms).toISOString();

/**
 * Adds a job unless one with the same idempotency key already exists.
 * Returns true when a row was added, false for a duplicate key (silently skipped).
 * Any other constraint violation (unknown kind, null key or memory id) throws, so a bad caller fails loudly.
 */
function enqueue(db, { kind, memoryId, mediaId = null, key, delayMs = 0 }) {
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO ai_jobs (id, kind, memory_id, media_id, status, attempts, next_run_at, last_error, idempotency_key, created_at, updated_at)
     VALUES (?,?,?,?,'pending',0,?,'',?,?,?)
     ON CONFLICT(idempotency_key) DO NOTHING`
  ).run(crypto.randomUUID(), kind, memoryId, mediaId, iso(now + delayMs), key, iso(now), iso(now));
  return info.changes === 1;
}

/** Atomically takes the oldest due job. Single-process server, so one UPDATE...RETURNING is enough. */
function claim(db, nowMs = Date.now()) {
  const t = iso(nowMs);
  return db.prepare(
    `UPDATE ai_jobs SET status = 'running', attempts = attempts + 1, updated_at = @t
     WHERE id = (SELECT id FROM ai_jobs WHERE status = 'pending' AND next_run_at <= @t ORDER BY next_run_at, created_at LIMIT 1)
     RETURNING *`
  ).get({ t }) || null;
}

const setStatus = (db, id, status, error = '') =>
  db.prepare('UPDATE ai_jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(status, String(error).slice(0, 500), iso(Date.now()), id);

const complete = (db, id) => setStatus(db, id, 'done');
const skip = (db, id, reason) => setStatus(db, id, 'skipped', reason);

/** Put a job back without counting the attempt (the node was asleep; that is not the job's fault). */
function defer(db, id, delayMs, reason) {
  db.prepare(
    `UPDATE ai_jobs SET status = 'pending', attempts = MAX(attempts - 1, 0), next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`
  ).run(iso(Date.now() + delayMs), String(reason).slice(0, 500), iso(Date.now()), id);
}

/**
 * Record a genuine failure: exponential backoff (1m, 2m, 4m, ...), then give up once MAX_ATTEMPTS is reached.
 * The 1h cap only takes effect if MAX_ATTEMPTS is raised to 8 or more; at today's 6 the longest wait is 16m.
 */
function fail(db, job, err, nowMs = Date.now()) {
  const msg = String((err && err.message) || err).slice(0, 500);
  if (job.attempts >= MAX_ATTEMPTS) return setStatus(db, job.id, 'failed', msg);
  const delay = Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
  db.prepare(`UPDATE ai_jobs SET status = 'pending', next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
    .run(iso(nowMs + delay), msg, iso(nowMs), job.id);
}

/** At boot: anything still "running" belonged to a process that died. */
function resetRunning(db) {
  db.prepare("UPDATE ai_jobs SET status = 'pending' WHERE status = 'running'").run();
}

function retryFailed(db) {
  return db.prepare("UPDATE ai_jobs SET status = 'pending', attempts = 0, next_run_at = ? WHERE status = 'failed'").run(iso(Date.now())).changes;
}

function stats(db) {
  const out = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) c FROM ai_jobs GROUP BY status').all()) out[r.status] = r.c;
  return out;
}

module.exports = { enqueue, claim, complete, skip, defer, fail, resetRunning, retryFailed, stats, MAX_ATTEMPTS };
