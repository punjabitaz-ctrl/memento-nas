'use strict';
/**
 * Ordered, idempotent schema migrations.
 * Version 1 is the original v2.0 schema created by db.js (CREATE IF NOT EXISTS).
 * To change the schema: append { version, name, up } here. Never edit or reorder applied ones.
 */
const MIGRATIONS = [{ version: 2, name: 'ai-foundation', up: require('./002-ai-foundation') }];
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

function currentVersion(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? parseInt(row.value, 10) : 1;
}

/** Applies every pending migration, each in its own transaction. Returns the resulting version. */
function migrate(db, migrations = MIGRATIONS) {
  let v = currentVersion(db);
  for (const m of migrations) {
    if (m.version <= v) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(m.version));
    })();
    v = m.version;
  }
  return v;
}

module.exports = { migrate, currentVersion, LATEST, MIGRATIONS };
