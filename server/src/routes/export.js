'use strict';
/**
 * One-click estate export: a plain zip of everything the requester can see,
 * decrypted, with metadata. Streamed one file at a time (low memory on a NAS).
 */
const path = require('node:path');
const express = require('express');
const archiver = require('archiver');
const { once } = require('node:events');
const { VISIBLE, hydrate, inChunks } = require('../memories');
const { openDecryptStream } = require('../crypto');
const { vaultPath } = require('../uploads');
const { slug } = require('../util');

function storyMarkdown(m) {
  const when = m.memoryDate ? (m.datePrecision === 'year' ? m.memoryDate.slice(0, 4) : m.datePrecision === 'month' ? m.memoryDate.slice(0, 7) : m.memoryDate) : 'Date unknown';
  const lines = [`# ${m.title || '(untitled)'}`, '', `*${when}${m.location ? ' · ' + m.location : ''} · added by ${m.contributor.displayName}*`, ''];
  if (m.people.length) lines.push(`**People:** ${m.people.map((p) => p.name + (p.relationship ? ` (${p.relationship})` : '')).join(', ')}`, '');
  if (m.tags.length) lines.push(`**Tags:** ${m.tags.join(', ')}`, '');
  if (m.description) lines.push(m.description, '');
  if (m.content) lines.push(m.content, '');
  if (m.transcript) lines.push('## Transcript', '', m.transcript, '');
  return lines.join('\n');
}

module.exports = function exportRoutes({ db, config, requireAuth }) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/export', async (req, res, next) => {
    try {
      const rows = db.prepare(`SELECT m.* FROM memories m WHERE ${VISIBLE} ORDER BY m.memory_date IS NULL, m.memory_date, m.created_at`).all({ uid: req.user.id });
      const memories = [];
      for (const chunk of inChunks(rows, 200)) memories.push(...hydrate(db, chunk));

      const stamp = new Date().toISOString().slice(0, 10);
      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="memento-export-${stamp}.zip"`,
        'Cache-Control': 'no-store',
      });
      const archive = archiver('zip', { zlib: { level: 1 } });
      const errors = [];
      let aborted = false;
      res.on('close', () => {
        if (!res.writableFinished) {
          aborted = true;
          archive.abort();
        }
      });
      archive.on('error', (e) => {
        console.error('[export] archive error:', e.message);
        res.destroy();
      });
      archive.pipe(res);

      archive.append(JSON.stringify({ exportedAt: new Date().toISOString(), exportedBy: req.user.display_name, memories }, null, 2), { name: 'memories.json' });
      archive.append(
        memories.map(storyMarkdown).join('\n\n---\n\n') || '# No memories yet\n',
        { name: 'stories.md' }
      );

      for (const m of memories) {
        const year = m.memoryDate ? m.memoryDate.slice(0, 4) : 'undated';
        const folder = `files/${year}/${slug(m.title)}-${m.id.slice(0, 8)}`;
        const used = new Set();
        for (const f of m.media) {
          if (aborted) return;
          let name = path.basename(f.originalName || `${f.id}`).replace(/[^\w.\- ]/g, '_') || f.id;
          if (used.has(name)) name = `${f.id.slice(0, 8)}-${name}`;
          used.add(name);
          try {
            const { stream } = await openDecryptStream(vaultPath(config, f.id), config.key, f.id);
            const done = once(archive, 'entry');
            archive.append(stream, { name: `${folder}/${name}`, store: true });
            await done; // one open file at a time
          } catch (e) {
            errors.push(`${folder}/${name}: ${e.code === 'ENOENT' ? 'file missing from vault' : e.message}`);
          }
        }
      }
      if (errors.length) archive.append(`These files could not be exported:\n\n${errors.join('\n')}\n`, { name: 'EXPORT_ERRORS.txt' });
      await archive.finalize();
    } catch (e) {
      if (!res.headersSent) next(e);
      else res.destroy();
    }
  });

  return r;
};
