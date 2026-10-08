'use strict';
/**
 * Streaming multipart upload straight into the encrypted vault.
 * Bytes flow: request -> AES-256-GCM encrypt -> /data/vault/<id>.part -> rename.
 * Plaintext is never written to disk (no temp file).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const Busboy = require('busboy');
const { EncryptStream } = require('./crypto');
const { HttpError } = require('./util');

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', rtf: 'application/rtf',
  doc: 'application/msword', odt: 'application/vnd.oasis.opendocument.text',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const DOC_MIMES = new Set([
  'application/pdf', 'text/plain', 'text/markdown', 'application/rtf', 'application/msword',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

function normalizeMime(mimeType, filename) {
  let m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!m || m === 'application/octet-stream') {
    const ext = path.extname(filename || '').slice(1).toLowerCase();
    m = EXT_MIME[ext] || m;
  }
  return m;
}

/** Returns 'image' | 'audio' | 'video' | 'document' | null. SVG is deliberately NOT allowed (script vector). */
function kindOf(mime) {
  if (mime === 'image/svg+xml') return null;
  if (/^image\/(jpeg|png|gif|webp|heic|heif|avif)$/.test(mime)) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (DOC_MIMES.has(mime)) return 'document';
  return null;
}

function vaultPath(config, id, ext = 'enc') {
  return path.join(config.dirs.vault, `${id}.${ext}`);
}

function removeFiles(config, ids) {
  for (const id of ids) {
    for (const ext of ['enc', 'part']) {
      try {
        fs.unlinkSync(vaultPath(config, id, ext));
      } catch {
        /* already gone */
      }
    }
  }
}

function parseUpload(req, config) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    if (!/^multipart\/form-data/i.test(ct)) return reject(new HttpError(415, 'Expected multipart/form-data'));

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: config.maxFileBytes, files: 20, fields: 60, fieldSize: 2 * 1024 * 1024, parts: 100 },
      });
    } catch {
      return reject(new HttpError(400, 'Malformed upload'));
    }

    const fields = {};
    const files = [];
    const writing = [];
    const allIds = [];
    let failure = null;
    let settled = false;

    const fail = (err) => {
      if (!failure) failure = err instanceof HttpError ? err : new HttpError(400, 'Upload failed');
    };
    const finish = async () => {
      if (settled) return;
      settled = true;
      await Promise.allSettled(writing);
      if (failure) {
        removeFiles(config, allIds);
        return reject(failure);
      }
      resolve({ fields, files });
    };

    bb.on('field', (name, val, info) => {
      if (info.valueTruncated || info.nameTruncated) return fail(new HttpError(413, 'A text field was too large'));
      fields[name] = val;
    });

    bb.on('file', (_name, stream, info) => {
      const filename = (info.filename || '').slice(0, 255);
      if (!filename) return stream.resume(); // empty file input
      const mime = normalizeMime(info.mimeType, filename);
      const kind = kindOf(mime);
      if (!kind) {
        stream.resume();
        return fail(new HttpError(415, `"${filename}" is not a supported file type`));
      }
      if (failure) return stream.resume();

      const id = crypto.randomUUID();
      allIds.push(id);
      const enc = new EncryptStream(config.key, id);
      const part = vaultPath(config, id, 'part');
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
      });
      writing.push(
        new Promise((done) => {
          pipeline(stream, enc, fs.createWriteStream(part, { mode: 0o600 }), (err) => {
            if (err) fail(new HttpError(500, 'Could not store file'));
            else if (truncated) fail(new HttpError(413, `"${filename}" is larger than the ${config.maxFileMb} MB limit`));
            else {
              try {
                fs.renameSync(part, vaultPath(config, id));
                files.push({ id, filename, mime, kind, sizePlain: enc.plainBytes });
              } catch {
                fail(new HttpError(500, 'Could not store file'));
              }
            }
            done();
          });
        })
      );
    });

    bb.on('filesLimit', () => fail(new HttpError(413, 'Too many files in one upload (max 20)')));
    bb.on('partsLimit', () => fail(new HttpError(413, 'Too many parts in upload')));
    bb.on('error', () => fail(new HttpError(400, 'Malformed upload')));
    bb.on('close', finish);
    req.on('aborted', () => {
      fail(new HttpError(400, 'Upload cancelled'));
      finish();
    });
    req.pipe(bb);
  });
}

module.exports = { parseUpload, removeFiles, vaultPath, kindOf, normalizeMime };
