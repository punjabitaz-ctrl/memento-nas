'use strict';
const crypto = require('node:crypto');
const clientDefault = require('./client');
const { memoryText } = require('./hooks');

// Sentence ends: . ! ? plus the Devanagari/Gurmukhi danda and Urdu/Arabic full stop and question mark.
const SENTENCE_END = /(?<=[.!?\u0964\u06D4\u061F])\s+/u;
// Approximate: tokenisers differ by model and script. 3 chars/token is deliberately conservative for Latin text.
const estTokens = (s) => Math.ceil(s.length / 3);
const BATCH = 16;

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
        out.push(sent.slice(0, cut).trim());
        sent = sent.slice(cut).trim();
      }
      if (!sent) continue;
      if (estTokens(cur) + estTokens(sent) > maxTokens) flush();
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
      vectors.push(...(await registry.withNode('embed', m.privacy, (node) => client.embed(node, batch))));
    }
    const dim = vectors[0].length;
    if (vectors.some((v) => v.length !== dim)) throw new Error('embedding dimension changed within one memory');

    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('DELETE FROM chunks WHERE memory_id = ?').run(m.id);
      const ins = db.prepare('INSERT INTO chunks (id, memory_id, ord, text, model, dim, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)');
      pieces.forEach((text, i) => ins.run(crypto.randomUUID(), m.id, i, text, config.ai.embedModel, dim, toBlob(vectors[i]), now));
    })();
  };
}

module.exports = { chunkText, normalize, toBlob, embedInput, makeEmbedHandler };
