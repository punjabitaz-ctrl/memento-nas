'use strict';
const { NodeRegistry } = require('./nodes');
const { createWorker } = require('./worker');
const { makeTranscribeHandler } = require('./transcribe');
const { makeEmbedHandler } = require('./embed');
const { backfill } = require('./backfill');

/** Builds the registry + worker. Returns null when local AI is disabled. */
function createAi({ db, config, autoStart = true, log = console }) {
  if (!config.ai.enabled) return null;
  const registry = new NodeRegistry(config.ai.nodes);
  const deps = { db, config, registry };
  const worker = createWorker({
    db,
    pollMs: config.ai.pollMs,
    log,
    handlers: { transcribe: makeTranscribeHandler(deps), embed: makeEmbedHandler(deps) },
  });
  let timer = null;
  if (autoStart) {
    const queued = backfill(db, config);
    if (queued.transcribe || queued.embed) log.log(`[ai] queued ${queued.transcribe} transcription and ${queued.embed} embedding jobs`);
    worker.start();
    registry.checkAll().catch(() => {});
    timer = setInterval(() => registry.checkAll().catch(() => {}), 60_000);
    timer.unref();
  }
  return {
    registry,
    worker,
    async stop() {
      clearInterval(timer);
      await worker.stop();
    },
  };
}

module.exports = { createAi };
