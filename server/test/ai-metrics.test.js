'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { wer, cer, normalizeForScoring } = require('../src/ai/metrics');

test('normalizeForScoring ignores case, punctuation and extra spaces', () => {
  assert.equal(normalizeForScoring('  Hello,   WORLD! '), 'hello world');
  assert.equal(normalizeForScoring('ਸਤ ਸ੍ਰੀ ਅਕਾਲ।'), 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ');
});

test('normalizeForScoring keeps combining marks (vowel signs, viramas) in Indic scripts', () => {
  // ਕਿ = ਕ + U+0A3F (Mc vowel sign I); ਸ੍ਰ contains U+0A4D (Mn virama); हिन्दी has U+093F and U+094D
  assert.equal(normalizeForScoring('ਕਿਤਾਬ,'), 'ਕਿਤਾਬ');
  assert.ok(normalizeForScoring('ਕਿਤਾਬ').includes('\u0A3F'));
  assert.ok(normalizeForScoring('ਸ੍ਰੀ').includes('\u0A4D'));
  assert.equal(normalizeForScoring('हिन्दी।'), 'हिन्दी');
  // a dropped mark must count as an error, not be silently ignored
  assert.ok(cer('ਕਿਤਾਬ', 'ਕਤਾਬ') > 0);
});

test('wer counts substitutions, insertions and deletions over reference words', () => {
  assert.equal(wer('a b c', 'a b c'), 0);
  assert.ok(Math.abs(wer('a b c', 'a x c') - 1 / 3) < 1e-9);
  assert.ok(Math.abs(wer('a b c', 'a b') - 1 / 3) < 1e-9);
  assert.ok(Math.abs(wer('a b', 'a b c d') - 1) < 1e-9);
  assert.equal(wer('', ''), 0);
  assert.equal(wer('', 'something'), 1);
});

test('cer works on characters, so it is usable for languages without clear word breaks', () => {
  assert.ok(Math.abs(cer('abc', 'abd') - 1 / 3) < 1e-9);
  assert.equal(cer('same', 'same'), 0);
});
