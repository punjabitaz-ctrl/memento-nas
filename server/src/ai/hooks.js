'use strict';
const crypto = require('node:crypto');
const { enqueue } = require('./jobs');

/** Everything a memory contributes to search and retrieval, as one string. */
function memoryText(m) {
  return [m.title, m.description, m.content, m.transcript].filter((s) => s && s.trim()).join('\n\n');
}

/**
 * Drops a memory's embedded passages. Call it inside the SAME transaction as any change to what the memory says
 * (story, title, description, transcript, files, people, tags, location, privacy), so text a person removed can
 * never be served from old chunks. Retrieval falls back to the memory's current text while it has no chunks, and
 * a queued embed job rebuilds them. Works with AI disabled (the chunks table always exists).
 */
function invalidateChunks(db, memoryId) {
  db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(memoryId);
}

/** Queue (re-)embedding unless one is already waiting or there is nothing to embed. */
function queueEmbed(db, memoryId) {
  const m = db.prepare('SELECT title, description, content, transcript FROM memories WHERE id = ?').get(memoryId);
  if (!m || !memoryText(m).trim()) return false;
  if (db.prepare("SELECT 1 FROM ai_jobs WHERE kind = 'embed' AND memory_id = ? AND status = 'pending'").get(memoryId)) return false;
  return enqueue(db, { kind: 'embed', memoryId, key: `embed:${memoryId}:${crypto.randomUUID()}` });
}

/** Queue transcription for each audio/video file. `force` makes a fresh job even if one already ran; `skipBusy` leaves files that already have a pending/running job alone. */
function queueTranscribe(db, memoryId, { force = false, skipBusy = false } = {}) {
  const files = db.prepare("SELECT id FROM media WHERE memory_id = ? AND kind IN ('audio','video')").all(memoryId);
  let n = 0;
  const busy = db.prepare("SELECT 1 FROM ai_jobs WHERE kind = 'transcribe' AND media_id = ? AND status IN ('pending','running')");
  for (const f of files) {
    if (skipBusy && busy.get(f.id)) continue;
    const key = force ? `transcribe:${f.id}:${crypto.randomUUID()}` : `transcribe:${f.id}`;
    if (enqueue(db, { kind: 'transcribe', memoryId, mediaId: f.id, key })) n++;
  }
  return n;
}

/**
 * Call after a memory or its files were created/changed. Does nothing when local AI is off.
 * Best-effort: the save is already committed, so a queueing problem must never fail the request.
 * Only the error message is logged, never user text.
 */
function onMemorySaved(db, config, memoryId) {
  if (!config.ai.enabled) return;
  try {
    queueTranscribe(db, memoryId);
    queueEmbed(db, memoryId);
  } catch (e) {
    console.warn('[ai] could not queue AI work:', e.message);
  }
}

module.exports = { memoryText, invalidateChunks, queueEmbed, queueTranscribe, onMemorySaved };
