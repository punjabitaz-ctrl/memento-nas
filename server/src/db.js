'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { encryptBuffer, decryptBuffer, DecryptError } = require('./crypto');
const { migrate } = require('./migrations');

const CANARY_ID = 'memento-key-check';
const CANARY_TEXT = 'memento-vault-key-ok';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','contributor','viewer')),
  persona TEXT NOT NULL DEFAULT 'archivist' CHECK (persona IN ('elder','archivist','explorer')),
  settings TEXT NOT NULL DEFAULT '{}',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('photo','video','voice_note','text_note','document')),
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '',
  memory_date TEXT,
  date_precision TEXT NOT NULL DEFAULT 'day' CHECK (date_precision IN ('day','month','year')),
  location TEXT NOT NULL DEFAULT '',
  privacy TEXT NOT NULL DEFAULT 'family' CHECK (privacy IN ('private','family')),
  prompt_id TEXT,
  ai_summary TEXT NOT NULL DEFAULT '',
  ai_source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_date ON memories(memory_date);
CREATE INDEX IF NOT EXISTS idx_memories_creator ON memories(created_by);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON memory_tags(tag);

CREATE TABLE IF NOT EXISTS memory_people (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  relationship TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (memory_id, name)
);
CREATE INDEX IF NOT EXISTS idx_people_name ON memory_people(name);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','document')),
  mime TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  size_plain INTEGER NOT NULL,
  duration REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_memory ON media(memory_id);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL,
  life_stage TEXT,
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_votes (
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (prompt_id, user_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id UNINDEXED, title, description, body, tags, people, location, summary,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
`;

function open(config) {
  const file = path.join(config.dirs.db, 'memento.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  verifyKey(db, config.key);
  migrate(db);
  seedPrompts(db);
  return db;
}

/**
 * Guard against the worst NAS mistake: starting with a different key than the
 * one that encrypted the vault. We store an encrypted canary on first boot and
 * refuse to start if it cannot be opened later.
 */
function verifyKey(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('key_canary');
  if (!row) {
    const enc = encryptBuffer(key, CANARY_ID, Buffer.from(CANARY_TEXT));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('key_canary', enc.toString('base64'));
    return;
  }
  try {
    const plain = decryptBuffer(key, CANARY_ID, Buffer.from(row.value, 'base64')).toString();
    if (plain !== CANARY_TEXT) throw new DecryptError('canary mismatch');
  } catch {
    const err = new Error(
      'MEMENTO_KEY does not match the key this vault was created with. ' +
        'Starting with a different key would make every file unreadable. ' +
        'Restore the original key in .env (check your password manager / printed copy).'
    );
    err.code = 'KEY_MISMATCH';
    throw err;
  }
}

function seedPrompts(db) {
  const have = db.prepare('SELECT COUNT(*) c FROM prompts WHERE is_custom = 0').get().c;
  if (have > 0) return;
  const seed = require('./data/prompts.json');
  const ins = db.prepare(
    'INSERT INTO prompts (id, text, category, life_stage, is_custom, created_at) VALUES (?,?,?,?,0,?)'
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const p of seed) ins.run(crypto.randomUUID(), p.text, p.category, p.lifeStage || null, now);
  })();
}

/** Rebuild the FTS row for one memory. Call inside the write transaction. */
function reindex(db, memoryId) {
  db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
  const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId);
  if (!m) return;
  const tags = db.prepare('SELECT tag FROM memory_tags WHERE memory_id = ?').all(memoryId).map((r) => r.tag);
  const people = db.prepare('SELECT name FROM memory_people WHERE memory_id = ?').all(memoryId).map((r) => r.name);
  db.prepare(
    'INSERT INTO memory_fts (memory_id, title, description, body, tags, people, location, summary) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    memoryId,
    m.title,
    m.description,
    `${m.content}\n${m.transcript}`,
    tags.join(' '),
    people.join(' '),
    m.location,
    m.ai_summary
  );
}

module.exports = { open, reindex, SCHEMA };
