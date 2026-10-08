'use strict';
const { Transform, pipeline } = require('node:stream');
const { openDecryptStream } = require('../crypto');
const { vaultPath } = require('../uploads');
const { reindex } = require('../db');
const clientDefault = require('./client');
const { queueEmbed } = require('./hooks');

const PRIVACY_CHECK_BYTES = 4 * 1024 * 1024;
const BECAME_PRIVATE = 'memory became private while transcribing';

/** Raised (never with `nodeFailure`) when a memory turns private while its audio is streaming to a non-local node. */
class BecamePrivate extends Error {
  constructor() { super(BECAME_PRIVATE); this.name = 'BecamePrivate'; }
}

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

/**
 * Passes `src` through, re-reading the memory's privacy every `every` bytes. Once it is no longer 'family' the
 * stream is destroyed with BecamePrivate, which makes client.request abort the upload, so the rest of the
 * recording never leaves this machine. LIMITATION: bytes already sent before the change (at most about `every`
 * bytes plus socket buffers since the last check) cannot be recalled; the node's answer is never stored.
 * Only used for non-local nodes: a local node may keep transcribing a private memory.
 */
function privacyGuard(src, privacyNow, every) {
  let since = 0;
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      since += chunk.length;
      if (since >= every) {
        since = 0;
        let p;
        try { p = privacyNow(); } catch (e) { return cb(e); }
        if (p !== 'family') return cb(new BecamePrivate());
      }
      return cb(null, chunk);
    },
  });
  pipeline(src, guard, () => {}); // destroying the guard also destroys (closes) the vault stream
  return guard;
}

function makeTranscribeHandler({ db, config, registry, client = clientDefault, privacyCheckBytes = PRIVACY_CHECK_BYTES }) {
  return async function transcribeJob(job) {
    const media = db.prepare(
      'SELECT md.*, m.privacy, m.transcript_source FROM media md JOIN memories m ON m.id = md.memory_id WHERE md.id = ?'
    ).get(job.media_id);
    if (!media) return { skip: 'file no longer exists' };
    if (media.kind !== 'audio' && media.kind !== 'video') return { skip: 'not audio or video' };
    if (media.transcript_source === 'human') return { skip: 'transcript was written by a person' };

    // Read fresh before every node attempt and during the upload: the owner may make the memory private while
    // a long transcription runs. A deleted memory counts as private (the most restrictive answer).
    const privacyNow = () => {
      const row = db.prepare('SELECT privacy FROM memories WHERE id = ?').get(media.memory_id);
      return row ? row.privacy : 'private';
    };

    let result;
    try {
      result = await registry.withNode('transcribe', privacyNow, async (node) => {
        // Re-opened per node: a stream can only be consumed once. Decrypted bytes live in memory only.
        const { stream } = await openDecryptStream(vaultPath(config, media.id), config.key, media.id);
        const body = node.local === true ? stream : privacyGuard(stream, privacyNow, privacyCheckBytes);
        return client.transcribe(node, body, { mime: media.mime });
      });
    } catch (e) {
      // A missing vault file will never come back: don't retry, and don't store the absolute path in last_error.
      if (e && e.code === 'ENOENT') return { skip: 'file missing from the vault' };
      if (e instanceof BecamePrivate) return { skip: BECAME_PRIVATE };
      throw e;
    }

    db.transaction(() => {
      db.prepare('UPDATE media SET transcript = ?, transcript_segments = ?, transcript_language = ? WHERE id = ?')
        .run(result.text, JSON.stringify(result.segments), result.language, media.id);
      recomposeTranscript(db, media.memory_id);
    })();
    queueEmbed(db, media.memory_id);
  };
}

module.exports = { makeTranscribeHandler, recomposeTranscript };
