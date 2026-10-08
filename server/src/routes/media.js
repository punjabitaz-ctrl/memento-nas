'use strict';
const express = require('express');
const { once } = require('node:events');
const { HttpError, wrap } = require('../util');
const { canView } = require('../memories');
const { openDecryptStream, plainSizeOf, DecryptError } = require('../crypto');
const { vaultPath } = require('../uploads');

const INLINE = /^(image\/(jpeg|png|gif|webp|avif)|audio\/|video\/|application\/pdf|text\/plain)/;

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (n === 0) return 'invalid';
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

module.exports = function mediaRoutes({ db, config, requireAuth }) {
  const r = express.Router();
  r.use(requireAuth);

  r.get('/media/:id', wrap(async (req, res) => {
    const row = db.prepare(
      'SELECT md.*, m.privacy, m.created_by FROM media md JOIN memories m ON m.id = md.memory_id WHERE md.id = ?'
    ).get(req.params.id);
    if (!row || !canView(row, req.user)) throw new HttpError(404, 'File not found');

    const file = vaultPath(config, row.id);
    let iter, first, range, total;
    try {
      total = await plainSizeOf(file);
      range = parseRange(req.headers.range, total);
      if (range === 'invalid') {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }
      const opened = range
        ? await openDecryptStream(file, config.key, row.id, range.start, range.end)
        : await openDecryptStream(file, config.key, row.id);
      iter = opened.stream[Symbol.asyncIterator]();
      first = await iter.next(); // verifies the first chunk BEFORE any header is sent
    } catch (e) {
      if (iter) iter.return && iter.return();
      if (e.code === 'ENOENT') throw new HttpError(410, 'This file is missing from the vault. Restore it from backup.');
      if (e instanceof DecryptError) {
        console.error(`[integrity] media ${row.id}: ${e.message}`);
        throw new HttpError(500, 'This file failed its integrity check (corrupted, or the key is wrong).');
      }
      throw e;
    }

    const inline = INLINE.test(row.mime) && req.query.download !== '1';
    const safeName = (row.original_name || row.id).replace(/[^\w.\- ]/g, '_');
    res.status(range ? 206 : 200);
    res.set({
      'Content-Type': row.mime,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range ? range.end - range.start + 1 : total),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      // Uploaded files are untrusted: never let the browser sniff or execute them.
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'",
      'Cache-Control': 'private, no-cache',
    });
    if (range) res.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`);

    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    try {
      let step = first;
      while (!step.done && !closed) {
        if (!res.write(step.value)) await once(res, 'drain').catch(() => {});
        step = await iter.next();
      }
      if (!closed) res.end();
    } catch (e) {
      // A later chunk failed verification: cut the connection so a half-verified file is never mistaken for a whole one.
      console.error(`[integrity] media ${row.id} stream error: ${e.message}`);
      res.destroy();
    } finally {
      if (iter && iter.return) iter.return();
    }
  }));

  return r;
};
