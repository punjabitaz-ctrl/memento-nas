'use strict';
/**
 * Chunked, authenticated file encryption (AES-256-GCM, STREAM-style).
 *
 * Why chunked: a single GCM tag at the end of a file means a streamed
 * download would hand unverified plaintext to the browser and cannot seek.
 * Each 64 KiB chunk has its own tag, so every byte is verified before it is
 * released, and audio/video can seek via HTTP Range without decrypting the
 * whole file.
 *
 * File layout:
 *   "MEM2" (4) | file salt (16) | chunk0 | chunk1 | ... | chunkN
 *   chunk = ciphertext (<=64 KiB) || GCM tag (16)
 *
 * - Per-file key  = HKDF-SHA256(masterKey, salt=fileSalt, info="memento-file-v2")
 * - Nonce         = 12 bytes, big-endian chunk counter (unique per key)
 * - AAD           = [isFinalChunk] || recordId
 *   -> reordering/truncating chunks, or swapping a file onto another record,
 *      fails authentication.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Transform, Readable } = require('node:stream');

const MAGIC = Buffer.from('MEM2');
const SALT_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN;
const CHUNK = 64 * 1024;
const TAG_LEN = 16;
const ENC_CHUNK = CHUNK + TAG_LEN;
const INFO = Buffer.from('memento-file-v2');

class DecryptError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'DecryptError';
  }
}

function fileKey(master, salt) {
  return Buffer.from(crypto.hkdfSync('sha256', master, salt, INFO, 32));
}

function nonce(counter) {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(counter >>> 0, 8);
  return n;
}

function aadFor(final, recordId) {
  return Buffer.concat([Buffer.from([final ? 1 : 0]), Buffer.from(String(recordId))]);
}

function seal(key, counter, plain, final, recordId) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce(counter), { authTagLength: TAG_LEN });
  c.setAAD(aadFor(final, recordId));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function open(key, counter, enc, final, recordId) {
  if (enc.length < TAG_LEN) throw new DecryptError('Truncated chunk');
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce(counter), { authTagLength: TAG_LEN });
  d.setAAD(aadFor(final, recordId));
  d.setAuthTag(enc.subarray(enc.length - TAG_LEN));
  try {
    return Buffer.concat([d.update(enc.subarray(0, enc.length - TAG_LEN)), d.final()]);
  } catch {
    throw new DecryptError('Authentication failed: data is corrupted, tampered with, or the key is wrong');
  }
}

/** Transform stream: plaintext in, MEM2 ciphertext out. Exposes plainBytes. */
class EncryptStream extends Transform {
  constructor(masterKey, recordId) {
    super();
    this.salt = crypto.randomBytes(SALT_LEN);
    this.key = fileKey(masterKey, this.salt);
    this.recordId = recordId;
    this.counter = 0;
    this.pending = Buffer.alloc(0);
    this.headerSent = false;
    this.plainBytes = 0;
  }
  _header() {
    if (!this.headerSent) {
      this.push(Buffer.concat([MAGIC, this.salt]));
      this.headerSent = true;
    }
  }
  _transform(data, _enc, cb) {
    try {
      this._header();
      this.plainBytes += data.length;
      this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data;
      // Keep 1..CHUNK bytes pending so the last chunk can be flagged final.
      while (this.pending.length > CHUNK) {
        this.push(seal(this.key, this.counter++, this.pending.subarray(0, CHUNK), false, this.recordId));
        this.pending = this.pending.subarray(CHUNK);
      }
      cb();
    } catch (e) {
      cb(e);
    }
  }
  _flush(cb) {
    try {
      this._header();
      this.push(seal(this.key, this.counter++, this.pending, true, this.recordId));
      cb();
    } catch (e) {
      cb(e);
    }
  }
}

function layout(fileSize) {
  const body = fileSize - HEADER_LEN;
  if (body < TAG_LEN) throw new DecryptError('Not a valid Memento file (too small)');
  const chunks = Math.ceil(body / ENC_CHUNK);
  const plainSize = body - chunks * TAG_LEN;
  if (plainSize < 0) throw new DecryptError('Not a valid Memento file');
  return { chunks, plainSize };
}

async function readHeader(fh, masterKey) {
  const h = Buffer.alloc(HEADER_LEN);
  const { bytesRead } = await fh.read(h, 0, HEADER_LEN, 0);
  if (bytesRead < HEADER_LEN || !h.subarray(0, 4).equals(MAGIC)) {
    throw new DecryptError('Not a valid Memento file (bad header)');
  }
  return fileKey(masterKey, h.subarray(4, HEADER_LEN));
}

/** Plaintext size of an encrypted file, computed from its on-disk size. */
async function plainSizeOf(filePath) {
  const st = await fs.promises.stat(filePath);
  return layout(st.size).plainSize;
}

/**
 * Open a verified plaintext stream for bytes [start, end] (inclusive).
 * Every chunk's tag is verified before its bytes are emitted.
 */
async function openDecryptStream(filePath, masterKey, recordId, start = 0, end = null) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const { chunks, plainSize } = layout(st.size);
    const last = end === null ? plainSize - 1 : Math.min(end, plainSize - 1);
    const key = await readHeader(fh, masterKey);

    async function* gen() {
      try {
        if (plainSize === 0 || start > last) {
          // still verify the (empty) final chunk
          if (plainSize === 0) {
            const b = Buffer.alloc(TAG_LEN);
            await fh.read(b, 0, TAG_LEN, HEADER_LEN);
            open(key, 0, b, true, recordId);
          }
          return;
        }
        const first = Math.floor(start / CHUNK);
        const lastIdx = Math.floor(last / CHUNK);
        for (let i = first; i <= lastIdx; i++) {
          const offset = HEADER_LEN + i * ENC_CHUNK;
          const isFinal = i === chunks - 1;
          const len = isFinal ? st.size - offset : ENC_CHUNK;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, offset);
          if (bytesRead !== len) throw new DecryptError('Unexpected end of file');
          let plain = open(key, i, buf, isFinal, recordId);
          const chunkStart = i * CHUNK;
          const from = Math.max(start - chunkStart, 0);
          const to = Math.min(last - chunkStart + 1, plain.length);
          if (from > 0 || to < plain.length) plain = plain.subarray(from, to);
          yield plain;
        }
      } finally {
        await fh.close().catch(() => {});
      }
    }
    return { size: plainSize, stream: Readable.from(gen(), { objectMode: false }) };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

/** In-memory helpers for small values (key check canary, tests). */
function encryptBuffer(masterKey, recordId, plain) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = fileKey(masterKey, salt);
  const parts = [MAGIC, salt];
  let counter = 0;
  let off = 0;
  while (plain.length - off > CHUNK) {
    parts.push(seal(key, counter++, plain.subarray(off, off + CHUNK), false, recordId));
    off += CHUNK;
  }
  parts.push(seal(key, counter, plain.subarray(off), true, recordId));
  return Buffer.concat(parts);
}

function decryptBuffer(masterKey, recordId, enc) {
  const { chunks } = layout(enc.length);
  if (!enc.subarray(0, 4).equals(MAGIC)) throw new DecryptError('Bad header');
  const key = fileKey(masterKey, enc.subarray(4, HEADER_LEN));
  const out = [];
  for (let i = 0; i < chunks; i++) {
    const s = HEADER_LEN + i * ENC_CHUNK;
    const isFinal = i === chunks - 1;
    out.push(open(key, i, enc.subarray(s, isFinal ? enc.length : s + ENC_CHUNK), isFinal, recordId));
  }
  return Buffer.concat(out);
}

module.exports = {
  EncryptStream,
  openDecryptStream,
  plainSizeOf,
  encryptBuffer,
  decryptBuffer,
  DecryptError,
  CHUNK,
  HEADER_LEN,
};
