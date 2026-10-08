'use strict';
const crypto = require('node:crypto');
const clientDefault = require('./client');
const { memoryText } = require('./hooks');

// Sentence ends: . ! ? plus the Devanagari/Gurmukhi danda and double danda and the Urdu/Arabic full stop and
// question mark (all followed by whitespace), and the full-width ideographic marks, which need no whitespace after.
const SENTENCE_END = /(?<=[.!?\u0964\u0965\u06D4\u061F])\s+|(?<=[\u3002\uFF01\uFF1F])\s*/u;
// Approximate: tokenisers differ by model and script. 3 chars/token is deliberately conservative for Latin text.
const estTokens = (s) => Math.ceil(s.length / 3);
const BATCH = 16;

const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;

/**
 * Moves a hard cut offset back so it never lands inside a surrogate pair, or (where possible) just before a
 * combining mark / vowel sign that belongs to the previous character. Never returns less than 1.
 */
function safeCut(s, cut) {
  const noPairSplit = (c) => { while (c > 1 && isLowSurrogate(s.charCodeAt(c))) c--; return c; };
  let c = cut;
  while (c > 1 && (isLowSurrogate(s.charCodeAt(c)) || /^\p{M}/u.test(s.slice(c, c + 2)))) c--;
  return c > 1 ? c : noPairSplit(cut); // a run of marks all the way back: settle for a pair-safe cut
}

/** Splits text into chunks of roughly <= maxTokens, preferring sentence boundaries. */
function chunkText(text, maxTokens = 200) {
  const maxChars = maxTokens * 3;
  const out = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  for (const para of String(text).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    for (const s of para.split(SENTENCE_END)) {
      let sent = s.trim();
      while (sent.length > maxChars) { // one enormous "sentence": cut at a space near the limit
        flush();
        let cut = sent.lastIndexOf(' ', maxChars);
        if (cut < maxChars / 2) cut = maxChars;
        cut = safeCut(sent, cut);
        out.push(sent.slice(0, cut).trim());
        sent = sent.slice(cut).trim();
      }
      if (!sent) continue;
      if (estTokens(cur ? cur + ' ' + sent : sent) > maxTokens) flush();
      cur += (cur ? ' ' : '') + sent;
    }
  }
  flush();
  return out;
}

function normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  return norm ? vec.map((x) => x / norm) : vec.slice();
}

/** Unit-length float32 little-endian, so cosine similarity is a plain dot product. */
function toBlob(vec) {
  const v = normalize(vec);
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return buf;
}

/** The text that gets embedded: a short context header (who/when/what) plus the chunk. */
function embedInput(m, contributor, people, chunk) {
  const head = [m.title || 'Untitled', m.memory_date || '', contributor ? `by ${contributor}` : '', people.length ? `people: ${people.join(', ')}` : '']
    .filter(Boolean).join(' | ');
  return `${head}\n${chunk}`;
}

function makeEmbedHandler({ db, config, registry, client = clientDefault }) {
  return async function embedJob(job) {
    const m = db.prepare('SELECT * FROM memories WHERE id = ?').get(job.memory_id);
    if (!m) return { skip: 'memory no longer exists' };
    const pieces = chunkText(memoryText(m), config.ai.chunkTokens);
    if (!pieces.length) {
      db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(m.id);
      return;
    }
    const who = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(m.created_by) || {}).display_name || '';
    const people = db.prepare('SELECT name FROM memory_people WHERE memory_id = ? ORDER BY name').all(m.id).map((p) => p.name);
    const inputs = pieces.map((p) => embedInput(m, who, people, p));

    const vectors = [];
    for (let i = 0; i < inputs.length; i += BATCH) {
      const batch = inputs.slice(i, i + BATCH);
      // A batch can take minutes, so privacy is re-read right before each request: a memory made private
      // meanwhile must not reach a non-local node (withNode then throws NoEligibleNode).
      const cur = db.prepare('SELECT privacy FROM memories WHERE id = ?').get(m.id);
      if (!cur) return { skip: 'memory no longer exists' };
      vectors.push(...(await registry.withNode('embed', cur.privacy, (node) => client.embed(node, batch))));
    }
    const dim = vectors[0].length;
    if (vectors.some((v) => v.length !== dim)) throw new Error('embedding dimension changed within one memory');
    for (const v of vectors) {
      if (!v.every((x) => Number.isFinite(x))) throw new Error('embedding contains non-finite values');
      if (v.every((x) => x === 0)) throw new Error('embedding is all zeros');
    }

    const now = new Date().toISOString();
    return db.transaction(() => {
      // Edited while we were embedding: these chunks are stale. The edit queued a fresh embed job.
      const latest = db.prepare('SELECT updated_at FROM memories WHERE id = ?').get(m.id);
      if (!latest) return { skip: 'memory no longer exists' };
      if (latest.updated_at !== m.updated_at) return { skip: 'memory changed while embedding' };
      db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(m.id);
      const ins = db.prepare('INSERT INTO chunks (id, memory_id, ord, text, model, dim, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)');
      pieces.forEach((text, i) => ins.run(crypto.randomUUID(), m.id, i, text, config.ai.embedModel, dim, toBlob(vectors[i]), now));
    })();
  };
}

module.exports = { chunkText, normalize, toBlob, embedInput, makeEmbedHandler };
