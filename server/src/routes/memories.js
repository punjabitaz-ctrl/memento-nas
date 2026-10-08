'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { HttpError, wrap, str, oneOf, parseFuzzyDate, parseJsonField, cleanTags, cleanPeople } = require('../util');
const { VISIBLE, canView, canEdit, hydrate, setTagsPeople } = require('../memories');
const { parseUpload, removeFiles, vaultPath } = require('../uploads');
const { openDecryptStream } = require('../crypto');
const { organize, organizeWithClaude } = require('../organize');
const { reindex } = require('../db');

const TYPES = ['photo', 'video', 'voice_note', 'text_note', 'document'];
const KIND_TO_TYPE = { image: 'photo', video: 'video', audio: 'voice_note', document: 'document' };

module.exports = function memoryRoutes({ db, config, requireAuth, requireWriter }) {
  const r = express.Router();
  r.use(requireAuth);

  const getMemory = (id) => db.prepare('SELECT * FROM memories WHERE id = ?').get(id);

  function loadVisible(id, user) {
    const m = getMemory(id);
    if (!m || !canView(m, user)) throw new HttpError(404, 'Memory not found');
    return m;
  }

  async function firstImageBuffer(files) {
    const img = files.find((f) => f.kind === 'image' && f.sizePlain <= 3.5 * 1024 * 1024);
    if (!img) return null;
    const { stream } = await openDecryptStream(vaultPath(config, img.id), config.key, img.id);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return { mime: img.mime, buffer: Buffer.concat(chunks) };
  }

  /** Heuristics always; Claude only when the user asked for it on this item. */
  async function suggest(input, files, useAI) {
    const base = organize(input);
    let source = 'offline';
    let out = base;
    if (useAI && config.anthropicKey) {
      try {
        const ai = await organizeWithClaude(config, { ...input, filename: files[0] && files[0].filename }, files.length ? await firstImageBuffer(files) : null);
        out = {
          summary: ai.summary || base.summary,
          tags: ai.tags.length ? ai.tags : base.tags,
          people: ai.people.length ? ai.people : base.people,
          location: ai.location || base.location,
          date: ai.date || base.date,
        };
        source = 'claude';
      } catch (e) {
        console.warn('[ai] Claude organize failed, used offline suggestions:', e.message);
      }
    }
    return { out, source };
  }

  // ---- List -------------------------------------------------------------
  r.get('/memories', (req, res) => {
    const q = req.query;
    const where = [VISIBLE];
    const params = { uid: req.user.id };
    if (q.type) { where.push('m.type = @type'); params.type = oneOf(String(q.type), TYPES, 'type'); }
    if (q.year) {
      if (q.year === 'undated') where.push('m.memory_date IS NULL');
      else if (/^\d{4}$/.test(q.year)) { where.push('substr(m.memory_date,1,4) = @year'); params.year = q.year; }
    }
    if (q.person) { where.push('EXISTS (SELECT 1 FROM memory_people p WHERE p.memory_id = m.id AND p.name = @person)'); params.person = String(q.person); }
    if (q.tag) { where.push('EXISTS (SELECT 1 FROM memory_tags t WHERE t.memory_id = m.id AND t.tag = @tag)'); params.tag = String(q.tag); }
    if (q.mine === '1') where.push('m.created_by = @uid');
    if (q.promptId) { where.push('m.prompt_id = @promptId'); params.promptId = String(q.promptId); }
    const order = { added: 'm.created_at DESC', oldest: 'm.memory_date IS NULL, m.memory_date ASC', memory: 'm.memory_date IS NULL, m.memory_date DESC' }[q.sort] || 'm.created_at DESC';
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const w = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) c FROM memories m WHERE ${w}`).get(params).c;
    const rows = db.prepare(`SELECT m.* FROM memories m WHERE ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).all(params);
    res.json({ total, memories: hydrate(db, rows) });
  });

  // ---- Create (multipart: text fields first, then files) ----------------
  r.post('/memories', requireWriter, wrap(async (req, res) => {
    const { fields: f, files } = await parseUpload(req, config);
    const cleanup = () => removeFiles(config, files.map((x) => x.id));
    try {
      const title = str(f.title, 200, { name: 'Title' });
      const description = str(f.description, 5000, { name: 'Description' });
      const content = str(f.content, 200000, { name: 'Story' });
      const transcript = str(f.transcript, 200000, { name: 'Transcript' });
      if (!files.length && !title && !content && !description) throw new HttpError(400, 'Add a title, a story, or a file.');
      const type = f.type ? oneOf(f.type, TYPES, 'type') : files.length ? KIND_TO_TYPE[files[0].kind] : 'text_note';
      const privacy = f.privacy ? oneOf(f.privacy, ['private', 'family'], 'privacy') : 'family';
      const location = str(f.location, 200, { name: 'Location' });
      let promptId = null;
      if (f.promptId) {
        if (!db.prepare('SELECT 1 FROM prompts WHERE id = ?').get(f.promptId)) throw new HttpError(400, 'Unknown prompt');
        promptId = f.promptId;
      }
      const fd = parseFuzzyDate(f.memoryDate);
      let tags = cleanTags(parseJsonField(f.tags, 'tags', []));
      let people = cleanPeople(parseJsonField(f.people, 'people', []));
      const duration = Number.isFinite(+f.duration) && +f.duration > 0 ? Math.min(+f.duration, 86400) : null;

      const { out: sug, source } = await suggest({ title, description, content, transcript }, files, f.useAI === 'true');
      const date = fd || (sug.date ? { date: sug.date.memoryDate, precision: sug.date.precision } : null);
      if (!tags.length) tags = cleanTags(sug.tags);
      if (!people.length) people = cleanPeople(sug.people);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO memories (id, created_by, type, title, description, content, transcript, memory_date, date_precision,
             location, privacy, prompt_id, ai_summary, ai_source, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(id, req.user.id, type, title, description, content, transcript, date ? date.date : null, date ? date.precision : 'day',
          location || sug.location || '', privacy, promptId, sug.summary || '', source, now, now);
        const im = db.prepare('INSERT INTO media (id, memory_id, kind, mime, original_name, size_plain, duration, created_at) VALUES (?,?,?,?,?,?,?,?)');
        for (const x of files) im.run(x.id, id, x.kind, x.mime, x.filename, x.sizePlain, x.kind === 'audio' || x.kind === 'video' ? duration : null, now);
        setTagsPeople(db, id, tags, people);
      })();
      res.status(201).json({ memory: hydrate(db, [getMemory(id)])[0] });
    } catch (e) {
      cleanup();
      throw e;
    }
  }));

  // ---- Read -------------------------------------------------------------
  r.get('/memories/:id', (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    res.json({ memory: hydrate(db, [m])[0], canEdit: canEdit(m, req.user) });
  });

  // ---- Update (metadata + transcript) -----------------------------------
  r.patch('/memories/:id', requireWriter, wrap(async (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only edit memories you added.');
    const b = req.body || {};
    const next = {
      title: b.title !== undefined ? str(b.title, 200, { name: 'Title' }) : m.title,
      description: b.description !== undefined ? str(b.description, 5000, { name: 'Description' }) : m.description,
      content: b.content !== undefined ? str(b.content, 200000, { name: 'Story' }) : m.content,
      transcript: b.transcript !== undefined ? str(b.transcript, 200000, { name: 'Transcript' }) : m.transcript,
      location: b.location !== undefined ? str(b.location, 200, { name: 'Location' }) : m.location,
      privacy: b.privacy !== undefined ? oneOf(b.privacy, ['private', 'family'], 'privacy') : m.privacy,
      memory_date: m.memory_date,
      date_precision: m.date_precision,
    };
    if (b.memoryDate !== undefined) {
      const fd = parseFuzzyDate(b.memoryDate);
      next.memory_date = fd ? fd.date : null;
      next.date_precision = fd ? fd.precision : 'day';
    }
    const tags = b.tags !== undefined ? cleanTags(b.tags) : null;
    const people = b.people !== undefined ? cleanPeople(b.people) : null;
    db.transaction(() => {
      db.prepare(
        'UPDATE memories SET title=?, description=?, content=?, transcript=?, location=?, privacy=?, memory_date=?, date_precision=?, updated_at=? WHERE id=?'
      ).run(next.title, next.description, next.content, next.transcript, next.location, next.privacy, next.memory_date, next.date_precision, new Date().toISOString(), m.id);
      if (tags || people) {
        const curTags = tags || db.prepare('SELECT tag FROM memory_tags WHERE memory_id=?').all(m.id).map((x) => x.tag);
        const curPeople = people || db.prepare('SELECT name, relationship FROM memory_people WHERE memory_id=?').all(m.id);
        setTagsPeople(db, m.id, curTags, curPeople);
      } else reindex(db, m.id);
    })();
    res.json({ memory: hydrate(db, [getMemory(m.id)])[0] });
  }));

  // ---- Re-run organizer on an existing memory ---------------------------
  r.post('/memories/:id/organize', requireWriter, wrap(async (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only organize memories you added.');
    const media = db.prepare('SELECT id, kind, mime, original_name AS filename, size_plain AS sizePlain FROM media WHERE memory_id = ?').all(m.id);
    const { out, source } = await suggest(m, media, !!req.body.useAI);
    const tags = cleanTags([...db.prepare('SELECT tag FROM memory_tags WHERE memory_id=?').all(m.id).map((x) => x.tag), ...out.tags]);
    const people = cleanPeople([...db.prepare('SELECT name, relationship FROM memory_people WHERE memory_id=?').all(m.id), ...out.people]);
    db.transaction(() => {
      db.prepare('UPDATE memories SET ai_summary=?, ai_source=?, location=?, updated_at=? WHERE id=?').run(
        out.summary || m.ai_summary, source, m.location || out.location || '', new Date().toISOString(), m.id);
      if (!m.memory_date && out.date) {
        db.prepare('UPDATE memories SET memory_date=?, date_precision=? WHERE id=?').run(out.date.memoryDate, out.date.precision, m.id);
      }
      setTagsPeople(db, m.id, tags, people);
    })();
    res.json({ memory: hydrate(db, [getMemory(m.id)])[0] });
  }));

  // ---- Add more files to an existing memory -----------------------------
  r.post('/memories/:id/media', requireWriter, wrap(async (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only add files to memories you added.');
    const { fields: f, files } = await parseUpload(req, config);
    if (!files.length) throw new HttpError(400, 'No file received');
    const duration = Number.isFinite(+f.duration) && +f.duration > 0 ? Math.min(+f.duration, 86400) : null;
    try {
      const now = new Date().toISOString();
      db.transaction(() => {
        const im = db.prepare('INSERT INTO media (id, memory_id, kind, mime, original_name, size_plain, duration, created_at) VALUES (?,?,?,?,?,?,?,?)');
        for (const x of files) im.run(x.id, m.id, x.kind, x.mime, x.filename, x.sizePlain, x.kind === 'audio' || x.kind === 'video' ? duration : null, now);
        db.prepare('UPDATE memories SET updated_at=? WHERE id=?').run(now, m.id);
      })();
    } catch (e) {
      removeFiles(config, files.map((x) => x.id));
      throw e;
    }
    res.status(201).json({ memory: hydrate(db, [getMemory(m.id)])[0] });
  }));

  r.delete('/memories/:id/media/:mediaId', requireWriter, (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only change memories you added.');
    const row = db.prepare('SELECT id FROM media WHERE id = ? AND memory_id = ?').get(req.params.mediaId, m.id);
    if (!row) throw new HttpError(404, 'File not found');
    db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    removeFiles(config, [row.id]);
    res.json({ ok: true });
  });

  // ---- Delete ------------------------------------------------------------
  r.delete('/memories/:id', requireWriter, (req, res) => {
    const m = loadVisible(req.params.id, req.user);
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only delete memories you added.');
    const ids = db.prepare('SELECT id FROM media WHERE memory_id = ?').all(m.id).map((x) => x.id);
    db.transaction(() => {
      db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(m.id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(m.id);
    })();
    removeFiles(config, ids);
    res.json({ ok: true });
  });

  return r;
};

module.exports.fileExists = (p) => fs.existsSync(p);
