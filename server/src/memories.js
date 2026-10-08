'use strict';
const { reindex } = require('./db');

/** SQL fragment: rows a given user may see. Bind @uid. */
const VISIBLE = "(m.privacy = 'family' OR m.created_by = @uid)";

const canView = (m, user) => m.privacy === 'family' || m.created_by === user.id;
const canEdit = (m, user) =>
  user.role !== 'viewer' && canView(m, user) && (m.created_by === user.id || user.role === 'owner');

function inChunks(arr, n = 400) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Turn memory rows into API objects with tags, people, media and contributor. */
function hydrate(db, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const tags = new Map(), people = new Map(), media = new Map();
  for (const chunk of inChunks(ids)) {
    const q = chunk.map(() => '?').join(',');
    for (const t of db.prepare(`SELECT memory_id, tag FROM memory_tags WHERE memory_id IN (${q}) ORDER BY tag`).all(...chunk)) {
      (tags.get(t.memory_id) || tags.set(t.memory_id, []).get(t.memory_id)).push(t.tag);
    }
    for (const p of db.prepare(`SELECT memory_id, name, relationship FROM memory_people WHERE memory_id IN (${q}) ORDER BY name`).all(...chunk)) {
      (people.get(p.memory_id) || people.set(p.memory_id, []).get(p.memory_id)).push({ name: p.name, relationship: p.relationship });
    }
    for (const m of db.prepare(`SELECT * FROM media WHERE memory_id IN (${q}) ORDER BY created_at, rowid`).all(...chunk)) {
      (media.get(m.memory_id) || media.set(m.memory_id, []).get(m.memory_id)).push({
        id: m.id, kind: m.kind, mimeType: m.mime, originalName: m.original_name,
        size: m.size_plain, duration: m.duration, url: `/api/media/${m.id}`,
      });
    }
  }
  const jobState = new Map();
  for (const chunk of inChunks(ids)) {
    const q = chunk.map(() => '?').join(',');
    for (const j of db.prepare(
      `SELECT memory_id, status FROM ai_jobs WHERE kind = 'transcribe' AND status IN ('pending','running','failed') AND memory_id IN (${q})`
    ).all(...chunk)) {
      if (j.status !== 'failed' || !jobState.has(j.memory_id)) jobState.set(j.memory_id, j.status === 'failed' ? 'failed' : 'pending');
    }
  }
  const users = new Map(db.prepare('SELECT id, display_name FROM users').all().map((u) => [u.id, u.display_name]));
  return rows.map((m) => ({
    id: m.id,
    type: m.type,
    title: m.title,
    description: m.description,
    content: m.content,
    transcript: m.transcript,
    transcriptSource: m.transcript_source,
    transcriptLanguages: JSON.parse(m.transcript_languages || '[]'),
    transcriptJob: m.transcript ? null : jobState.get(m.id) || null,
    memoryDate: m.memory_date,
    datePrecision: m.date_precision,
    location: m.location,
    privacy: m.privacy,
    promptId: m.prompt_id,
    aiSummary: m.ai_summary,
    aiSource: m.ai_source,
    tags: tags.get(m.id) || [],
    people: people.get(m.id) || [],
    media: media.get(m.id) || [],
    contributor: { id: m.created_by, displayName: users.get(m.created_by) || 'Unknown' },
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  }));
}

/** Replace a memory's tags/people and refresh its search index. Run inside a transaction. */
function setTagsPeople(db, id, tags, people) {
  db.prepare('DELETE FROM memory_tags WHERE memory_id = ?').run(id);
  db.prepare('DELETE FROM memory_people WHERE memory_id = ?').run(id);
  const it = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?,?)');
  const ip = db.prepare('INSERT OR IGNORE INTO memory_people (memory_id, name, relationship) VALUES (?,?,?)');
  for (const t of tags) it.run(id, t);
  for (const p of people) ip.run(id, p.name, p.relationship || '');
  reindex(db, id);
}

module.exports = { VISIBLE, canView, canEdit, hydrate, setTagsPeople, inChunks };
