#!/usr/bin/env node
'use strict';
/**
 * Measures a transcription node on YOUR recordings. Nothing here is a benchmark of anyone else's data.
 *
 *   node ai-eval/run.js --node http://127.0.0.1:8000 --model <model-name> --dir ./recordings [--token T] [--out results.md]
 *
 * <dir> holds audio/video files; an optional <same-name>.txt next to each is the hand-corrected transcript.
 * Reports: compute time per audio-minute, word/character error rate (when a .txt exists), peak GPU memory (when nvidia-smi exists).
 * Exits 0 if at least one file was transcribed, 1 if every file failed, 2 on a usage or folder problem.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const client = require('../src/ai/client');
const { wer, cer } = require('../src/ai/metrics');
const { assertPrivateUrl } = require('../src/ai/netguard');

const run = promisify(execFile);
const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.webm', '.mp4', '.mov', '.aac']);
const MIME = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.aac': 'audio/aac' };

function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

function args() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  const out = { node: get('node'), model: get('model'), dir: get('dir'), token: get('token') || '', out: get('out') };
  if (!out.node || !out.model || !out.dir) {
    fail('usage: node ai-eval/run.js --node <url> --model <name> --dir <folder> [--token T] [--out results.md]');
  }
  // Same rule as the server: recordings are only ever sent to a node on a private network.
  try {
    out.node = assertPrivateUrl(out.node);
  } catch (e) {
    fail(`--node ${e.message}`);
  }
  return out;
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => AUDIO.has(path.extname(f).toLowerCase())).sort();
  } catch (e) {
    if (e.code === 'ENOENT') fail(`Folder not found: ${dir}`);
    if (e.code === 'ENOTDIR') fail(`Not a folder: ${dir}`);
    return fail(`Cannot read folder ${dir} (${e.code || e.message})`);
  }
}

async function durationSeconds(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    const d = parseFloat(stdout);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null; // ffprobe not installed, or it could not read the file
  }
}

function sampleVram() {
  let peak = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    execFile('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], (err, stdout) => {
      busy = false;
      if (!err) peak = Math.max(peak, ...stdout.split('\n').map(Number).filter(Number.isFinite));
    });
  }, 500);
  return () => { clearInterval(timer); return peak || null; };
}

async function main() {
  const o = args();
  const node = { name: 'eval', url: o.node.replace(/\/+$/, ''), token: o.token, models: { transcribe: o.model } };
  const files = listFiles(o.dir);
  if (!files.length) fail(`No audio files found in ${o.dir}`);

  const rows = [];
  for (const f of files) {
    const full = path.join(o.dir, f);
    const ext = path.extname(f).toLowerCase();
    const truthFile = full.slice(0, -ext.length) + '.txt';
    const truth = fs.existsSync(truthFile) ? fs.readFileSync(truthFile, 'utf8') : null;
    const dur = await durationSeconds(full);
    const stopVram = sampleVram();
    const t0 = Date.now();
    let res = null;
    let err = '';
    try {
      res = await client.transcribe(node, fs.createReadStream(full), { mime: MIME[ext] });
    } catch (e) {
      err = e.code === 'ENOENT' ? `file not found: ${f}` : e.message;
    }
    const secs = (Date.now() - t0) / 1000;
    const vram = stopVram();
    rows.push({
      file: f, audioSec: dur, computeSec: secs, perMin: dur ? secs / (dur / 60) : null, lang: res ? res.language : '',
      wer: res && truth !== null ? wer(truth, res.text) : null, cer: res && truth !== null ? cer(truth, res.text) : null,
      vramMiB: vram, error: err,
    });
    console.error(`${f}: ${err || 'ok'} (${secs.toFixed(1)}s)`);
  }

  const fmt = (v, d = 2) => (v === null || v === undefined ? 'n/a' : typeof v === 'number' ? v.toFixed(d) : v);
  const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ');
  const lines = [
    `# Transcription measurements: model \`${o.model}\``,
    '',
    `Run on ${new Date().toISOString()} against ${files.length} file(s). Values are from this run only.`,
    '',
    '| file | audio s | compute s | compute s per audio min | detected | WER | CER | peak GPU MiB | error |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.file)} | ${fmt(r.audioSec, 1)} | ${fmt(r.computeSec, 1)} | ${fmt(r.perMin)} | ${r.lang || 'n/a'} | ${fmt(r.wer)} | ${fmt(r.cer)} | ${fmt(r.vramMiB, 0)} | ${cell(r.error)} |`),
    '',
  ];
  console.log(lines.join('\n'));
  if (o.out) {
    try {
      fs.writeFileSync(o.out, lines.join('\n'));
    } catch (e) {
      fail(`Could not write ${o.out} (${e.code || e.message})`, 1);
    }
  }
  if (rows.every((r) => r.error)) fail('Every file failed; see the error column.', 1);
}

main().catch((e) => fail(`ai-eval failed: ${e.message}`, 1));
