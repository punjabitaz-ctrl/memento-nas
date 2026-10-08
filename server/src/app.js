'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const { SqliteStore } = require('./sessionStore');
const { HttpError } = require('./util');

function createApp({ config, db, clientDist, registry = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          // NOTE: no upgrade-insecure-requests: Memento is often used over plain HTTP on a LAN.
        },
      },
      hsts: false, // let the reverse proxy decide; HSTS over a LAN-only HTTP origin is meaningless
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=(), payment=()');
    next();
  });

  // Health check: before sessions so probes never create session rows.
  app.get('/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', version: config.version, time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  // Path-only request log (never query strings: they can contain search terms).
  app.use('/api', (req, res, next) => {
    const t = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.baseUrl}${req.path} ${res.statusCode} ${Date.now() - t}ms`));
    next();
  });

  app.use(express.json({ limit: '1mb' }));

  const store = new SqliteStore(config.dirs.sessions, { defaultTtlMs: config.sessionDays * 864e5 });
  app.use(
    session({
      name: 'memento.sid',
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: config.sessionDays * 864e5 },
    })
  );

  // CSRF defence for all state-changing API calls: same-origin + custom header.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== 'memento') return next(new HttpError(403, 'Missing request header'));
    const origin = req.get('origin');
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        return next(new HttpError(403, 'Bad origin'));
      }
      const expected = (config.trustProxy && req.get('x-forwarded-host')) || req.get('host');
      if (host !== expected) return next(new HttpError(403, 'Cross-site request blocked'));
    }
    next();
  });

  const requireAuth = (req, res, next) => {
    const uid = req.session && req.session.userId;
    const u = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) : null;
    if (!u || u.disabled) return res.status(401).json({ error: 'Please sign in.' });
    req.user = u;
    next();
  };
  const requireWriter = (req, res, next) => {
    if (req.user.role === 'viewer') return res.status(403).json({ error: 'Your account is view-only.' });
    next();
  };
  const deps = { db, config, requireAuth, requireWriter, registry };

  app.get('/api/config', (req, res) => {
    res.json({
      version: config.version,
      aiAvailable: !!config.anthropicKey,
      localAi: config.ai.enabled,
      maxFileMb: config.maxFileMb,
      initialized: db.prepare('SELECT COUNT(*) c FROM users').get().c > 0,
    });
  });

  app.use('/api', require('./routes/auth')(deps));
  app.use('/api', require('./routes/memories')(deps));
  app.use('/api', require('./routes/media')(deps));
  app.use('/api', require('./routes/browse')(deps));
  app.use('/api', require('./routes/prompts')(deps));
  app.use('/api', require('./routes/export')(deps));
  app.use('/api', require('./routes/ai')(deps));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (clientDist && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use('/assets', express.static(path.join(clientDist, 'assets'), { immutable: true, maxAge: '365d' }));
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) =>
      res.status(503).type('text').send('Memento API is running, but the web app was not built (client/dist missing).')
    );
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    console.error('[error]', req.method, req.path, err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  app.locals.close = () => store.close();
  return app;
}

module.exports = { createApp };
