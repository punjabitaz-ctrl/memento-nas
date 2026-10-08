# Architecture

## 1. Shape of the system

```
Browser (React SPA, same origin)
   │  HTTPS (via reverse proxy / Tailscale)  or plain HTTP on LAN
   ▼
Docker container "memento"  (node:20-alpine, tini PID 1, non-root, port 3002)
   Express 4 ── helmet ─ session ─ CSRF guard ─ routers
   │            │
   │            ├── SQLite (better-sqlite3, WAL, FTS5)   /data/db/memento.sqlite
   │            ├── Session store (SQLite, separate DB)   /data/sessions/sessions.sqlite
   │            └── Vault: encrypted blobs                /data/vault/<id>.enc   (+ /data/tmp)
   └── static: client/dist (built React app) + SPA fallback
Optional outbound: api.anthropic.com, only when ANTHROPIC_API_KEY is set AND a user ticks "Ask Claude"
```
One process, one container, one data folder. No external services, no queue, no cache.

## 2. Repository map
```
server/
  index.js            boot: config → open db → key check → clean stale *.part → listen; SIGTERM/SIGINT graceful (25 s)
  src/config.js       env validation (ConfigError), directories, limits
  src/crypto.js       MEM2 streaming AES-256-GCM (EncryptStream, openDecryptStream, encryptBuffer/decryptBuffer)
  src/db.js           schema, open(), key canary (verifyKey), seedPrompts, FTS reindex
  src/sessionStore.js express-session store on SQLite
  src/app.js          createApp(): middleware order, /health, /api/config, routers, static, error handler
  src/memories.js     VISIBLE sql fragment, canView/canEdit, hydrate(), tags/people helpers
  src/uploads.js      multipart parse → encrypt stream → vault; cleanup on failure/limit
  src/organize.js     offline heuristic organizer + optional Claude organizer
  src/util.js         HttpError, wrap(), validators, fuzzy-date parsing, slug
  src/data/prompts.json  149 story prompts (12 categories)
  src/routes/         auth, memories, media, browse, prompts, export
  scripts/reset-password.js   NAS-shell password reset (no key needed)
  test/               crypto.test.js (16), api.test.js (21); node:test
client/src/
  api.ts  types.ts  util.ts  auth/AuthContext.tsx  App.tsx  main.tsx
  components/  Layout, MemoryForm, MemoryCard, Recorder, ui
  pages/       Auth, Create, Prompts, Browse, MemoryDetail, Manage
  styles/      base.css (from MVP), extra.css
e2e/run.mjs       Playwright-core full-flow test (not part of Docker image)
Dockerfile  docker-compose.yml  docker-compose.traefik.yml  .env.example  generate-key.sh
```

## 3. Vault encryption (MEM2)
- File = 4-byte magic `MEM2` + 16-byte random salt + chunks. Each chunk ≤ 64 KiB plaintext + 16-byte GCM tag.
- Per-file key = HKDF-SHA256(ikm = `MEMENTO_KEY`, salt = file salt, info = `memento-file-v2`).
- Nonce = chunk counter. AAD = [final-chunk flag] ‖ recordId. Detects: bit flips, truncation, chunk reordering, file swaps between records, wrong key.
- Header length 20 bytes. Plain size is computable from ciphertext size (`plainSizeOf`), which makes Range requests cheap.
- Writes: stream to `<id>.part`, `rename` to `<id>.enc` only on success. Stale `.part` files are deleted at boot.
- Reads: `openDecryptStream(file, key, recordId, start, end)`. The media route verifies the **first chunk before sending headers** (so a bad file yields a clean 500/410, not a half-sent 200), then streams the rest; a mid-stream failure destroys the response.
- Key canary: `meta` table holds an encrypted known string. On boot, decrypt failure → `KEY_MISMATCH`, process exits with a human message. This is what stops a mistyped key from silently orphaning data.
- Metadata (titles, text, tags, people) is in plain SQLite. This is a deliberate trade-off for search; SECURITY.md states it.

## 4. Request pipeline (order matters, see `app.js`)
1. helmet (CSP self-only, no upgrade-insecure-requests, HSTS off, Permissions-Policy `microphone=(self)`)
2. path-only request logger (never logs query strings or bodies)
3. `/health` (before session, so health checks create no sessions)
4. JSON body parser (1 MB) – uploads are multipart and bypass it
5. session (cookie `memento.sid`, httpOnly, SameSite=Lax, `secure:'auto'`, 30 days)
6. CSRF guard on non-GET `/api`: requires `X-Requested-With: memento` and `Origin` host == request host
7. `/api/config` (public: initialized flag, AI available, max upload, version)
8. routers; `requireAuth` / `requireWriter` per route
9. static client + SPA fallback; JSON error handler

`TRUST_PROXY=true` is required behind a reverse proxy so `secure:'auto'` sees HTTPS.

## 5. Data model (SQLite)
| Table | Purpose / key columns |
|---|---|
| `meta` | key/value; holds `key_canary` (encrypted known string) |
| `users` | id, login (unique, NOCASE), display_name, password_hash (bcrypt 12), role `owner|contributor|viewer`, persona `elder|archivist|explorer`, settings JSON, disabled |
| `memories` | id, created_by, type `photo|video|voice_note|text_note|document`, title, description, content, transcript, memory_date + date_precision `day|month|year`, location, privacy `private|family`, prompt_id, ai_summary, ai_source, timestamps |
| `memory_tags`, `memory_people` | many-to-many by value, NOCASE |
| `media` | per-memory files: id, memory_id, kind `image|video|audio|document`, mime, original_name, size_plain, duration. File lives at `vault/<media id>.enc` |
| `prompts` | seeded 149 + custom; category, life_stage; `prompt_votes` per user |
| `memory_fts` | FTS5 (porter, unicode61) columns: title, description, body (content+transcript), tags, people, location, summary; highlight markers `\u0001`/`\u0002` |
Visibility rule (single source of truth, `VISIBLE` in `memories.js`): a memory is visible if `privacy='family'` OR `created_by = current user`.

## 6. API surface (all under `/api`, JSON unless noted)
- Auth/accounts: `GET auth/status`, `POST auth/setup` (only while no users exist), `POST auth/login` (rate-limited 10/15 min), `POST auth/logout`, `GET|PATCH auth/me`, `POST auth/password`, `GET|POST members`, `PATCH members/:id` (role, disable, reset password; last-owner protected)
- Memories: `GET|POST memories` (POST is multipart: fields + 0..n files), `GET|PATCH|DELETE memories/:id`, `POST memories/:id/organize` (offline or `useClaude:true`), `POST memories/:id/media`, `DELETE memories/:id/media/:mediaId`
- Media: `GET media/:id` (decrypting stream, Range, nosniff, CSP sandbox)
- Browse: `GET timeline`, `timeline/gaps`, `timeline/on-this-day`, `stats`, `search?q=`, `people`, `tags`, `POST narrate`
- Prompts: `GET prompts`, `prompts/categories`, `prompts/random`, `prompts/weekly`, `POST prompts`, `POST prompts/:id/vote`, `DELETE prompts/:id`
- Export: `GET export` (streamed zip, one file at a time; failures listed in `EXPORT_ERRORS.txt`; excludes others' private memories)
- `GET /health` → `{status:'ok',version,time}` (unauthenticated)

## 7. Frontend
React 18 + react-router 6 SPA, Vite 5, TypeScript strict. No state library: `AuthContext` (user, config, optimistic settings) + `useLoad` data hook. Personas change the sidebar only (elder: big/simple; archivist: manage; explorer: browse). Accessibility settings map to `<html>` classes (`text-size-large`, `text-size-xl`, `high-contrast`, `reduced-motion`). Fonts bundled via `@fontsource`.
Recorder: `MediaRecorder` with mime negotiation (`webm/opus` → `webm` → `mp4` → `ogg`), live level, listen-back review, "still there?" nudge at 15 s silence, 30 min cap. **Disabled with an explanation on non-secure origins.**

## 7b. Configuration (`.env`)
`MEMENTO_KEY` (64 hex; ≥ 8 distinct chars; not placeholder), `SESSION_SECRET` (≥ 32 chars), `MEMENTO_DATA` (host folder, compose only), `PUID`/`PGID` (compose `user:`), `HOST_PORT`, `PORT`, `DATA_DIR` (in-container `/data`), `TRUST_PROXY`, `MAX_FILE_SIZE_MB` (1–50000, default 500), `ANTHROPIC_API_KEY`, `MEMENTO_AI_MODEL`, `MEMENTO_DOMAIN` (traefik only).

## 8. Container
3-stage Dockerfile: client build (devDeps) → server deps (python3/make/g++, `npm ci --build-from-source --omit=dev` for native better-sqlite3) → runtime `node:20-alpine` + tini, `USER node`, `/data/{db,vault,sessions,tmp}`, healthcheck via `wget /health`. Compose: single bind mount `${MEMENTO_DATA}:/data`, `user: PUID:PGID`, `mem_limit 512m`, `stop_grace_period 30s`. **Unbuilt as of handover.**

## 9. Performance characteristics (design, not measured)
Streaming 64 KiB chunks means memory should not grow with file size. bcrypt cost 12 is the only CPU-heavy step (login). Not benchmarked on the N150; measure before quoting numbers (Sprint 1).

## 10. Extension points
- Transcription: add an `/memories/:id/transcribe` that decrypts to a stream and pipes into a **local** whisper container (keeps privacy). Store text in `memories.transcript` (already indexed by FTS).
- Thumbnails: generate from the decrypted stream **in memory**, store as a second `.enc` (kind `thumb`) in `media`. Never write plaintext.
- Comments/reactions: new tables referencing memories/users; reuse `canView`.
- Key rotation: needs a re-encrypt migration tool (not built).
