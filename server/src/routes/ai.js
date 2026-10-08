'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { HttpError, wrap, str } = require('../util');
const { canEdit, canView } = require('../memories');
const { ask } = require('../ai/answer');
const jobs = require('../ai/jobs');
const { queueTranscribe } = require('../ai/hooks');
const { backfill } = require('../ai/backfill');
const { NodeUnavailable, NoEligibleNode } = require('../ai/errors');

module.exports = function aiRoutes({ db, config, requireAuth, requireWriter, registry }) {
  const r = express.Router();
  r.use(requireAuth);

  const needAi = () => {
    if (!config.ai.enabled || !registry) throw new HttpError(503, 'Local AI is not turned on for this vault.');
  };
  const ownLog = (req) => {
    const row = db.prepare('SELECT * FROM ask_log WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row) throw new HttpError(404, 'Question not found');
    return row;
  };

  r.get('/ai/status', (req, res) => {
    const owner = req.user.role === 'owner';
    res.json({
      enabled: config.ai.enabled,
      nodes: registry ? registry.status({ includeUrls: owner }) : [],
      queue: owner && config.ai.enabled ? jobs.stats(db) : null,
    });
  });

  r.post('/ai/backfill', wrap(async (req, res) => {
    if (req.user.role !== 'owner') throw new HttpError(403, 'Only the vault owner can do this.');
    needAi();
    res.json({ ...backfill(db, config), retried: jobs.retryFailed(db) });
  }));

  const limiter = rateLimit({
    windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => req.user.id,
    handler: (req, res) => res.status(429).json({ error: 'Too many questions in a minute. Please wait a little.' }),
  });

  r.post('/ask', limiter, wrap(async (req, res) => {
    needAi();
    const question = str(req.body && req.body.question, 500, { name: 'Question', required: true });
    if (question.length < 3) throw new HttpError(400, 'Please ask a longer question.');
    const lang = (req.body && req.body.lang) || 'en';
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) throw new HttpError(400, 'Unknown language code');
    try {
      res.json(await ask({ db, config, registry, user: req.user, question, lang }));
    } catch (e) {
      if (e instanceof NoEligibleNode) {
        throw new HttpError(503, 'No AI helper is set up for this kind of question yet.');
      }
      if (e instanceof NodeUnavailable) {
        throw new HttpError(503, 'The AI helper is not reachable right now. Try again when the computer that runs it is on.');
      }
      throw e;
    }
  }));

  r.get('/ask/history', (req, res) => {
    const rows = db.prepare('SELECT id, question, answer, outcome, created_at FROM ask_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
    res.json({ history: rows.map((x) => ({ id: x.id, question: x.question, answer: x.answer, outcome: x.outcome, createdAt: x.created_at })) });
  });

  r.delete('/ask/:id', (req, res) => {
    ownLog(req);
    db.prepare('DELETE FROM ask_log WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  r.post('/ask/:id/report', (req, res) => {
    ownLog(req);
    db.prepare("UPDATE ask_log SET outcome = 'reported' WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  });

  // A question the archive could not answer becomes a prompt for the elders: this closes the generational loop.
  // Idempotent: forwarding the same question again returns the prompt that already exists.
  r.post('/ask/:id/forward', requireWriter, (req, res) => {
    const row = ownLog(req);
    if (row.outcome !== 'no_record') {
      throw new HttpError(400, 'Only questions the archive could not answer can be sent to the family');
    }
    const text = `${req.user.display_name} asked: "${row.question}"`;
    const shape = (p) => ({ id: p.id, text: p.text, category: p.category, isCustom: true, addressedTo: JSON.parse(p.addressed_to || '[]') });
    const forward = db.transaction(() => {
      const existing = db.prepare("SELECT * FROM prompts WHERE source = 'ask' AND requested_by = ? AND text = ?").get(req.user.id, text);
      if (existing) return shape(existing);
      const elders = db.prepare("SELECT id FROM users WHERE persona = 'elder' AND disabled = 0").all().map((u) => u.id);
      const id = crypto.randomUUID();
      db.prepare(
        `INSERT INTO prompts (id, text, category, life_stage, is_custom, created_by, created_at, source, requested_by, addressed_to)
         VALUES (?,?,?,?,1,?,?,'ask',?,?)`
      ).run(id, text, 'family', null, req.user.id, new Date().toISOString(), req.user.id, JSON.stringify(elders));
      return { id, text, category: 'family', isCustom: true, addressedTo: elders };
    });
    res.json({ prompt: forward() });
  });

  r.post('/memories/:id/transcribe', wrap(async (req, res) => {
    needAi();
    const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(req.params.id);
    if (!m || !canView(m, req.user)) throw new HttpError(404, 'Memory not found');
    if (!canEdit(m, req.user)) throw new HttpError(403, 'You can only transcribe memories you added.');
    const overwrite = !!(req.body && req.body.overwrite);
    if (m.transcript_source === 'human' && !overwrite) {
      throw new HttpError(409, 'This transcript was written or corrected by a person. Send overwrite:true to replace it.');
    }
    // Check there is something to transcribe BEFORE touching anything.
    if (!db.prepare("SELECT 1 FROM media WHERE memory_id = ? AND kind IN ('audio','video')").get(m.id)) {
      throw new HttpError(400, 'This memory has no audio or video to transcribe.');
    }
    const queued = db.transaction(() => {
      if (m.transcript_source === 'human') {
        db.prepare("UPDATE memories SET transcript_source = '' WHERE id = ?").run(m.id);
      }
      return queueTranscribe(db, m.id, { force: true, skipBusy: true });
    })();
    res.status(202).json(queued ? { queued } : { queued: 0, alreadyQueued: true });
  }));

  return r;
};
