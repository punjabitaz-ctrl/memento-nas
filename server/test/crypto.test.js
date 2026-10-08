'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const C = require('../src/crypto');

const KEY = crypto.randomBytes(32);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-crypto-'));

async function encryptTo(file, data, id = 'rec1', key = KEY) {
  const enc = new C.EncryptStream(key, id);
  await pipeline(Readable.from([data]), enc, fs.createWriteStream(file));
  return enc.plainBytes;
}
async function readAll(s) {
  const out = [];
  for await (const c of s) out.push(c);
  return Buffer.concat(out);
}

const SIZES = [0, 1, 100, C.CHUNK - 1, C.CHUNK, C.CHUNK + 1, 3 * C.CHUNK, 3 * C.CHUNK + 777];

for (const n of SIZES) {
  test(`round trip ${n} bytes, ciphertext is not plaintext`, async () => {
    const data = crypto.randomBytes(n);
    const f = path.join(tmp, `rt-${n}.enc`);
    assert.equal(await encryptTo(f, data), n);
    assert.equal(await C.plainSizeOf(f), n);
    const { size, stream } = await C.openDecryptStream(f, KEY, 'rec1');
    assert.equal(size, n);
    assert.deepEqual(await readAll(stream), data);
    if (n >= 64) {
      const raw = fs.readFileSync(f);
      assert.equal(raw.includes(data.subarray(0, 64)), false, 'plaintext leaked to disk');
    }
  });
}

test('range reads match plaintext slices (incl. across chunk boundaries)', async () => {
  const data = crypto.randomBytes(3 * C.CHUNK + 5000);
  const f = path.join(tmp, 'range.enc');
  await encryptTo(f, data);
  const ranges = [
    [0, 0], [0, 10], [C.CHUNK - 5, C.CHUNK + 5], [C.CHUNK, C.CHUNK],
    [2 * C.CHUNK + 1, data.length - 1], [data.length - 1, data.length - 1],
  ];
  for (const [s, e] of ranges) {
    const { stream } = await C.openDecryptStream(f, KEY, 'rec1', s, e);
    assert.deepEqual(await readAll(stream), data.subarray(s, e + 1), `range ${s}-${e}`);
  }
});

test('same plaintext encrypts differently each time', async () => {
  const data = Buffer.from('identical content');
  const a = path.join(tmp, 'a.enc'), b = path.join(tmp, 'b.enc');
  await encryptTo(a, data); await encryptTo(b, data);
  assert.notDeepEqual(fs.readFileSync(a), fs.readFileSync(b));
});

test('tampering with any byte fails authentication', async () => {
  const data = crypto.randomBytes(2 * C.CHUNK + 100);
  const f = path.join(tmp, 'tamper.enc');
  await encryptTo(f, data);
  const raw = fs.readFileSync(f);
  for (const pos of [C.HEADER_LEN + 3, C.HEADER_LEN + C.CHUNK + 40, raw.length - 3]) {
    const bad = Buffer.from(raw);
    bad[pos] ^= 0x01;
    const bf = path.join(tmp, `bad-${pos}.enc`);
    fs.writeFileSync(bf, bad);
    const { stream } = await C.openDecryptStream(bf, KEY, 'rec1');
    await assert.rejects(readAll(stream), C.DecryptError, `flip at ${pos}`);
  }
});

test('truncation (dropping the final chunk) is detected', async () => {
  const data = crypto.randomBytes(3 * C.CHUNK);
  const f = path.join(tmp, 'trunc.enc');
  await encryptTo(f, data);
  const raw = fs.readFileSync(f);
  const cut = raw.subarray(0, C.HEADER_LEN + 2 * (C.CHUNK + 16)); // exactly 2 chunks
  const tf = path.join(tmp, 'trunc-cut.enc');
  fs.writeFileSync(tf, cut);
  const { stream } = await C.openDecryptStream(tf, KEY, 'rec1');
  await assert.rejects(readAll(stream), C.DecryptError);
});

test('swapping chunks is detected', async () => {
  const data = crypto.randomBytes(3 * C.CHUNK);
  const f = path.join(tmp, 'swap.enc');
  await encryptTo(f, data);
  const raw = fs.readFileSync(f);
  const E = C.CHUNK + 16, H = C.HEADER_LEN;
  const swapped = Buffer.concat([raw.subarray(0, H), raw.subarray(H + E, H + 2 * E), raw.subarray(H, H + E), raw.subarray(H + 2 * E)]);
  const sf = path.join(tmp, 'swap-bad.enc');
  fs.writeFileSync(sf, swapped);
  const { stream } = await C.openDecryptStream(sf, KEY, 'rec1');
  await assert.rejects(readAll(stream), C.DecryptError);
});

test('wrong key and wrong record id both fail', async () => {
  const f = path.join(tmp, 'wrong.enc');
  await encryptTo(f, Buffer.from('secret family story'));
  const wk = await C.openDecryptStream(f, crypto.randomBytes(32), 'rec1');
  await assert.rejects(readAll(wk.stream), C.DecryptError);
  const wr = await C.openDecryptStream(f, KEY, 'other-record');
  await assert.rejects(readAll(wr.stream), C.DecryptError);
});

test('non-Memento file is rejected', async () => {
  const f = path.join(tmp, 'junk.enc');
  fs.writeFileSync(f, crypto.randomBytes(500));
  await assert.rejects(C.openDecryptStream(f, KEY, 'x'), C.DecryptError);
});

test('buffer helpers round trip and detect wrong key', () => {
  const enc = C.encryptBuffer(KEY, 'canary', Buffer.from('hello'));
  assert.equal(C.decryptBuffer(KEY, 'canary', enc).toString(), 'hello');
  assert.throws(() => C.decryptBuffer(crypto.randomBytes(32), 'canary', enc), C.DecryptError);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
