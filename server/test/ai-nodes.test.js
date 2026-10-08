'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { startFakeNode, nodeCfg, fakeEmbed } = require('./helpers/fake-node');
const client = require('../src/ai/client');
const { NodeRegistry } = require('../src/ai/nodes');
const { NoEligibleNode, NodeUnavailable } = require('../src/ai/errors');

const asNode = (fake, over = {}) => ({ token: '', local: false, ...nodeCfg(fake, over) });

test('embed: sends model + input, returns vectors in order', async () => {
  const fake = await startFakeNode();
  const out = await client.embed(asNode(fake), ['apple pie', 'orchard']);
  assert.deepEqual(out, [fakeEmbed('apple pie'), fakeEmbed('orchard')]);
  const sent = JSON.parse(fake.calls[0].body.toString());
  assert.equal(sent.model, 'e');
  assert.deepEqual(sent.input, ['apple pie', 'orchard']);
  await fake.close();
});

test('chat: returns content, strips <think> blocks, sends bearer token', async () => {
  const fake = await startFakeNode({ chat: () => '<think>hmm</think>The answer. [S1]' });
  const text = await client.chat(asNode(fake, { token: 'secret-token' }), [{ role: 'user', content: 'hi' }]);
  assert.equal(text.trim(), 'The answer. [S1]');
  assert.equal(fake.calls[0].headers.authorization, 'Bearer secret-token');
  await fake.close();
});

test('transcribe: streams the file as multipart and parses verbose_json', async () => {
  const audio = Buffer.from('RIFF-fake-audio-bytes-0123456789');
  const fake = await startFakeNode({
    transcribe: () => ({ text: ' Namaste ', language: 'pa', segments: [{ start: 0, end: 2.5, text: ' Namaste ' }] }),
  });
  const out = await client.transcribe(asNode(fake), Readable.from([audio.subarray(0, 10), audio.subarray(10)]), { mime: 'audio/webm' });
  assert.deepEqual(out, { text: 'Namaste', language: 'pa', segments: [{ start: 0, end: 2.5, text: 'Namaste' }] });
  const call = fake.calls[0];
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(call.body.includes(audio), 'audio bytes reach the node');
  const text = call.body.toString('latin1');
  assert.match(text, /name="model"\r\n\r\nw\r\n/);
  assert.match(text, /name="response_format"\r\n\r\nverbose_json/);
  assert.match(text, /filename="audio\.webm"/, 'original file name is never sent');
  await fake.close();
});

test('errors: 5xx/429/404 and unreachable are node failures, other 4xx are not', async () => {
  const fake = await startFakeNode();
  for (const [status, failure] of [[500, true], [503, true], [429, true], [404, true], [400, false], [401, false]]) {
    fake.state.failStatus = status;
    await assert.rejects(client.embed(asNode(fake), ['x']), (e) => e.nodeFailure === failure && /desk/.test(e.message), String(status));
  }
  await fake.close();
  await assert.rejects(client.embed(asNode(fake), ['x']), (e) => e.nodeFailure === true && /unreachable/.test(e.message));
});

const reg = (nodes, extra) => new NodeRegistry(nodes.map((n) => ({ token: '', local: false, ...n })), extra);

test('registry: private work is only ever offered to local nodes', async () => {
  const fake = await startFakeNode();
  const r = reg([nodeCfg(fake, { name: 'remote', local: false })]);
  assert.equal(r.hasEligible('embed', 'family'), true);
  assert.equal(r.hasEligible('embed', 'private'), false);
  await assert.rejects(r.withNode('embed', 'private', (n) => client.embed(n, ['secret'])), NoEligibleNode);
  assert.equal(fake.calls.length, 0, 'nothing reached the remote node');
  const r2 = reg([nodeCfg(fake, { name: 'remote' }), nodeCfg(fake, { name: 'nas', local: true, priority: 50 })]);
  const out = await r2.withNode('embed', 'private', (n) => n.name);
  assert.equal(out, 'nas');
  await fake.close();
});

test('registry: capability filter, priority order, failover and cool-down', async () => {
  const bad = await startFakeNode({ failStatus: 500 });
  const good = await startFakeNode();
  let t = 1000;
  const r = reg([nodeCfg(bad, { name: 'a', priority: 10 }), nodeCfg(good, { name: 'b', priority: 20 }),
    nodeCfg(good, { name: 'c', priority: 1, capabilities: ['chat'], models: { chat: 'c' } })], { now: () => t, retryAfterMs: 30_000 });
  const embedOn = (n) => client.embed(n, ['x']).then(() => n.name);
  assert.equal(await r.withNode('embed', 'family', embedOn), 'b'); // a fails, b answers; c lacks "embed"
  assert.equal(r.status().find((s) => s.name === 'a').healthy, false);
  const before = bad.calls.length;
  assert.equal(await r.withNode('embed', 'family', embedOn), 'b'); // a is cooling down: skipped
  assert.equal(bad.calls.length, before);
  bad.state.failStatus = 0;
  t += 31_000; // cool-down over: a is tried first again
  assert.equal(await r.withNode('embed', 'family', embedOn), 'a');
  assert.equal(r.status().find((s) => s.name === 'a').healthy, true);
  await bad.close(); await good.close();
});

test('registry: all eligible nodes failing throws NodeUnavailable; non-node errors pass through', async () => {
  const bad = await startFakeNode({ failStatus: 500 });
  const r = reg([nodeCfg(bad)]);
  await assert.rejects(r.withNode('embed', 'family', (n) => client.embed(n, ['x'])), NodeUnavailable);
  await assert.rejects(r.withNode('embed', 'family', async () => { throw new TypeError('bug'); }), TypeError);
  await assert.rejects(reg([]).withNode('embed', 'family', async () => 1), NoEligibleNode);
  await bad.close();
});

test('registry.status hides URLs unless asked and never exposes tokens; checkAll updates health', async () => {
  const fake = await startFakeNode();
  const r = reg([nodeCfg(fake, { token: 'tok' })]);
  const s = r.status()[0];
  assert.equal(s.url, undefined);
  assert.equal(JSON.stringify(r.status({ includeUrls: true })).includes('tok'), false);
  fake.state.failStatus = 500;
  await r.checkAll();
  assert.equal(r.status()[0].healthy, false);
  fake.state.failStatus = 0;
  await r.checkAll();
  assert.equal(r.status()[0].healthy, true);
  await fake.close();
});
