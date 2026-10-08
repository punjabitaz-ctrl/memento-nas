'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { load, ConfigError } = require('./src/config');
const dbmod = require('./src/db');
const { createApp } = require('./src/app');

function die(title, lines) {
  console.error(`\n❌ ${title}\n`);
  for (const l of [].concat(lines)) console.error(`   • ${l}`);
  console.error('\n   See README.md → "Configure". Run ./generate-key.sh to create keys.\n');
  process.exit(1);
}

let config;
try {
  config = load();
} catch (e) {
  if (e instanceof ConfigError) die('Memento cannot start: configuration problem', e.problems);
  throw e;
}

let db;
try {
  db = dbmod.open(config);
} catch (e) {
  if (e.code === 'KEY_MISMATCH') die('Memento cannot start: wrong encryption key', e.message);
  throw e;
}

// Anything left as *.part is an interrupted upload from a previous run.
for (const f of fs.readdirSync(config.dirs.vault)) {
  if (f.endsWith('.part')) fs.rmSync(path.join(config.dirs.vault, f), { force: true });
}

const clientDist =
  config.clientDist ||
  [path.join(__dirname, 'client', 'dist'), path.join(__dirname, '..', 'client', 'dist')].find((p) =>
    fs.existsSync(path.join(p, 'index.html'))
  );

const app = createApp({ config, db, clientDist });
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`🕰️  Memento ${config.version} listening on :${config.port}`);
  console.log(`   data: ${config.dirs.data}  |  AI: ${config.anthropicKey ? 'Claude (opt-in per item)' : 'offline'}  |  proxy: ${config.trustProxy}`);
  if (!clientDist) console.warn('   ⚠️  client/dist not found: only the API is available');
});
server.requestTimeout = 0; // large uploads over slow NAS links can take a long time
server.headersTimeout = 60_000;

let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${sig} received: closing cleanly…`);
  const force = setTimeout(() => {
    console.error('Forced exit after 25s');
    process.exit(1);
  }, 25_000);
  force.unref();
  server.close(() => {
    try {
      app.locals.close();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch (e) {
      console.error('Error closing database:', e.message);
    }
    console.log('Goodbye.');
    process.exit(0);
  });
  server.closeIdleConnections && server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
