'use strict';
const clientDefault = require('./client');
const { VISIBLE, canView } = require('../memories');
const { normalize } = require('./embed');
const { memoryText } = require('./hooks');
const { ftsQuery } = require('../util');
const { NodeError } = clientDefault;
const { NodeUnavailable, NoEligibleNode } = require('./errors');

const RRF_K = 60; // reciprocal rank fusion constant (standard default)
const KEYWORD_LIMIT = 20;
const VECTOR_LIMIT = 20;

/**
 * Brute-force cosine over visible chunks: fine at family scale, measure before changing.
 * Only the id and vector are read during the scan; the text is fetched for the final top-k alone.
 * Returns [{ memoryId, text, score }], best first.
 */
function scanChunks(db, qv, { uid, model, limit }) {
  const stmt = db.prepare(
    `SELECT c.id AS chunkId, c.memory_id AS memoryId, c.embedding FROM chunks c JOIN memories m ON m.id = c.memory_id WHERE c.model = @model AND ${VISIBLE}`
  );
  const top = [];
  for (const row of stmt.iterate({ model, uid })) {
    const buf = row.embedding;
    if (buf.length !== qv.length * 4) continue; // vector from a different dimension: not comparable
    let dot = 0;
    for (let i = 0; i < qv.length; i++) dot += qv[i] * buf.readFloatLE(i * 4);
    if (!Number.isFinite(dot)) continue; // corrupt vector: never let NaN into the ranking
    if (top.length < limit || dot > top[top.length - 1].score) {
      top.push({ chunkId: row.chunkId, memoryId: row.memoryId, score: dot });
      top.sort((a, b) => b.score - a.score);
      if (top.length > limit) top.pop();
    }
  }
  if (!top.length) return [];
  const texts = new Map(
    db.prepare(`SELECT id, text FROM chunks WHERE id IN (${top.map(() => '?').join(',')})`).all(...top.map((t) => t.chunkId)).map((r) => [r.id, r.text])
  );
  return top.map((t) => ({ memoryId: t.memoryId, text: texts.get(t.chunkId), score: t.score }));
}

/**
 * Finds passages from memories the asking user is allowed to see. Visibility is enforced in SQL (VISIBLE)
 * for both the keyword and the vector path, and re-checked with canView on every returned memory.
 */
async function retrieve({ db, registry, config, user, question, k = 6, client = clientDefault }) {
  const uid = user.id;
  const rrf = new Map(); // memoryId -> fused score
  const via = new Map(); // memoryId -> Set('fts'|'vec')
  const best = new Map(); // memoryId -> up to 2 best chunk texts
  const add = (id, rank, source) => {
    rrf.set(id, (rrf.get(id) || 0) + 1 / (RRF_K + rank));
    (via.get(id) || via.set(id, new Set()).get(id)).add(source);
  };

  const q = ftsQuery(question, { mode: 'or' });
  if (q) {
    const rows = db.prepare(
      `SELECT memory_fts.memory_id AS id FROM memory_fts JOIN memories m ON m.id = memory_fts.memory_id
       WHERE memory_fts MATCH @q AND ${VISIBLE} ORDER BY bm25(memory_fts) LIMIT ${KEYWORD_LIMIT}`
    ).all({ q, uid });
    rows.forEach((r, i) => add(r.id, i + 1, 'fts'));
  }

  let mode = 'keyword';
  let degraded = false;
  // A question with no letters or digits cannot be embedded meaningfully: skip the node round trip.
  const embeddable = /[\p{L}\p{N}]/u.test(String(question || ''));
  if (embeddable && config.ai.enabled && config.ai.embedModel && registry && registry.hasEligible('embed', 'family')) {
    try {
      // The question is the asker's own words, not a memory, so any node may embed it.
      const [qv] = await registry.withNode('embed', 'family', (node) => client.embed(node, [question]));
      const hits = scanChunks(db, normalize(qv), { uid, model: config.ai.embedModel, limit: VECTOR_LIMIT });
      const seen = new Set();
      let rank = 0;
      for (const h of hits) {
        const list = best.get(h.memoryId) || best.set(h.memoryId, []).get(h.memoryId);
        if (list.length < 2) list.push(h.text);
        if (!seen.has(h.memoryId)) { seen.add(h.memoryId); add(h.memoryId, ++rank, 'vec'); }
      }
      // Nothing embedded with the configured model yet (model changed, backfill pending): keyword only.
      if (db.prepare('SELECT 1 FROM chunks WHERE model = ? LIMIT 1').get(config.ai.embedModel)) mode = 'hybrid';
    } catch (e) {
      // Any failure of the embed/vector step (node down, HTTP 400/401, malformed reply) degrades to keyword search.
      // Anything else is a programmer error and must surface.
      if (!(e instanceof NodeUnavailable) && !(e instanceof NodeError) && !(e instanceof NoEligibleNode)) throw e;
      degraded = !(e instanceof NoEligibleNode);
    }
  }

  const ranked = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
  const passages = [];
  for (const [id, score] of ranked) {
    const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!m || !canView(m, user)) continue; // defence in depth
    const chunkTexts = best.get(id);
    passages.push({
      memoryId: id, title: m.title, memoryDate: m.memory_date, datePrecision: m.date_precision, privacy: m.privacy,
      text: chunkTexts && chunkTexts.length ? chunkTexts.join('\n\n') : memoryText(m).slice(0, 1500),
      via: [...via.get(id)], score,
    });
  }
  return { passages, degraded, mode };
}

module.exports = { retrieve, scanChunks };
