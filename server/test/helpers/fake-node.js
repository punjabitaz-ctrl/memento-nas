'use strict';
const http = require('node:http');

/** Deterministic bag-of-words embedding so retrieval tests behave semantically without a model. */
function fakeEmbed(text, dim = 64) {
  const v = new Array(dim).fill(0);
  for (const w of String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  return v;
}

/**
 * Minimal OpenAI-compatible node. state.failStatus forces an error status;
 * state.transcribe(bodyBuffer), state.embed(text), state.chat(messages) override the defaults.
 */
function startFakeNode(initial = {}) {
  const calls = [];
  const state = { failStatus: 0, ...initial };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, path: req.url, headers: req.headers, body });
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (state.failStatus) return send(state.failStatus, { error: 'forced failure' });
      if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: [] });
      if (req.url === '/v1/audio/transcriptions') {
        return send(200, state.transcribe
          ? state.transcribe(body)
          : { text: 'hello world', language: 'en', segments: [{ start: 0, end: 1, text: 'hello world' }] });
      }
      if (req.url === '/v1/embeddings') {
        const { input } = JSON.parse(body.toString());
        return send(200, { data: input.map((t, i) => ({ index: i, embedding: (state.embed || fakeEmbed)(t) })) });
      }
      if (req.url === '/v1/chat/completions') {
        const { messages } = JSON.parse(body.toString());
        return send(200, { choices: [{ message: { role: 'assistant', content: state.chat ? state.chat(messages) : 'Echo.' } }] });
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        state,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
      });
    })
  );
}

const nodeCfg = (fake, over = {}) => ({
  name: 'desk', url: fake.url, capabilities: ['transcribe', 'embed', 'chat'],
  models: { transcribe: 'w', embed: 'e', chat: 'c' }, priority: 10, ...over,
});

module.exports = { startFakeNode, fakeEmbed, nodeCfg };
