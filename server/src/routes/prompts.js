'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { HttpError, wrap, str, oneOf } = require('../util');
const { VISIBLE } = require('../memories');

const CATEGORIES = {
  childhood: { name: 'Childhood', icon: '🧒', description: 'Early memories and formative experiences' },
  education: { name: 'Education', icon: '📚', description: 'School days and learning' },
  career: { name: 'Career', icon: '💼', description: 'Work life and professional journey' },
  family: { name: 'Family', icon: '👨‍👩‍👧‍👦', description: 'Parents, siblings, children and relatives' },
  love: { name: 'Love & Relationships', icon: '💕', description: 'Romance, marriage and partnership' },
  traditions: { name: 'Traditions', icon: '🎄', description: 'Holidays, customs and rituals' },
  wisdom: { name: 'Wisdom', icon: '💡', description: 'Lessons learned and advice to share' },
  milestones: { name: 'Milestones', icon: '🏆', description: 'Life events and achievements' },
  favorites: { name: 'Favorites', icon: '⭐', description: 'Favorite things, foods and places' },
  adventures: { name: 'Adventures', icon: '🧭', description: 'Travel and memorable experiences' },
  challenges: { name: 'Challenges', icon: '⛰️', description: 'Hard times and how they were overcome' },
  gratitude: { name: 'Gratitude', icon: '🙏', description: 'What you are thankful for' },
};
const STAGES = ['early_childhood', 'childhood', 'teenage', 'young_adult', 'adult', 'middle_age', 'senior'];

function isoWeekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${week}`;
}

module.exports = function promptRoutes({ db, requireAuth, requireWriter }) {
  const r = express.Router();
  r.use(requireAuth);

  const dto = (p, uid) => ({
    id: p.id, text: p.text, category: p.category, lifeStage: p.life_stage, isCustom: !!p.is_custom,
    votes: p.votes || 0, votedByMe: !!p.voted_by_me, answered: p.answered || 0, createdBy: p.created_by,
  });
  const SELECT = `SELECT p.*,
      (SELECT COUNT(*) FROM prompt_votes v WHERE v.prompt_id = p.id) AS votes,
      EXISTS(SELECT 1 FROM prompt_votes v WHERE v.prompt_id = p.id AND v.user_id = @uid) AS voted_by_me,
      (SELECT COUNT(*) FROM memories m WHERE m.prompt_id = p.id AND ${VISIBLE}) AS answered
    FROM prompts p`;

  r.get('/prompts/categories', (req, res) => {
    const counts = Object.fromEntries(db.prepare('SELECT category, COUNT(*) c FROM prompts GROUP BY category').all().map((x) => [x.category, x.c]));
    res.json({
      categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, ...c, count: counts[id] || 0 })),
      lifeStages: STAGES,
    });
  });

  r.get('/prompts', (req, res) => {
    const where = [];
    const params = { uid: req.user.id };
    if (req.query.category) { where.push('p.category = @category'); params.category = String(req.query.category); }
    if (req.query.lifeStage) { where.push('p.life_stage = @stage'); params.stage = String(req.query.lifeStage); }
    if (req.query.unanswered === '1') where.push(`NOT EXISTS (SELECT 1 FROM memories m WHERE m.prompt_id = p.id AND ${VISIBLE})`);
    const rows = db.prepare(`${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.is_custom DESC, votes DESC, p.category, p.rowid`).all(params);
    res.json({ prompts: rows.map((p) => dto(p)) });
  });

  r.get('/prompts/random', (req, res) => {
    const params = { uid: req.user.id };
    let sql = `${SELECT} WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.prompt_id = p.id AND ${VISIBLE})`;
    if (req.query.category) { sql += ' AND p.category = @category'; params.category = String(req.query.category); }
    const row = db.prepare(`${sql} ORDER BY RANDOM() LIMIT 1`).get(params)
      || db.prepare(`${SELECT} ORDER BY RANDOM() LIMIT 1`).get(params);
    res.json({ prompt: row ? dto(row) : null });
  });

  // Same prompt all week for everyone in the family.
  r.get('/prompts/weekly', (req, res) => {
    const all = db.prepare(`${SELECT} ORDER BY p.rowid`).all({ uid: req.user.id });
    if (!all.length) return res.json({ prompt: null });
    const key = isoWeekKey();
    let h = 0;
    for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    res.json({ week: key, prompt: dto(all[h % all.length]) });
  });

  r.post('/prompts', requireWriter, wrap(async (req, res) => {
    const text = str(req.body.text, 500, { name: 'Question', required: true });
    if (text.length < 10) throw new HttpError(400, 'Please write a full question (at least 10 characters).');
    const category = oneOf(req.body.category, Object.keys(CATEGORIES), 'category');
    const stage = req.body.lifeStage ? oneOf(req.body.lifeStage, STAGES, 'lifeStage') : null;
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO prompts (id, text, category, life_stage, is_custom, created_by, created_at) VALUES (?,?,?,?,1,?,?)')
      .run(id, text, category, stage, req.user.id, new Date().toISOString());
    res.status(201).json({ prompt: dto(db.prepare(`${SELECT} WHERE p.id = @id`).get({ uid: req.user.id, id })) });
  }));

  r.post('/prompts/:id/vote', (req, res) => {
    if (!db.prepare('SELECT 1 FROM prompts WHERE id = ?').get(req.params.id)) throw new HttpError(404, 'Question not found');
    const has = db.prepare('SELECT 1 FROM prompt_votes WHERE prompt_id=? AND user_id=?').get(req.params.id, req.user.id);
    if (has) db.prepare('DELETE FROM prompt_votes WHERE prompt_id=? AND user_id=?').run(req.params.id, req.user.id);
    else db.prepare('INSERT INTO prompt_votes (prompt_id, user_id) VALUES (?,?)').run(req.params.id, req.user.id);
    res.json({ prompt: dto(db.prepare(`${SELECT} WHERE p.id = @id`).get({ uid: req.user.id, id: req.params.id })) });
  });

  r.delete('/prompts/:id', requireWriter, (req, res) => {
    const p = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    if (!p || !p.is_custom) throw new HttpError(404, 'Custom question not found');
    if (p.created_by !== req.user.id && req.user.role !== 'owner') throw new HttpError(403, 'You can only remove questions you added.');
    db.prepare('UPDATE memories SET prompt_id = NULL WHERE prompt_id = ?').run(p.id);
    db.prepare('DELETE FROM prompts WHERE id = ?').run(p.id);
    res.json({ ok: true });
  });

  return r;
};
