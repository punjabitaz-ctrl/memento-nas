'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUN = path.join(__dirname, '..', 'ai-eval', 'run.js');
const runEval = (...args) => spawnSync(process.execPath, [RUN, ...args], { encoding: 'utf8', timeout: 30_000 });

test('ai-eval refuses a --node that is not on a private network (exit 2, clear message, nothing sent)', () => {
  for (const url of ['https://api.openai.com', 'http://8.8.8.8:8000', 'not a url', 'ftp://127.0.0.1']) {
    const r = runEval('--node', url, '--model', 'm', '--dir', path.join(__dirname, 'no-such-folder'));
    assert.equal(r.status, 2, `${url}: ${r.stderr}`);
    assert.match(r.stderr, /^--node /m, url);
    assert.doesNotMatch(r.stderr, /Folder not found/, 'refused before anything else happens');
  }
  const creds = runEval('--node', 'http://user:hunter2@127.0.0.1:8000', '--model', 'm', '--dir', '.');
  assert.equal(creds.status, 2);
  assert.match(creds.stderr, /user name or password/);
  assert.ok(!creds.stderr.includes('hunter2'));
});

test('ai-eval accepts a private --node and moves on to the folder check', () => {
  const r = runEval('--node', 'http://127.0.0.1:9', '--model', 'm', '--dir', path.join(__dirname, 'no-such-folder'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Folder not found/);
});
