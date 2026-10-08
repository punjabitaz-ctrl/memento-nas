'use strict';
const { openDecryptStream } = require('../crypto');
const { vaultPath } = require('../uploads');
const { reindex } = require('../db');
const clientDefault = require('./client');
const { queueEmbed } = require('./hooks');

/**
 * Rebuilds a memory's transcript from its per-file transcripts. Does nothing if a person wrote/edited it.
 * Returns true when the memory was updated.
 */
function recomposeTranscript(db, memoryId) {
  const mem = db.prepare('SELECT transcript_source FROM memories WHERE id = ?').get(memoryId);
  if (!mem || mem.transcript_source === 'human') return false;
  const rows = db.prepare(
    "SELECT transcript, transcript_language FROM media WHERE memory_id = ? AND transcript != '' ORDER BY created_at, rowid"
  ).all(memoryId);
  const langs = [...new Set(rows.map((r) => r.transcript_language).filter(Boolean))];
  db.prepare('UPDATE memories SET transcript = ?, transcript_source = ?, transcript_languages = ?, updated_at = ? WHERE id = ?')
    .run(rows.map((r) => r.transcript).join('\n\n'), rows.length ? 'machine' : '', JSON.stringify(langs), new Date().toISOString(), memoryId);
  reindex(db, memoryId);
  return true;
}

function makeTranscribeHandler({ db, config, registry, client = clientDefault }) {
  return async function transcribeJob(job) {
    const media = db.prepare(
      'SELECT md.*, m.privacy, m.transcript_source FROM media md JOIN memories m ON m.id = md.memory_id WHERE md.id = ?'
    ).get(job.media_id);
    if (!media) return { skip: 'file no longer exists' };
    if (media.kind !== 'audio' && media.kind !== 'video') return { skip: 'not audio or video' };
    if (media.transcript_source === 'human') return { skip: 'transcript was written by a person' };

    const result = await registry.withNode('transcribe', media.privacy, async (node) => {
      // Re-opened per node: a stream can only be consumed once. Decrypted bytes live in memory only.
      const { stream } = await openDecryptStream(vaultPath(config, media.id), config.key, media.id);
      return client.transcribe(node, stream, { mime: media.mime });
    });

    db.transaction(() => {
      db.prepare('UPDATE media SET transcript = ?, transcript_segments = ?, transcript_language = ? WHERE id = ?')
        .run(result.text, JSON.stringify(result.segments), result.language, media.id);
      recomposeTranscript(db, media.memory_id);
    })();
    queueEmbed(db, media.memory_id);
  };
}

module.exports = { makeTranscribeHandler, recomposeTranscript };
