'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('../../src/config');
const dbmod = require('../../src/db');
const { NodeRegistry } = require('../../src/ai/nodes');
const { encryptBuffer } = require('../../src/crypto');
const { vaultPath } = require('../../src/uploads');

/** A throwaway data dir + real config + real db (+ registry when nodes are given). */
function makeWorld({ nodes = [], extraEnv = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-ai-'));
  const config = load({
    MEMENTO_KEY: crypto.randomBytes(32).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    DATA_DIR: dataDir,
    AI_ENABLED: nodes.length ? 'true' : 'false',
    AI_NODES: nodes.length ? JSON.stringify(nodes) : '',
    AI_POLL_MS: '50',
    ...extraEnv,
  });
  const db = dbmod.open(config);
  const registry = new NodeRegistry(config.ai.nodes);
  return {
    config, db, registry, dataDir,
    close() {
      db.close();
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    },
  };
}

let n = 0;
const uid = (p) => `${p}-${++n}`;

function addUser(db, { id = uid('u'), role = 'owner', persona = 'archivist', name } = {}) {
  db.prepare('INSERT INTO users (id, login, display_name, password_hash, role, persona, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, id, name || id, 'x', role, persona, new Date().toISOString());
  return id;
}

function addMemory(db, { id = uid('m'), by, privacy = 'family', type = 'text_note', title = '', content = '', transcript = '', date = null } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, created_by, type, title, content, transcript, transcript_source, memory_date, privacy, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, by, type, title, content, transcript, transcript ? 'human' : '', date, privacy, now, now);
  dbmod.reindex(db, id);
  return id;
}

/** Writes an encrypted file into the vault exactly like an upload would, and registers it. */
function addMedia(world, { id = uid('f'), memoryId, kind = 'audio', mime = 'audio/webm', data = crypto.randomBytes(2000) }) {
  fs.writeFileSync(vaultPath(world.config, id), encryptBuffer(world.config.key, id, data));
  world.db.prepare('INSERT INTO media (id, memory_id, kind, mime, original_name, size_plain, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, memoryId, kind, mime, 'rec', data.length, new Date().toISOString());
  return { id, data };
}

module.exports = { makeWorld, addUser, addMemory, addMedia };
