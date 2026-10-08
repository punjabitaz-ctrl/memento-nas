'use strict';

// Punctuation (\p{P}) and symbols (\p{S}) become spaces. Combining marks (\p{M}: vowel signs, viramas) are
// deliberately kept: in Indic scripts they are part of the word, and dropping one is a real transcription error.
function normalizeForScoring(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function rate(refTokens, hypTokens) {
  if (!refTokens.length) return hypTokens.length ? 1 : 0;
  return editDistance(refTokens, hypTokens) / refTokens.length;
}

const words = (s) => normalizeForScoring(s).split(' ').filter(Boolean);
const wer = (ref, hyp) => rate(words(ref), words(hyp));
const cer = (ref, hyp) => rate([...normalizeForScoring(ref)], [...normalizeForScoring(hyp)]);

module.exports = { wer, cer, normalizeForScoring, editDistance };
