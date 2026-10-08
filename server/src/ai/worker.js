'use strict';
const jobs = require('./jobs');
const { NoEligibleNode, NodeUnavailable } = require('./errors');

/**
 * Background loop that runs queued AI jobs one at a time.
 * Handlers return undefined (done) or { skip: reason }, or throw.
 */
function createWorker({ db, handlers, pollMs = 5000, deferMs = 300_000, now = Date.now, log = console }) {
  let timer = null;
  let stopped = true;
  let inflight = Promise.resolve();

  /** Runs one due job. Resolves true if a job was processed. */
  async function tick() {
    const job = jobs.claim(db, now());
    if (!job) return false;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
      const outcome = await handler(job);
      if (outcome && outcome.skip) jobs.skip(db, job.id, outcome.skip);
      else jobs.complete(db, job.id);
    } catch (e) {
      if (e instanceof NoEligibleNode) jobs.skip(db, job.id, e.message);
      else if (e instanceof NodeUnavailable) jobs.defer(db, job.id, deferMs, e.message);
      else {
        log.warn(`[ai] job ${job.kind} ${job.id} failed (attempt ${job.attempts}): ${e && e.message}`);
        jobs.fail(db, job, e, now());
      }
    }
    return true;
  }

  async function drain() {
    while (await tick()); // eslint-disable-line no-empty
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    jobs.resetRunning(db);
    const loop = () => {
      if (stopped) return;
      // Checks `stopped` between jobs so stop() waits for at most the job in flight, not the whole backlog.
      inflight = (async () => { while (!stopped && (await tick())); })() // eslint-disable-line no-empty
        .catch((e) => log.warn(`[ai] worker error: ${e && e.message}`))
        .finally(() => { if (!stopped) timer = setTimeout(loop, pollMs); });
    };
    loop();
  }

  /** Stops polling and resolves once the job currently running (if any) has finished. */
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    await inflight;
  }

  return { tick, drain, start, stop };
}

module.exports = { createWorker };
