'use strict';
/** OpenAI-compatible HTTP calls to an AI node. Error messages carry the node NAME only, never URLs, tokens or user text. */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

class NodeError extends Error {
  constructor(message, nodeFailure) {
    super(message);
    this.name = 'NodeError';
    this.nodeFailure = nodeFailure; // true: try another node / retry later. false: our request is wrong.
  }
}

const EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  'audio/flac': 'flac', 'audio/aac': 'aac', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const extFor = (mime) => EXT[String(mime).split(';')[0].toLowerCase()] || 'bin';
const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * One HTTP call to a node over node:http(s). Not fetch: undici imposes a hard 300 s headers/body timeout that
 * cannot be extended, which would cut off long transcriptions. `timeoutMs` is the overall deadline for the call.
 * Resolves { status, text } for 2xx; throws NodeError otherwise. Error text never includes the response body
 * (servers echo the offending input back, and that input is user text), the URL or the token.
 * `body` may be a string, a Buffer or a Readable. An error emitted by a Readable body is the CALLER's error
 * (e.g. a vault decrypt failure): it is rethrown untouched, with no `nodeFailure`, and the node is not blamed.
 */
function request(node, path, { method = 'POST', headers = {}, body } = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(node.url + path);
    const h = { ...headers };
    if (node.token) h.authorization = `Bearer ${node.token}`;
    const isStream = body != null && typeof body.pipe === 'function';
    if (body != null && !isStream) h['content-length'] = Buffer.byteLength(body);
    let req;
    let timer;
    let done = false;
    const settle = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err && req) req.destroy();
      if (!err && req && !req.writableFinished) req.destroy(); // node answered before we finished sending
      if (isStream) body.destroy();
      if (err) reject(err); else resolve(value);
    };
    if (isStream) body.on('error', (e) => settle(e)); // stays attached so a late stream error is never unhandled
    timer = setTimeout(() => settle(new NodeError(`${node.name} timed out after ${Math.round(timeoutMs / 1000)}s`, true)), timeoutMs);
    const lib = url.protocol === 'https:' ? https : http;
    req = lib.request(url, { method, headers: h }, (res) => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const chunks = [];
      res.on('data', (c) => { if (ok) chunks.push(c); }); // error bodies are read and discarded, never kept
      res.on('error', (e) => settle(new NodeError(`${node.name} unreachable (${e.code || e.name})`, true)));
      res.on('end', () => {
        if (ok) return settle(null, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        const failure = res.statusCode >= 500 || [404, 408, 429].includes(res.statusCode);
        settle(new NodeError(`${node.name} answered HTTP ${res.statusCode}`, failure));
      });
      res.on('close', () => { if (!res.complete) settle(new NodeError(`${node.name} unreachable (ECONNRESET)`, true)); });
    });
    req.on('error', (e) => settle(new NodeError(`${node.name} unreachable (${e.code || e.name})`, true)));
    if (isStream) body.pipe(req); // respects back-pressure
    else req.end(body);
  });
}

function parseJson(node, res) {
  try {
    return JSON.parse(res.text);
  } catch {
    throw new NodeError(`${node.name} returned a response that is not JSON`, true);
  }
}

async function health(node) {
  await request(node, '/v1/models', { method: 'GET' }, 5000);
}

async function embed(node, texts) {
  const res = await request(node, '/v1/embeddings', { headers: JSON_HEADERS, body: JSON.stringify({ model: node.models.embed, input: texts }) }, 120_000);
  const j = await parseJson(node, res);
  const rows = Array.isArray(j.data) ? [...j.data].sort((a, b) => a.index - b.index) : [];
  if (rows.length !== texts.length || rows.some((r) => !Array.isArray(r.embedding) || !r.embedding.length)) {
    throw new NodeError(`${node.name} returned a malformed embeddings response`, true);
  }
  return rows.map((r) => r.embedding);
}

async function chat(node, messages, { temperature = 0.2, maxTokens = 800 } = {}) {
  const res = await request(node, '/v1/chat/completions', {
    headers: JSON_HEADERS,
    body: JSON.stringify({ model: node.models.chat, messages, temperature, max_tokens: maxTokens, stream: false }),
  }, 300_000);
  const j = await parseJson(node, res);
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof content !== 'string') throw new NodeError(`${node.name} returned a malformed chat response`, true);
  return content.replace(/<think>[\s\S]*?<\/think>/g, ''); // reasoning models emit these; they are not part of the answer
}

/**
 * Streams `readable` (decrypted audio/video) to the node as multipart/form-data without buffering it
 * and without ever writing it to disk. The original file name is not sent.
 */
async function transcribe(node, readable, { mime }) {
  const boundary = `----memento${crypto.randomBytes(12).toString('hex')}`;
  const fields = { model: node.models.transcribe, response_format: 'verbose_json' };
  async function* body() {
    for (const [k, v] of Object.entries(fields)) {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    }
    yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${extFor(mime)}"\r\nContent-Type: ${String(mime).split(';')[0]}\r\n\r\n`);
    for await (const chunk of readable) yield chunk;
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }
  try {
    const res = await request(node, '/v1/audio/transcriptions', {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Readable.from(body()),
    }, 45 * 60_000);
    const j = await parseJson(node, res);
    return {
      text: String(j.text || '').trim(),
      language: typeof j.language === 'string' ? j.language : '',
      segments: (Array.isArray(j.segments) ? j.segments : []).map((s) => ({ start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim() })),
    };
  } finally {
    readable.destroy(); // releases the vault file handle if the request failed before reading everything
  }
}

module.exports = { NodeError, health, embed, chat, transcribe, request };
