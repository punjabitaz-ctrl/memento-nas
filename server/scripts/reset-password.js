'use strict';
/**
 * Reset a Memento user's password from the NAS shell. Usage (inside the container):
 *   docker exec -it memento node scripts/reset-password.js <login> '<new password>'
 *   docker exec -it memento node scripts/reset-password.js --list
 * Only needs filesystem access to the database; does not need MEMENTO_KEY.
 */
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = process.env.DATA_DIR || '/data';
const db = new Database(path.join(dataDir, 'db', 'memento.sqlite'));
const [a, b] = process.argv.slice(2);

if (a === '--list' || !a) {
  const rows = db.prepare('SELECT login, display_name, role, disabled FROM users ORDER BY created_at').all();
  console.log(rows.length ? rows.map((u) => `${u.login}  (${u.display_name}, ${u.role}${u.disabled ? ', DISABLED' : ''})`).join('\n') : 'No users yet.');
  console.log('\nUsage: node scripts/reset-password.js <login> "<new password>"');
  process.exit(0);
}
if (!b || b.length < 10 || Buffer.byteLength(b) > 72) {
  console.error('New password must be 10+ characters and at most 72 bytes.');
  process.exit(1);
}
const res = db.prepare('UPDATE users SET password_hash = ?, disabled = 0 WHERE login = ?').run(bcrypt.hashSync(b, 12), a);
if (!res.changes) {
  console.error(`No user with login "${a}". Run with --list to see logins.`);
  process.exit(1);
}
console.log(`Password reset for "${a}". They can sign in now.`);
