'use strict';
const crypto = require('node:crypto');
const { enqueue } = require('./jobs');

/** Changes whenever the node set changes, so jobs that were skipped for lack of a node get another chance. */
function fingerprint(config) {
  const shape = config.ai.nodes.map((n) => [n.name, n.capabilities, n.local, n.models]);
  return crypto.createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}

/**
 * Queues missing AI work (recordings without a transcript, memories without embeddings).
 * Idempotent while the node configuration is unchanged. Memories whose newest chunk is older than the memory
 * itself (edited after they were embedded) count as missing too, so stale passages get refreshed.
 * The whole enqueue loop is one transaction: one fsync instead of one per job.
 */
function backfill(db, config) {
  return db.transaction(() => backfillInner(db, config))();
}

function backfillInner(db, config) {
  const fp = fingerprint(config);
  const out = { transcribe: 0, embed: 0 };

  const media = db.prepare(
    `SELECT md.id, md.memory_id FROM media md JOIN memories m ON m.id = md.memory_id
     WHERE md.kind IN ('audio','video') AND md.transcript = '' AND m.transcript_source != 'human'
       AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.media_id = md.id AND j.kind = 'transcribe' AND j.status IN ('pending','running'))`
  ).all();
  for (const x of media) {
    if (enqueue(db, { kind: 'transcribe', memoryId: x.memory_id, mediaId: x.id, key: `transcribe:${x.id}:bf:${fp}` })) out.transcribe++;
  }

  if (config.ai.embedModel) {
    const memories = db.prepare(
      `SELECT m.id, m.updated_at FROM memories m
       WHERE (m.title != '' OR m.description != '' OR m.content != '' OR m.transcript != '')
         AND (NOT EXISTS (SELECT 1 FROM chunks c WHERE c.memory_id = m.id AND c.model = ?)
              OR (SELECT MAX(c.created_at) FROM chunks c WHERE c.memory_id = m.id) < m.updated_at)
         AND NOT EXISTS (SELECT 1 FROM ai_jobs j WHERE j.memory_id = m.id AND j.kind = 'embed' AND j.status IN ('pending','running'))`
    ).all(config.ai.embedModel);
    for (const x of memories) {
      if (enqueue(db, { kind: 'embed', memoryId: x.id, key: `embed:${x.id}:bf:${fp}:${config.ai.embedModel}:${x.updated_at}` })) out.embed++;
    }
  }
  return out;
}

module.exports = { backfill };
