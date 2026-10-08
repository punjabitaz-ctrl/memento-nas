'use strict';
/**
 * Configuration loader + boot-time validation.
 * Memento refuses to start with placeholder or malformed secrets, because a
 * vault encrypted with a throwaway key is unrecoverable.
 */
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '2.0.0';

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid configuration');
    this.problems = problems;
  }
}

function load(env = process.env) {
  const problems = [];

  const key = (env.MEMENTO_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    problems.push(
      'MEMENTO_KEY must be exactly 64 hex characters (32 bytes). Run ./generate-key.sh to create one.'
    );
  } else if (new Set(key.toLowerCase()).size < 8) {
    problems.push('MEMENTO_KEY looks non-random. Run ./generate-key.sh to create a real key.');
  }

  const secret = (env.SESSION_SECRET || '').trim();
  if (secret.length < 32 || /^REPLACE/i.test(secret)) {
    problems.push(
      'SESSION_SECRET must be a random string of at least 32 characters. Run ./generate-key.sh.'
    );
  }

  const port = parseInt(env.PORT || '3002', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be 1-65535.');

  const maxMb = parseInt(env.MAX_FILE_SIZE_MB || '500', 10);
  if (!Number.isInteger(maxMb) || maxMb < 1 || maxMb > 50000) {
    problems.push('MAX_FILE_SIZE_MB must be a whole number between 1 and 50000.');
  }

  const dataDir = path.resolve(env.DATA_DIR || '/data');
  const dirs = {
    data: dataDir,
    db: path.join(dataDir, 'db'),
    vault: path.join(dataDir, 'vault'),
    sessions: path.join(dataDir, 'sessions'),
    tmp: path.join(dataDir, 'tmp'),
  };
  if (!problems.length) {
    for (const d of Object.values(dirs)) {
      try {
        fs.mkdirSync(d, { recursive: true });
        fs.accessSync(d, fs.constants.W_OK);
      } catch (e) {
        problems.push(
          `Data directory not writable: ${d} (${e.code}). On a NAS bind mount, give uid 1000 write access.`
        );
      }
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    version: VERSION,
    port,
    key: Buffer.from(key, 'hex'),
    sessionSecret: secret,
    trustProxy: String(env.TRUST_PROXY || 'false').toLowerCase() === 'true',
    maxFileBytes: maxMb * 1024 * 1024,
    maxFileMb: maxMb,
    dirs,
    anthropicKey: (env.ANTHROPIC_API_KEY || '').trim(),
    aiModel: (env.MEMENTO_AI_MODEL || 'claude-haiku-4-5-20251001').trim(),
    clientDist: env.CLIENT_DIST ? path.resolve(env.CLIENT_DIST) : null,
    sessionDays: 30,
  };
}

module.exports = { load, ConfigError, VERSION };
