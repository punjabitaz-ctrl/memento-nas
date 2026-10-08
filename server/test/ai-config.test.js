'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { isPrivateHost, assertPrivateUrl } = require('../src/ai/netguard');
const { parseAi } = require('../src/ai/config');
const { load, ConfigError } = require('../src/config');

test('isPrivateHost accepts private ranges and rejects public ones', () => {
  const ok = ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.1', '192.168.1.2', '100.64.0.1', '100.127.255.254',
    '[::1]', '[fd7a:115c:a1e0::1]', 'localhost', 'desktop.tail1234.ts.net', 'nas.local', 'ollama', '[::ffff:7f00:1]'];
  const bad = ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1', '192.169.1.1', '[2001:4860:4860::8888]',
    'example.com', 'api.openai.com', '[::ffff:808:808]'];
  for (const h of ok) assert.equal(isPrivateHost(h), true, h);
  for (const h of bad) assert.equal(isPrivateHost(h), false, h);
  assert.equal(isPrivateHost(''), false);
});

test('assertPrivateUrl normalises and rejects bad schemes / public hosts', () => {
  assert.equal(assertPrivateUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.equal(assertPrivateUrl('http://[fd7a:115c:a1e0::1]:11434'), 'http://[fd7a:115c:a1e0::1]:11434');
  assert.throws(() => assertPrivateUrl('https://api.openai.com'), /private network/);
  assert.throws(() => assertPrivateUrl('ftp://127.0.0.1'), /http/);
  assert.throws(() => assertPrivateUrl('not a url'), /valid URL/);
});

test('assertPrivateUrl does not echo the raw input in its error', () => {
  assert.throws(
    () => assertPrivateUrl('sekrit not a url'),
    (e) => /valid URL/.test(e.message) && !e.message.includes('sekrit')
  );
});

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function env(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-cfg-'));
  tmpDirs.push(dir);
  return {
    MEMENTO_KEY: crypto.randomBytes(32).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    DATA_DIR: dir,
    ...extra,
  };
}
const node = (over = {}) => ({
  name: 'desk', url: 'http://100.101.102.103:8000', capabilities: ['transcribe', 'embed', 'chat'],
  models: { transcribe: 'w', embed: 'e', chat: 'c' }, ...over,
});

test('AI is off by default', () => {
  const c = load(env());
  assert.equal(c.ai.enabled, false);
  assert.deepEqual(c.ai.nodes, []);
});

test('valid AI_NODES are parsed with defaults', () => {
  const c = load(env({ AI_ENABLED: 'true', AI_NODES: JSON.stringify([node(), node({ name: 'nas', url: 'http://127.0.0.1:11434', capabilities: ['embed'], models: { embed: 'e' }, local: true, priority: 50 })]) }));
  assert.equal(c.ai.enabled, true);
  assert.equal(c.ai.nodes.length, 2);
  assert.equal(c.ai.nodes[0].priority, 100);
  assert.equal(c.ai.nodes[0].local, false);
  assert.equal(c.ai.nodes[1].local, true);
  assert.equal(c.ai.embedModel, 'e');
  assert.equal(c.ai.chunkTokens, 200);
  assert.equal(c.ai.pollMs, 5000);
});

function problems(extra) {
  try { load(env(extra)); } catch (e) { assert.ok(e instanceof ConfigError); return e.problems.join(' | '); }
  assert.fail('expected ConfigError');
}

test('config refuses bad AI settings with clear messages', () => {
  assert.match(problems({ AI_ENABLED: 'true' }), /at least one node/);
  assert.match(problems({ AI_NODES: '{nope' }), /valid JSON/);
  assert.match(problems({ AI_NODES: '{}' }), /array/);
  assert.match(problems({ AI_NODES: JSON.stringify([node({ url: 'https://api.openai.com' })]) }), /private network/);
  assert.match(problems({ AI_NODES: JSON.stringify([node({ capabilities: ['dream'] })]) }), /capabilities/);
  assert.match(problems({ AI_NODES: JSON.stringify([node({ models: { embed: 'e' } })]) }), /models\.transcribe/);
  assert.match(problems({ AI_NODES: JSON.stringify([node(), node()]) }), /used twice/);
  assert.match(problems({ AI_NODES: JSON.stringify([node(), node({ name: 'b', models: { transcribe: 'w', embed: 'OTHER', chat: 'c' } })]) }), /same embedding model/);
  assert.match(problems({ AI_MAX_CHUNK_TOKENS: '5' }), /AI_MAX_CHUNK_TOKENS/);
});

test('AI_NODES that parses to zero nodes is refused', () => {
  assert.match(problems({ AI_ENABLED: 'true', AI_NODES: '[]' }), /at least one node/);
  assert.match(problems({ AI_ENABLED: 'true', AI_NODES: '{nope' }), /valid JSON/);
});

test('embed model strings are trimmed before the same-model check', () => {
  const p = [];
  const cfg = parseAi({
    AI_ENABLED: 'true',
    AI_NODES: JSON.stringify([node(), node({ name: 'b', models: { transcribe: 'w', embed: 'e ', chat: 'c' } })]),
  }, p);
  assert.doesNotMatch(p.join(' | '), /same embedding model/);
  assert.equal(cfg.nodes[1].models.embed, 'e');
  assert.equal(cfg.embedModel, 'e');
});

// ---- Fix wave A: hardening of node settings ---------------------------------------------------

const nodesProblems = (n) => {
  const p = [];
  parseAi({ AI_ENABLED: 'true', AI_NODES: JSON.stringify([n]) }, p);
  return p.join(' | ');
};

test('a node token with control characters (header injection) is refused, and the token is never echoed', () => {
  for (const tok of ['abc\r\nX-Evil: 1', 'abc\ndef', 'abc\rdef', 'tab\there', 'nul\u0000x', 'del\u007fx', 'esc\u001bx']) {
    const msg = nodesProblems(node({ token: tok }));
    assert.match(msg, /AI_NODES\[0\]\.token .*control character/, JSON.stringify(tok));
    assert.ok(!msg.includes(tok) && !msg.includes('abc') && !msg.includes('X-Evil'), 'token not echoed');
  }
  assert.equal(nodesProblems(node({ token: 'sk-ok_token.with-normal~chars' })), '');
  assert.match(problems({ AI_ENABLED: 'true', AI_NODES: JSON.stringify([node({ token: 'a\nb' })]) }), /control character/);
});

test('a node URL with a user name or password is refused without echoing the URL', () => {
  for (const url of ['http://user:hunter2@127.0.0.1:8000', 'http://user@127.0.0.1:8000', 'http://:hunter2@nas.local']) {
    const msg = nodesProblems(node({ url }));
    assert.match(msg, /AI_NODES\[0\]\.url: .*user name or password/, url);
    assert.ok(!msg.includes('hunter2') && !msg.includes('user@') && !msg.includes(url), 'URL not echoed');
  }
  assert.throws(() => assertPrivateUrl('http://u:p@127.0.0.1'), /user name or password/);
});

test('priority must be a real finite number: null, empty string, booleans and strings are refused', () => {
  for (const priority of [null, '', true, false, '5', 'abc', [], {}, [3]]) {
    assert.match(nodesProblems(node({ priority })), /AI_NODES\[0\]\.priority must be a number/, JSON.stringify(priority));
  }
  assert.equal(nodesProblems(node({ priority: 0 })), '');
  assert.equal(nodesProblems(node({ priority: -5.5 })), '');
  assert.equal(nodesProblems(node({})), '', 'priority stays optional');
});
