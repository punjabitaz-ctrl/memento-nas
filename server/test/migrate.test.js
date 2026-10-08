'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { SCHEMA } = require('../src/db');
const { migrate, currentVersion, LATEST } = require('../src/migrations');

function v1db() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('a v2.0 database (no schema_version) upgrades to the latest version', () => {
  const db = v1db();
  assert.equal(currentVersion(db), 1);
  assert.equal(migrate(db), LATEST);
  assert.equal(currentVersion(db), LATEST);
  for (const t of ['ai_jobs', 'chunks', 'ask_log']) assert.ok(tables(db).includes(t), t);
  assert.ok(cols(db, 'memories').includes('transcript_source'));
  assert.ok(cols(db, 'memories').includes('transcript_languages'));
  for (const c of ['transcript', 'transcript_segments', 'transcript_language']) assert.ok(cols(db, 'media').includes(c), c);
  for (const c of ['source', 'requested_by', 'addressed_to']) assert.ok(cols(db, 'prompts').includes(c), c);
});

test('upgrade keeps data and marks pre-existing transcripts as human-written', () => {
  const db = v1db();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, login, display_name, password_hash, role, created_at) VALUES ('u','u','U','x','owner',?)").run(now);
  const ins = db.prepare("INSERT INTO memories (id, created_by, type, title, transcript, created_at, updated_at) VALUES (?, 'u', 'voice_note', ?, ?, ?, ?)");
  ins.run('m1', 'With transcript', 'typed by a person', now, now);
  ins.run('m2', 'Without', '', now, now);
  migrate(db);
  const get = (id) => db.prepare('SELECT title, transcript, transcript_source FROM memories WHERE id = ?').get(id);
  assert.deepEqual(get('m1'), { title: 'With transcript', transcript: 'typed by a person', transcript_source: 'human' });
  assert.equal(get('m2').transcript_source, '');
});

test('migrate is idempotent', () => {
  const db = v1db();
  migrate(db);
  assert.equal(migrate(db), LATEST);
});

test('a failing migration rolls back completely and leaves the version unchanged', () => {
  const db = v1db();
  const boom = [{ version: 2, name: 'boom', up(d) { d.exec('CREATE TABLE half_done (a)'); throw new Error('boom'); } }];
  assert.throws(() => migrate(db, boom), /boom/);
  assert.equal(currentVersion(db), 1);
  assert.ok(!tables(db).includes('half_done'));
});
