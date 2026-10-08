// Run: npm i --no-save playwright-core && E2E_BASE=http://localhost:3002 node e2e/run.mjs  (needs a FRESH, uninitialised data dir)
import { chromium } from 'playwright-core';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const OUT = process.env.E2E_OUT || path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(OUT, { recursive: true });
const BASE = process.env.E2E_BASE || 'http://localhost:3002';
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

function png(w, h, rgb) {
  const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } let x = 0xffffffff; for (const b of buf) x = crcTable[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.writeFileSync(path.join(OUT, 'wedding.png'), png(300, 200, [201, 162, 39]));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined, // set on machines without Playwright's browser
  
  args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
const page = await ctx.newPage();

const problems = [];
const external = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('request', (r) => { const u = new URL(r.url()); if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http')) external.push(r.url()); });
page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('/api/auth/status')) problems.push(`HTTP ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });

const step = (s) => console.log('→', s);

// 1. First run -> setup
step('first-run setup');
await page.goto(BASE + '/');
await page.waitForURL('**/setup');
await shot(page, '01-setup');
await page.getByLabel('Your name').fill('Taz');
await page.getByLabel('Email or username to sign in with').fill('taz');
await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple');
const create = page.getByRole('button', { name: 'Create my vault' });
assert.equal(await create.isDisabled(), true, 'create button must stay disabled until key-backup is acknowledged');
await page.getByLabel(/I have saved my/).check();
await create.click();
await page.waitForURL('**/dashboard');
await page.getByText('Your vault is empty').waitFor();
await shot(page, '02-dashboard-empty');

// 2. Written story
step('write a story');
await page.goto(BASE + '/add?write=1');
await page.getByLabel('Title').fill("Grandma Rose's apple pie");
await page.getByLabel('Your story').fill('Grandma Rose taught me her apple pie recipe in the kitchen in Pittsburgh. It was June 1962 and Grandpa William was courting her. The pie was always lovely and the kitchen smelled of cinnamon.');
await page.getByRole('button', { name: 'Save to the vault' }).click();
await page.waitForURL(/\/memory\//);
await page.getByText('June 1962').first().waitFor();
await shot(page, '03-story-detail');
const storyUrl = page.url();

// 3. Photo upload
step('upload a photo');
await page.goto(BASE + '/add');
await page.setInputFiles('input[type=file]', path.join(OUT, 'wedding.png'));
await page.getByText('wedding.png').waitFor();
await page.getByLabel('Title').fill('Wedding photo');
await page.getByPlaceholder('Year, e.g. 1962').fill('1962');
await page.getByLabel('Month').selectOption('06');
await page.getByRole('button', { name: 'Save to the vault' }).click();
await page.waitForURL(/\/memory\//);
const img = page.locator('.detail-media img');
await img.waitFor();
await page.waitForFunction(() => { const i = document.querySelector('.detail-media img'); return i && i.complete && i.naturalWidth === 300; });
await shot(page, '04-photo-detail');

// 4. Record with fake microphone
step('record a voice story');
await page.goto(BASE + '/record');
await page.getByRole('button', { name: 'Start recording' }).click();
await page.waitForTimeout(3500);
await shot(page, '05-recording');
await page.getByRole('button', { name: /Finish/ }).click();
await page.locator('audio.review-audio').waitFor();
await shot(page, '06-record-review');
await page.getByLabel('Title').fill('Voice test');
await page.getByRole('button', { name: 'Save to the vault' }).click();
await page.waitForURL(/\/memory\//);
await page.locator('.detail-media audio').waitFor();
const audioOk = await page.evaluate(async () => {
  const a = document.querySelector('.detail-media audio');
  await new Promise((r) => { if (a.readyState >= 1) r(); else a.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 4000); });
  return { ready: a.readyState, duration: a.duration, error: a.error && a.error.code };
});
console.log('   audio element:', JSON.stringify(audioOk));
assert.ok(audioOk.ready >= 1 && !audioOk.error, 'recorded audio must load back through the decrypting endpoint');
await shot(page, '07-voice-detail');

// 5. Search, timeline, people, narrate
step('search / timeline / people / narrate');
await page.goto(BASE + '/search');
await page.getByLabel('Search memories').fill('cinnamon');
await page.getByRole('button', { name: 'Search' }).click();
await page.locator('.memory-card').first().waitFor();
assert.ok((await page.locator('mark').count()) > 0, 'search should highlight matches');
await shot(page, '08-search');
await page.goto(BASE + '/timeline');
await page.getByRole('heading', { name: '1962' }).waitFor();
await shot(page, '09-timeline');
await page.goto(BASE + '/people');
await page.getByText('Grandma Rose').first().click();
await page.getByRole('button', { name: /Tell .*story/ }).click();
await page.locator('.story-box').waitFor();
await shot(page, '10-person-story');

// 6. Family: add a view-only member
step('family + viewer permissions');
await page.goto(BASE + '/family');
await page.getByLabel('Their name').fill('Little Sam');
await page.getByLabel('Sign-in name').fill('sam');
await page.getByLabel('Starting password').fill('sam has a long password');
await page.getByLabel('What can they do?').selectOption('viewer');
await page.getByRole('button', { name: 'Create account' }).click();
await page.getByText('Little Sam').first().waitFor();
await shot(page, '11-family');

// 7. Settings: accessibility actually applies
step('accessibility settings');
await page.goto(BASE + '/settings');
await page.getByLabel('Text size').selectOption('large');
await page.locator('html.text-size-large').waitFor({ state: 'attached' });
await page.getByLabel(/High contrast/).check();
await page.locator('html.high-contrast').waitFor({ state: 'attached' });
await page.reload();
await page.locator('html.text-size-large.high-contrast').waitFor({ state: 'attached', timeout: 8000 });
await shot(page, '12-settings-large');
await page.getByLabel('Text size').selectOption('normal');
await page.getByLabel(/High contrast/).uncheck();

// 8. Sign out, sign in as viewer
step('viewer account');
await page.getByRole('button', { name: 'Sign out' }).click();
await page.waitForURL('**/login');
await page.getByLabel('Email or username').fill('sam');
await page.getByLabel('Password').fill('wrong password here');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.getByText('not right').waitFor();
await page.getByLabel('Password').fill('sam has a long password');
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/timeline');
assert.equal(await page.getByRole('button', { name: /Record/ }).count(), 0, 'viewer must not see Record button');
await page.goto(BASE + '/record');
await page.getByText('View-only account').waitFor();
await page.goto(BASE + '/stories');
await page.locator('.memory-card').first().waitFor();
assert.ok((await page.locator('.memory-card').count()) >= 3);
await shot(page, '13-viewer-stories');

// 9. Mobile layout
step('mobile layout');
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
const mp = await m.newPage();
await mp.goto(BASE + '/login');
await mp.getByLabel('Email or username').fill('taz');
await mp.getByLabel('Password').fill('correct horse battery staple');
await mp.getByRole('button', { name: 'Sign in' }).click();
await mp.waitForURL('**/dashboard');
await mp.getByText('Hello, Taz').waitFor();
await shot(mp, '14-mobile-dashboard');
await mp.getByRole('button', { name: 'Open menu' }).click();
await mp.waitForTimeout(400);
await shot(mp, '15-mobile-menu');
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
assert.equal(overflow, false, 'no horizontal scroll on mobile');
await mp.goto(BASE + '/stories');
await mp.waitForTimeout(600);
await shot(mp, '16-mobile-stories');

await browser.close();
console.log('\nstoryUrl', storyUrl);
console.log('external requests:', external.length ? external : 'none');
console.log('problems:', problems.length ? problems : 'none');
assert.equal(external.length, 0, 'the app must not contact any external host');
