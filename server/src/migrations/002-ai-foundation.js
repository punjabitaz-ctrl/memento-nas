'use strict';
const { addColumnIfMissing } = require('./helpers');

module.exports = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('transcribe','embed')),
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      media_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_run_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_due ON ai_jobs(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_ai_jobs_memory ON ai_jobs(memory_id);

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      ord INTEGER NOT NULL,
      text TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_memory ON chunks(memory_id);

    CREATE TABLE IF NOT EXISTS ask_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      cited TEXT NOT NULL DEFAULT '[]',
      outcome TEXT NOT NULL CHECK (outcome IN ('answered','no_record','reported')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ask_user ON ask_log(user_id, created_at);
  `);

  addColumnIfMissing(db, 'memories', 'transcript_source', "TEXT NOT NULL DEFAULT '' CHECK (transcript_source IN ('','machine','human'))");
  addColumnIfMissing(db, 'memories', 'transcript_languages', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'media', 'transcript', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'media', 'transcript_segments', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'media', 'transcript_language', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'prompts', 'source', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'prompts', 'requested_by', 'TEXT');
  addColumnIfMissing(db, 'prompts', 'addressed_to', "TEXT NOT NULL DEFAULT '[]'");

  // Anything typed before this migration was written by a person: never let a machine overwrite it.
  db.exec("UPDATE memories SET transcript_source = 'human' WHERE transcript != '' AND transcript_source = ''");
};
