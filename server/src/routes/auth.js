'use strict';
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { HttpError, wrap, str, oneOf } = require('../util');

const ROLES = ['owner', 'contributor', 'viewer'];
const PERSONAS = ['elder', 'archivist', 'explorer'];
const BCRYPT_COST = 12;
// Compared against when a login does not exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_COST);

function userDto(u) {
  let settings = {};
  try {
    settings = JSON.parse(u.settings || '{}');
  } catch {
    /* ignore */
  }
  return {
    id: u.id,
    login: u.login,
    displayName: u.display_name,
    role: u.role,
    persona: u.persona,
    settings,
    disabled: !!u.disabled,
    createdAt: u.created_at,
  };
}

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters. A short phrase of several words works well.');
  if (Buffer.byteLength(pw) > 72) throw new HttpError(400, 'Password is too long (max 72 bytes).');
}

function checkLogin(v) {
  const s = str(v, 254, { name: 'Login', required: true });
  if (s.length < 3 || /\s/.test(s)) throw new HttpError(400, 'Login must be 3+ characters with no spaces (an email or a simple username).');
  return s;
}

const SETTINGS_KEYS = {
  textSize: ['normal', 'large', 'extra-large'],
  highContrast: 'boolean',
  reducedMotion: 'boolean',
};
function cleanSettings(input, current = {}) {
  const out = { ...current };
  for (const [k, rule] of Object.entries(SETTINGS_KEYS)) {
    if (input[k] === undefined) continue;
    if (Array.isArray(rule)) out[k] = oneOf(input[k], rule, k);
    else out[k] = !!input[k];
  }
  return out;
}

module.exports = function authRoutes({ db }) {
  const r = express.Router();
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  });

  const userCount = () => db.prepare('SELECT COUNT(*) c FROM users').get().c;

  function startSession(req, user) {
    return new Promise((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) return reject(err);
        req.session.userId = user.id;
        req.session.save((e) => (e ? reject(e) : resolve()));
      });
    });
  }

  r.get('/auth/status', (req, res) => {
    let authenticated = false;
    if (req.session && req.session.userId) {
      const u = db.prepare('SELECT disabled FROM users WHERE id = ?').get(req.session.userId);
      authenticated = !!u && !u.disabled;
    }
    res.json({ initialized: userCount() > 0, authenticated });
  });

  // First-run: create the vault owner. Only works while there are zero users.
  r.post('/auth/setup', authLimiter, wrap(async (req, res) => {
    if (userCount() > 0) throw new HttpError(409, 'This vault is already set up. Please sign in.');
    const login = checkLogin(req.body.login);
    const displayName = str(req.body.displayName, 80, { name: 'Name', required: true });
    checkPassword(req.body.password);
    const persona = req.body.persona ? oneOf(req.body.persona, PERSONAS, 'persona') : 'archivist';
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    try {
      db.prepare(
        "INSERT INTO users (id, login, display_name, password_hash, role, persona, created_at) VALUES (?,?,?,?, 'owner', ?, ?)"
      ).run(id, login, displayName, hash, persona, new Date().toISOString());
    } catch {
      throw new HttpError(409, 'This vault is already set up. Please sign in.');
    }
    await startSession(req, { id });
    res.status(201).json({ user: userDto(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  }));

  r.post('/auth/login', authLimiter, wrap(async (req, res) => {
    const login = str(req.body.login, 254, { name: 'Login', required: true });
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const u = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    const ok = await bcrypt.compare(password.slice(0, 200), u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || u.disabled) throw new HttpError(401, 'That login or password is not right.');
    await startSession(req, u);
    res.json({ user: userDto(u) });
  }));

  r.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('memento.sid');
      res.json({ ok: true });
    });
  });

  r.get('/auth/me', requireAuthInline, (req, res) => res.json({ user: userDto(req.user) }));

  r.patch('/auth/me', requireAuthInline, wrap(async (req, res) => {
    const u = req.user;
    const displayName = req.body.displayName !== undefined ? str(req.body.displayName, 80, { name: 'Name', required: true }) : u.display_name;
    const persona = req.body.persona !== undefined ? oneOf(req.body.persona, PERSONAS, 'persona') : u.persona;
    const settings = req.body.settings ? cleanSettings(req.body.settings, JSON.parse(u.settings || '{}')) : JSON.parse(u.settings || '{}');
    db.prepare('UPDATE users SET display_name = ?, persona = ?, settings = ? WHERE id = ?').run(displayName, persona, JSON.stringify(settings), u.id);
    res.json({ user: userDto(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  }));

  r.post('/auth/password', requireAuthInline, authLimiter, wrap(async (req, res) => {
    const ok = await bcrypt.compare(String(req.body.currentPassword || '').slice(0, 200), req.user.password_hash);
    if (!ok) throw new HttpError(403, 'Your current password is not right.');
    checkPassword(req.body.newPassword);
    const hash = await bcrypt.hash(req.body.newPassword, BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ ok: true });
  }));

  // ---- Family members (owner manages; everyone can see names) ----
  r.get('/members', requireAuthInline, (req, res) => {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all();
    res.json({
      members: rows.map((u) =>
        req.user.role === 'owner'
          ? userDto(u)
          : { id: u.id, displayName: u.display_name, role: u.role, disabled: !!u.disabled }
      ),
    });
  });

  r.post('/members', requireAuthInline, requireOwner, wrap(async (req, res) => {
    const login = checkLogin(req.body.login);
    const displayName = str(req.body.displayName, 80, { name: 'Name', required: true });
    checkPassword(req.body.password);
    const role = oneOf(req.body.role || 'contributor', ['contributor', 'viewer'], 'role');
    const persona = req.body.persona ? oneOf(req.body.persona, PERSONAS, 'persona') : 'explorer';
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new HttpError(409, 'That login is already taken.');
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    db.prepare(
      'INSERT INTO users (id, login, display_name, password_hash, role, persona, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(id, login, displayName, hash, role, persona, new Date().toISOString());
    res.status(201).json({ member: userDto(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  }));

  r.patch('/members/:id', requireAuthInline, requireOwner, wrap(async (req, res) => {
    const t = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!t) throw new HttpError(404, 'Member not found');
    const role = req.body.role !== undefined ? oneOf(req.body.role, ROLES, 'role') : t.role;
    const disabled = req.body.disabled !== undefined ? (req.body.disabled ? 1 : 0) : t.disabled;
    const displayName = req.body.displayName !== undefined ? str(req.body.displayName, 80, { name: 'Name', required: true }) : t.display_name;
    const persona = req.body.persona !== undefined ? oneOf(req.body.persona, PERSONAS, 'persona') : t.persona;
    const owners = db.prepare("SELECT COUNT(*) c FROM users WHERE role='owner' AND disabled=0").get().c;
    if (t.role === 'owner' && !t.disabled && owners <= 1 && (role !== 'owner' || disabled)) {
      throw new HttpError(400, 'There must always be at least one active owner.');
    }
    let hash = t.password_hash;
    if (req.body.password !== undefined) {
      checkPassword(req.body.password);
      hash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    }
    db.prepare('UPDATE users SET role=?, disabled=?, display_name=?, persona=?, password_hash=? WHERE id=?').run(role, disabled, displayName, persona, hash, t.id);
    if (disabled) db.prepare('DELETE FROM prompt_votes WHERE user_id = ?').run(t.id);
    res.json({ member: userDto(db.prepare('SELECT * FROM users WHERE id = ?').get(t.id)) });
  }));

  function requireAuthInline(req, res, next) {
    const uid = req.session && req.session.userId;
    const u = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) : null;
    if (!u || u.disabled) {
      if (req.session) req.session.destroy(() => {});
      return res.status(401).json({ error: 'Please sign in.' });
    }
    req.user = u;
    next();
  }
  function requireOwner(req, res, next) {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the vault owner can do that.' });
    next();
  }

  return r;
};

module.exports.userDto = userDto;
