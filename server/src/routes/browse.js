'use strict';
/** Read-only discovery: timeline, gaps, on-this-day, stats, search, people, tags, narrate. */
const express = require('express');
const { HttpError, wrap, str } = require('../util');
const { VISIBLE, hydrate } = require('../memories');

/** Build a safe FTS5 MATCH expression: every word quoted, last one prefix-matched. */
function ftsQuery(q) {
  const words = String(q || '').match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return null;
  return words.slice(0, 12).map((w, i, a) => `"${w}"${i === a.length - 1 ? '*' : ''}`).join(' ');
}

function light(db, rows) {
  const full = hydrate(db, rows);
  return full.map((m) => ({
    id: m.id, type: m.type, title: m.title, summary: m.aiSummary || m.description,
    memoryDate: m.memoryDate, datePrecision: m.datePrecision, privacy: m.privacy,
    contributor: m.contributor,
    thumb: (m.media.find((x) => x.kind === 'image') || {}).url || null,
    mediaKinds: [...new Set(m.media.map((x) => x.kind))],
  }));
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function datePhrase(m) {
  if (!m.memory_date) return '';
  const [y, mo, d] = m.memory_date.split('-');
  if (m.date_precision === 'year') return `In ${y}, `;
  if (m.date_precision === 'month') return `In ${MONTH_NAMES[+mo - 1]} ${y}, `;
  return `On ${MONTH_NAMES[+mo - 1]} ${+d}, ${y}, `;
}

module.exports = function browseRoutes({ db, requireAuth }) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/timeline', (req, res) => {
    const rows = db.prepare(
      `SELECT m.* FROM memories m WHERE ${VISIBLE} ORDER BY m.memory_date IS NULL, m.memory_date DESC, m.created_at DESC`
    ).all({ uid: req.user.id });
    const items = light(db, rows);
    const byYear = new Map();
    const undated = [];
    for (const m of items) {
      if (!m.memoryDate) { undated.push(m); continue; }
      const y = m.memoryDate.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(m);
    }
    res.json({
      years: [...byYear.entries()].map(([year, memories]) => ({ year: +year, count: memories.length, memories })),
      undated: { count: undated.length, memories: undated.slice(0, 100) },
    });
  });

  r.get('/timeline/gaps', (req, res) => {
    const years = db.prepare(
      `SELECT CAST(substr(m.memory_date,1,4) AS INTEGER) y, COUNT(*) c FROM memories m
       WHERE ${VISIBLE} AND m.memory_date IS NOT NULL GROUP BY y`
    ).all({ uid: req.user.id });
    if (!years.length) return res.json({ decades: [], gaps: [] });
    const min = Math.min(...years.map((x) => x.y));
    const max = Math.max(...years.map((x) => x.y));
    const counts = new Map();
    for (const { y, c } of years) counts.set(Math.floor(y / 10) * 10, (counts.get(Math.floor(y / 10) * 10) || 0) + c);
    const decades = [];
    for (let d = Math.floor(min / 10) * 10; d <= Math.floor(max / 10) * 10; d += 10) {
      const count = counts.get(d) || 0;
      decades.push({ decade: d, label: `${d}s`, count, status: count === 0 ? 'empty' : count <= 2 ? 'sparse' : 'ok' });
    }
    res.json({ decades, gaps: decades.filter((x) => x.status !== 'ok') });
  });

  r.get('/timeline/on-this-day', (req, res) => {
    const now = new Date();
    const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const rows = db.prepare(
      `SELECT m.* FROM memories m WHERE ${VISIBLE} AND m.date_precision = 'day'
         AND substr(m.memory_date,6,5) = @md AND CAST(substr(m.memory_date,1,4) AS INTEGER) < @y
       ORDER BY m.memory_date DESC LIMIT 20`
    ).all({ uid: req.user.id, md, y: now.getFullYear() });
    res.json({ date: md, memories: light(db, rows) });
  });

  r.get('/stats', (req, res) => {
    const p = { uid: req.user.id };
    const one = (sql) => db.prepare(sql).get(p);
    const total = one(`SELECT COUNT(*) c FROM memories m WHERE ${VISIBLE}`).c;
    const byType = db.prepare(`SELECT m.type, COUNT(*) c FROM memories m WHERE ${VISIBLE} GROUP BY m.type`).all(p);
    const range = one(`SELECT MIN(substr(m.memory_date,1,4)) minY, MAX(substr(m.memory_date,1,4)) maxY FROM memories m WHERE ${VISIBLE} AND m.memory_date IS NOT NULL`);
    const contributors = db.prepare(
      `SELECT u.id, u.display_name AS displayName, COUNT(*) count FROM memories m JOIN users u ON u.id = m.created_by WHERE ${VISIBLE} GROUP BY u.id ORDER BY count DESC`
    ).all(p);
    const bytes = one(`SELECT COALESCE(SUM(md.size_plain),0) b FROM media md JOIN memories m ON m.id = md.memory_id WHERE ${VISIBLE}`).b;
    const people = one(`SELECT COUNT(DISTINCT lower(pp.name)) c FROM memory_people pp JOIN memories m ON m.id = pp.memory_id WHERE ${VISIBLE}`).c;
    const month = new Date().toISOString().slice(0, 7);
    const thisMonth = one(`SELECT COUNT(*) c FROM memories m WHERE ${VISIBLE} AND substr(m.created_at,1,7) = '${month}'`).c;
    res.json({
      total, thisMonth, people, bytes, contributors,
      byType: Object.fromEntries(byType.map((x) => [x.type, x.c])),
      firstYear: range.minY ? +range.minY : null, lastYear: range.maxY ? +range.maxY : null,
    });
  });

  r.get('/search', (req, res) => {
    const match = ftsQuery(req.query.q);
    if (!match) return res.json({ results: [] });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const rows = db.prepare(
      `SELECT m.*, snippet(memory_fts, -1, char(1), char(2), '…', 16) AS snip
         FROM memory_fts f JOIN memories m ON m.id = f.memory_id
        WHERE memory_fts MATCH @q AND ${VISIBLE}
        ORDER BY bm25(memory_fts) LIMIT ${limit}`
    ).all({ q: match, uid: req.user.id });
    if (rows.length) {
      const hyd = hydrate(db, rows);
      return res.json({ results: hyd.map((m, i) => ({ ...m, snippet: rows[i].snip })) });
    }
    // Fallback: the stemmer indexes "wedding" as "wed", so partial words ("wedd") find nothing.
    // A family vault is small, so a substring scan is fast and makes search feel forgiving.
    const words = (String(req.query.q).match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
    const params = { uid: req.user.id };
    const conds = words.map((w, i) => {
      params[`w${i}`] = `%${w.replace(/[\\%_]/g, '\\$&')}%`;
      const like = (col) => `${col} LIKE @w${i} ESCAPE '\\'`;
      return `(${['m.title', 'm.description', 'm.content', 'm.transcript', 'm.location', 'm.ai_summary'].map(like).join(' OR ')}
        OR EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = m.id AND ${like('t.tag')})
        OR EXISTS (SELECT 1 FROM memory_people p WHERE p.memory_id = m.id AND ${like('p.name')}))`;
    });
    const loose = db.prepare(
      `SELECT m.* FROM memories m WHERE ${VISIBLE} AND ${conds.join(' AND ')} ORDER BY m.created_at DESC LIMIT ${limit}`
    ).all(params);
    res.json({ results: hydrate(db, loose).map((m) => ({ ...m, snippet: null })) });
  });

  r.get('/people', (req, res) => {
    const rows = db.prepare(
      `SELECT pp.name AS name, MAX(pp.relationship) AS relationship, COUNT(*) AS count
         FROM memory_people pp JOIN memories m ON m.id = pp.memory_id
        WHERE ${VISIBLE} GROUP BY lower(pp.name) ORDER BY count DESC, name`
    ).all({ uid: req.user.id });
    res.json({ people: rows });
  });

  r.get('/tags', (req, res) => {
    const rows = db.prepare(
      `SELECT t.tag AS tag, COUNT(*) AS count FROM memory_tags t JOIN memories m ON m.id = t.memory_id
        WHERE ${VISIBLE} GROUP BY lower(t.tag) ORDER BY count DESC, tag LIMIT 200`
    ).all({ uid: req.user.id });
    res.json({ tags: rows });
  });

  // Offline "narrate": weave matching memories into a short chronological story.
  r.post('/narrate', wrap(async (req, res) => {
    const subject = str(req.body.subject, 80, { name: 'Name or year', required: true });
    const isYear = /^\d{4}$/.test(subject);
    const rows = isYear
      ? db.prepare(`SELECT m.* FROM memories m WHERE ${VISIBLE} AND substr(m.memory_date,1,4) = @s ORDER BY m.memory_date`).all({ uid: req.user.id, s: subject })
      : db.prepare(
          `SELECT DISTINCT m.* FROM memories m JOIN memory_people pp ON pp.memory_id = m.id
            WHERE ${VISIBLE} AND pp.name LIKE @s ESCAPE '\\' ORDER BY m.memory_date IS NULL, m.memory_date`
        ).all({ uid: req.user.id, s: `%${subject.replace(/[\\%_]/g, '\\$&')}%` });
    if (!rows.length) throw new HttpError(404, `No memories found for "${subject}" yet.`);
    const paras = rows.slice(0, 25).map((m) => {
      const body = (m.ai_summary || m.description || m.content || m.transcript || '').replace(/\s+/g, ' ').trim();
      const text = body.length > 400 ? body.slice(0, 397) + '…' : body;
      return `${datePhrase(m)}${m.title ? `"${m.title}". ` : ''}${text}`.trim();
    });
    res.json({
      title: isYear ? `The year ${subject}` : `Stories of ${subject}`,
      story: paras.join('\n\n'),
      sources: rows.slice(0, 25).map((m) => ({ id: m.id, title: m.title })),
      usedAI: false,
    });
  }));

  return r;
};

module.exports.ftsQuery = ftsQuery;
