'use strict';
/**
 * express-session store backed by better-sqlite3, in its own database file
 * (data/sessions/sessions.sqlite) so sessions can be excluded from backups.
 * Uses the same native driver as the main database, so no second native
 * module has to compile on the NAS.
 */
const path = require('node:path');
const session = require('express-session');
const Database = require('better-sqlite3');

class SqliteStore extends session.Store {
  constructor(dir, { defaultTtlMs = 30 * 864e5 } = {}) {
    super();
    this.ttl = defaultTtlMs;
    this.db = new Database(path.join(dir, 'sessions.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)'
    );
    this.stmts = {
      get: this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: this.db.prepare(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires'
      ),
      del: this.db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: this.db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.stmts.prune.run(Date.now());
    this.timer = setInterval(() => this.stmts.prune.run(Date.now()), 3600e3);
    this.timer.unref();
  }
  _expiry(sess) {
    const e = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttl;
    return e;
  }
  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) {
      cb(e);
    }
  }
  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this._expiry(sess));
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
  destroy(sid, cb) {
    try {
      this.stmts.del.run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this._expiry(sess), sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }
  close() {
    clearInterval(this.timer);
    this.db.close();
  }
}

module.exports = { SqliteStore };
