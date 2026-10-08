// Browser end-to-end test for machine transcripts + "Ask the archive", using a FAKE AI node.
//
// Run from the repo root (needs client/dist built: `cd client && npm ci && npm run build`):
//   npm i --no-save playwright-core
//   node e2e/ai.mjs
// On a machine without Playwright's own browser, point CHROMIUM_PATH at Chrome or Edge, e.g.
//   CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" node e2e/ai.mjs
//
// It starts a fake OpenAI-compatible node (server/test/helpers/fake-node.js) and a REAL
// `node server/index.js` on a FRESH temp data dir and random key, drives the UI, and always
// cleans both up (also on Ctrl-C / SIGTERM / crashes). It never touches a real vault. The port is picked at random.
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startFakeNode } = require(path.join(root, 'server', 'test', 'helpers', 'fake-node.js'));

const WATCHDOG_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;
const CLEANUP_STEP_MS = 5_000;

const TRANSCRIPT = 'Grandma Rose taught me her apple pie recipe in the kitchen in Pittsburgh.';
const PRIVATE_SENTENCE = 'The purple giraffe hid the zanzibar treasure under the floorboards.';
const PRIVATE_TITLE = 'Hidden treasure';

if (!fs.existsSync(path.join(root, 'client', 'dist', 'index.html'))) {
  console.error('client/dist is missing. Build it first: cd client && npm ci && npm run build');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Resolves with the promise's value, or undefined after ms, and never rejects: a hung step cannot hang cleanup.
const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);

// Pick a free port: listen on 0, read it, close. (A tiny race remains; the post-health exit check covers it.)
const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const BASE = `http://127.0.0.1:${PORT}`;

const fake = await startFakeNode({
  transcribe: () => ({ text: TRANSCRIPT, language: 'en', segments: [] }),
  chat: () => 'Grandma Rose taught the apple pie recipe in her Pittsburgh kitchen [S1].',
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-e2e-ai-'));
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memento-e2e-ai-up-')); // test audio lives OUTSIDE the server's DATA_DIR
const serverLog = [];
// Minimal child environment: nothing from the developer's shell leaks into the server.
const childEnv = {};
for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[k] !== undefined) childEnv[k] = process.env[k];
Object.assign(childEnv, {
  PORT: String(PORT),
  DATA_DIR: dataDir,
  CLIENT_DIST: path.join(root, 'client', 'dist'),
  MEMENTO_KEY: crypto.randomBytes(32).toString('hex'),
  SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  AI_ENABLED: 'true',
  AI_POLL_MS: '300',
  AI_NODES: JSON.stringify([{ name: 'fake', url: fake.url, capabilities: ['transcribe', 'embed', 'chat'], models: { transcribe: 'w', embed: 'e', chat: 'c' } }]),
});
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
  cwd: path.join(root, 'server'),
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
let serverExited = false;
const serverExit = new Promise((resolve) => {
  server.once('exit', () => { serverExited = true; resolve(); });
  server.once('error', (e) => { serverLog.push(`spawn error: ${e.message}\n`); serverExited = true; resolve(); });
});

let browser = null;
let releaseGate = null;
let cleanupPromise = null;
// Idempotent: every caller (finally, watchdog, signals, crashes) shares one run.
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (releaseGate) releaseGate(); // never leave a held node response behind
    await bounded(browser && browser.close(), CLEANUP_STEP_MS);
    try { if (!serverExited) server.kill(); } catch { /* already gone */ }
    await bounded(serverExit, CLEANUP_STEP_MS); // the child has released its file locks once it has exited
    await bounded(fake.close(), CLEANUP_STEP_MS);
    for (const dir of [dataDir, uploadDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
    }
  })();
  return cleanupPromise;
}
process.on('exit', () => { try { if (!serverExited) server.kill(); } catch { /* ignore */ } });

let current = 'starting';
const step = (s) => { current = s; console.log('→', s); };

const bail = async (why, err) => {
  console.error(`✖ ${why} (at step: "${current}")${err ? '\n' + (err.stack || err) : ''}`);
  console.error('--- server log (tail) ---\n' + serverLog.join('').slice(-2000));
  await cleanup();
  process.exit(1);
};
const watchdog = setTimeout(() => bail(`watchdog: still running after ${WATCHDOG_MS / 1000}s`), WATCHDOG_MS);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bail(`received ${sig}`); });
process.on('uncaughtException', (e) => { bail('uncaught exception', e); });
process.on('unhandledRejection', (e) => { bail('unhandled rejection', e); });

let failed = false;
try {
  step('wait for the server to come up');
  let up = false;
  for (let i = 0; i < 75 && !serverExited; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) { up = true; break; } } catch { /* not up yet */ }
    await sleep(200);
  }
  assert.ok(!serverExited, 'the spawned server exited during startup (is the port taken?)');
  assert.ok(up, 'the server never became healthy');
  // Make sure OUR child is the one answering: a stray listener on the port would pass /health, but our child would have died.
  await sleep(300);
  assert.ok(!serverExited, 'the spawned server exited right after /health answered; something else owns the port');

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(STEP_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);
  const external = [];
  const problems = [];
  // Context-level listeners also cover popups and any other page the app opens.
  const isExternal = (url) => {
    const u = new URL(url);
    return /^(https?|wss?):$/.test(u.protocol) && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  };
  context.on('request', (r) => { if (isExternal(r.url())) external.push(r.url()); });
  context.on('requestfailed', (r) => { if (isExternal(r.url())) external.push(`${r.url()} (failed)`); });
  context.on('page', (p) => p.on('pageerror', (e) => problems.push(e.message)));
  const page = await context.newPage();

  // The AI queue is idle when nothing is pending or running (owner-only endpoint).
  const waitQueueIdle = async () => {
    await page.waitForFunction(async () => {
      const s = await (await fetch('/api/ai/status')).json();
      return s.queue && s.queue.pending === 0 && s.queue.running === 0;
    }, null, { timeout: STEP_TIMEOUT_MS, polling: 300 });
  };

  // 1. First-run setup; the Ask nav link only exists when the server reports localAi.
  step('first-run setup, then the "Ask the archive" link appears (localAi is on)');
  await page.goto(BASE + '/');
  await page.waitForURL('**/setup');
  await page.getByLabel('Your name').fill('Owner');
  await page.getByLabel('Email or username to sign in with').fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
  await page.getByLabel(/I have saved my/).check();
  await page.getByRole('button', { name: 'Create my vault' }).click();
  await page.waitForURL('**/dashboard');
  await page.getByRole('link', { name: 'Ask the archive' }).first().waitFor();

  // 2. Upload audio through the normal Add flow (same upload path the recorder uses).
  step('upload an audio file: "Transcript on its way", then the machine transcript appears with no reload');
  const file = path.join(uploadDir, 'story.ogg');
  fs.writeFileSync(file, Buffer.alloc(4000, 3));
  // Hold the node's transcription response until we have looked at the pending state (deterministic, no timing).
  let release;
  fake.state.gate = new Promise((r) => { release = r; });
  releaseGate = release;
  await page.goto(BASE + '/add');
  await page.setInputFiles('input[type=file]', file);
  await page.getByLabel('Title').fill('Apple pie');
  await page.getByRole('button', { name: 'Save to the vault' }).click();
  await page.waitForURL(/\/memory\//);
  const memoryUrl = page.url();
  // Mark the document so we can prove the transcript arrived without a page reload.
  await page.evaluate(() => { window.__noReload = true; });
  // The node is holding the response, so the pending banner is stable until we release it.
  await page.getByText('Transcript on its way').waitFor();
  assert.equal(await page.getByText(TRANSCRIPT).count(), 0, 'the transcript must not show while the node is still working');
  release();
  fake.state.gate = undefined;
  await page.getByText(TRANSCRIPT).waitFor({ timeout: 20_000 });
  await page.getByText('Written by the computer').waitFor();
  assert.equal(await page.evaluate(() => window.__noReload === true), true, 'the page was reloaded instead of updating itself');
  assert.equal(await page.getByText('Transcript on its way').count(), 0, 'the pending banner must be gone once the transcript is shown');

  // 3. The transcript is searchable (a word that exists ONLY in the machine transcript).
  step('the transcript is searchable');
  await waitQueueIdle();
  await page.goto(BASE + '/search');
  await page.getByLabel('Search memories').fill('Pittsburgh');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.locator('.memory-card').filter({ hasText: 'Apple pie' }).first().waitFor();
  // Negative control: a word that is in no memory returns no result card.
  await page.getByLabel('Search memories').fill('Kathmandu');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByText('Nothing found for').waitFor();
  assert.equal(await page.locator('.memory-card').count(), 0, 'a word absent from every memory must return no result cards');

  // 4. Ask: cited answer, "Where this came from", link back to the memory.
  step('ask the archive: cited answer with a working source link');
  await page.getByRole('link', { name: 'Ask the archive' }).first().click();
  await page.waitForURL('**/ask');
  await page.getByLabel('What would you like to know?').fill('Who taught the apple pie recipe?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('Grandma Rose taught the apple pie recipe in her Pittsburgh kitchen').waitFor();
  const sources = page.getByRole('heading', { name: 'Where this came from' }).locator('xpath=..');
  await sources.waitFor();
  const cite = sources.getByRole('link', { name: 'Apple pie' });
  await cite.waitFor();
  await cite.click();
  await page.waitForURL(memoryUrl);
  await page.getByRole('heading', { name: 'Apple pie' }).first().waitFor();

  // 5. A question with no record offers to ask an elder.
  step('NO_RECORD answer offers "Ask an elder to record this", which works');
  fake.state.chat = () => 'NO_RECORD';
  await page.goto(BASE + '/ask');
  await page.getByLabel('What would you like to know?').fill('Where was great grandfather born?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.getByText('The archive has no record of that yet').waitFor();
  await page.getByRole('button', { name: 'Ask an elder to record this' }).click();
  await page.getByRole('button', { name: 'Sent to the family' }).waitFor();
  // Server-side check: the prompt really exists (the button text alone could be a client-only state).
  const prompts = await page.evaluate(async () => (await fetch('/api/prompts', { headers: { 'X-Requested-With': 'memento' } })).json());
  assert.ok(prompts.prompts.some((p) => p.text.includes('Where was great grandfather born?')), 'the forwarded question was not saved as a prompt');

  // 7. Privacy: a PRIVATE story must never reach the (non-local) node. Record what the node receives.
  step('privacy: a private story never appears in any request the AI node received');
  await page.goto(BASE + '/add?write=1');
  await page.getByLabel('Title').fill(PRIVATE_TITLE);
  await page.getByLabel('Your story').fill(PRIVATE_SENTENCE);
  await page.getByLabel('Who can see this?').selectOption('private');
  await page.getByRole('button', { name: 'Save to the vault' }).click();
  await page.waitForURL(/\/memory\//);
  await page.getByText(PRIVATE_SENTENCE).first().waitFor();
  await waitQueueIdle(); // every job the save queued has now been processed (or skipped)
  const chatMessages = [];
  fake.state.chat = (messages) => { chatMessages.push(messages); return 'NO_RECORD'; };
  await page.goto(BASE + '/ask');
  await page.getByLabel('What would you like to know?').fill('Where was the treasure hidden?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  // Whatever the outcome, the answer panel must settle (answer, no-record, or an error toast).
  await page.getByText('The archive has no record of that yet').waitFor();
  // Non-vacuous: the private story DID match for its author, and was deliberately held back from the node.
  await page.getByText('Some of your private stories matched but were not used').waitFor();
  await sleep(500);
  const bodies = fake.calls.map((c) => c.body.toString('latin1'));
  const leaked = bodies.filter((b) => b.includes(PRIVATE_SENTENCE) || /floorboards|giraffe|zanzibar/i.test(b) || b.toLowerCase().includes(PRIVATE_TITLE.toLowerCase()));
  assert.equal(leaked.length, 0, `private text reached the AI node in ${leaked.length} request(s)`);
  for (const m of chatMessages) assert.ok(!JSON.stringify(m).match(/floorboards|giraffe|zanzibar|hidden treasure/i), 'private text or title reached the chat prompt');
  // Non-vacuous: the node did see embeddings for the family memory, and the asker's question.
  assert.ok(fake.calls.some((c) => c.path === '/v1/embeddings'), 'expected the node to have received embedding requests');
  assert.ok(fake.calls.some((c) => c.path === '/v1/audio/transcriptions'), 'expected the node to have received the audio');
  console.log(`   the fake node received ${fake.calls.length} requests (${[...new Set(fake.calls.map((c) => c.path))].join(', ')}); none contained the private story`);

  // 6. No external requests, no uncaught page errors.
  step('zero external requests and zero uncaught page errors');
  assert.deepEqual(external, [], 'the browser made external requests');
  assert.deepEqual(problems, [], 'uncaught page errors');

  console.log('✔ AI e2e passed');
} catch (e) {
  failed = true;
  console.error(`\n✖ AI e2e FAILED at step: "${current}"\n${e && e.stack ? e.stack : e}`);
  console.error('--- server log (tail) ---\n' + serverLog.join('').slice(-2000));
} finally {
  clearTimeout(watchdog);
  await cleanup();
}
process.exit(failed ? 1 : 0);
