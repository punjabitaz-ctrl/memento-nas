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
Optional outbound: the AI nodes listed in AI_NODES (loopback / LAN / Tailscale only), only when AI_ENABLED=true
```
One process, one container, one data folder. No required external services and no cache. With local AI on, a background worker in the same process runs a job queue kept in SQLite (section 11).

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
  src/util.js         HttpError, wrap(), validators, fuzzy-date parsing, slug, ftsQuery (FTS5 query builder)
  src/data/prompts.json  149 story prompts (12 categories)
  src/routes/         auth, memories, media, browse, prompts, export, ai (Ask + transcribe + AI status)
  src/migrations/     index.js (ordered, idempotent, meta.schema_version), 002-ai-foundation.js, 003-ai-jobs-media-index.js, helpers.js
  src/ai/             local AI layer (section 11)
    config.js           parses AI_ENABLED / AI_NODES / AI_MAX_CHUNK_TOKENS / AI_POLL_MS; one embed model per vault
    netguard.js         node URL must be loopback, LAN, Tailscale or a private-looking name (checked at startup)
    client.js           OpenAI-compatible HTTP calls (node:http/https): health, embed, chat, transcribe (streamed)
    nodes.js            NodeRegistry: eligible()/withNode(), failover, health; the private-memory choke point
    jobs.js             ai_jobs queue: enqueue, claim, defer, fail (backoff), skip, stats
    worker.js           polling loop that runs one job at a time
    hooks.js            onMemorySaved(): queue transcription + embedding after a save
    backfill.js         queue missing transcriptions/embeddings (boot and owner button)
    transcribe.js       decrypt-stream a file to a node; store per-file transcript; recompose the memory transcript
    embed.js            chunk text, embed in batches, store unit-length float32 vectors
    retrieve.js         hybrid FTS5 + vector retrieval, filtered by VISIBLE
    answer.js           grounded prompt, sentence-level citation validation, ask_log
    errors.js           NoEligibleNode, NodeUnavailable
    metrics.js          WER/CER scoring used by ai-eval
    index.js            createAi(): registry + worker + boot backfill + periodic health check
  ai-eval/            run.js + README: measure a transcription node on your own recordings
  scripts/reset-password.js   NAS-shell password reset (no key needed)
  test/               node:test: crypto, api, migrate, and ai-*.test.js (fake AI node in test/helpers/)
client/src/
  api.ts  types.ts  util.ts  auth/AuthContext.tsx  App.tsx  main.tsx
  components/  Layout, MemoryForm, MemoryCard, Recorder, ui
  pages/       Auth, Create, Prompts, Browse, MemoryDetail, Manage, Ask
  styles/      base.css (from MVP), extra.css
e2e/run.mjs       Playwright-core full-flow test (not part of Docker image)
e2e/ai.mjs        Playwright-core test for transcripts + Ask, against a fake AI node and a fresh temp data dir
ai-node/          README + compose file for a desktop AI node (Whisper-class server + Ollama); not part of the Docker image
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
7. `/api/config` (public: initialized flag, AI available, `localAi` flag, max upload, version)
8. routers; `requireAuth` / `requireWriter` per route
9. static client + SPA fallback; JSON error handler

`TRUST_PROXY=true` is required behind a reverse proxy so `secure:'auto'` sees HTTPS.

## 5. Data model (SQLite)
| Table | Purpose / key columns |
|---|---|
| `meta` | key/value; holds `key_canary` (encrypted known string) |
| `users` | id, login (unique, NOCASE), display_name, password_hash (bcrypt 12), role `owner|contributor|viewer`, persona `elder|archivist|explorer`, settings JSON, disabled |
| `memories` | id, created_by, type `photo|video|voice_note|text_note|document`, title, description, content, transcript, `transcript_source` (`''|machine|human`), `transcript_languages` (JSON), memory_date + date_precision `day|month|year`, location, privacy `private|family`, prompt_id, ai_summary, ai_source, timestamps |
| `memory_tags`, `memory_people` | many-to-many by value, NOCASE |
| `media` | per-memory files: id, memory_id, kind `image|video|audio|document`, mime, original_name, size_plain, duration, and for audio/video `transcript`, `transcript_segments` (JSON, timestamps), `transcript_language`. File lives at `vault/<media id>.enc` |
| `prompts` | seeded 149 + custom; category, life_stage; `source` (`'ask'` for forwarded questions), `requested_by`, `addressed_to` (JSON user ids); `prompt_votes` per user |
| `ai_jobs` | local AI queue: kind `transcribe|embed`, memory_id, media_id, status `pending|running|done|failed|skipped`, attempts, next_run_at, last_error, unique idempotency_key |
| `chunks` | searchable text pieces of a memory: ord, text, model, dim, embedding BLOB (unit-length float32) |
| `ask_log` | one row per question the archive answered or could not: user_id, question, answer, cited (JSON memory ids), outcome `answered|no_record|reported` |
| `memory_fts` | FTS5 (porter, unicode61) columns: title, description, body (content+transcript), tags, people, location, summary; highlight markers `\u0001`/`\u0002` |
Visibility rule (single source of truth, `VISIBLE` in `memories.js`): a memory is visible if `privacy='family'` OR `created_by = current user`.

## 6. API surface (all under `/api`, JSON unless noted)
- Auth/accounts: `GET auth/status`, `POST auth/setup` (only while no users exist), `POST auth/login` (rate-limited 10/15 min), `POST auth/logout`, `GET|PATCH auth/me`, `POST auth/password`, `GET|POST members`, `PATCH members/:id` (role, disable, reset password; last-owner protected)
- Memories: `GET|POST memories` (POST is multipart: fields + 0..n files), `GET|PATCH|DELETE memories/:id`, `POST memories/:id/organize` (offline or `useClaude:true`), `POST memories/:id/media`, `DELETE memories/:id/media/:mediaId`
- Media: `GET media/:id` (decrypting stream, Range, nosniff, CSP sandbox)
- Browse: `GET timeline`, `timeline/gaps`, `timeline/on-this-day`, `stats`, `search?q=`, `people`, `tags`, `POST narrate`
- Prompts: `GET prompts`, `prompts/categories`, `prompts/random`, `prompts/weekly`, `POST prompts`, `POST prompts/:id/vote`, `DELETE prompts/:id`
- Local AI (signed-in users; most return 503 while `AI_ENABLED` is off): `POST ask` (rate-limited 20/min/user), `GET ask/history`, `DELETE ask/:id`, `POST ask/:id/report`, `POST ask/:id/forward` (writers only, only for unanswered questions, idempotent), `POST memories/:id/transcribe` (`{overwrite?}`; author or owner), `GET ai/status` (owner also sees node URLs and the queue), `POST ai/backfill` (owner)
- Export: `GET export` (streamed zip, one file at a time; failures listed in `EXPORT_ERRORS.txt`; excludes others' private memories)
- `GET /health` → `{status:'ok',version,time}` (unauthenticated)

## 7. Frontend
React 18 + react-router 6 SPA, Vite 5, TypeScript strict. No state library: `AuthContext` (user, config, optimistic settings) + `useLoad` data hook. Personas change the sidebar only (elder: big/simple; archivist: manage; explorer: browse). Accessibility settings map to `<html>` classes (`text-size-large`, `text-size-xl`, `high-contrast`, `reduced-motion`). Fonts bundled via `@fontsource`.
Recorder: `MediaRecorder` with mime negotiation (`webm/opus` → `webm` → `mp4` → `ogg`), live level, listen-back review, "still there?" nudge at 15 s silence, 30 min cap. **Disabled with an explanation on non-secure origins.**

## 7b. Configuration (`.env`)
`MEMENTO_KEY` (64 hex; ≥ 8 distinct chars; not placeholder), `SESSION_SECRET` (≥ 32 chars), `MEMENTO_DATA` (host folder, compose only), `PUID`/`PGID` (compose `user:`), `HOST_PORT`, `PORT`, `DATA_DIR` (in-container `/data`), `TRUST_PROXY`, `MAX_FILE_SIZE_MB` (1–50000, default 500), `ANTHROPIC_API_KEY`, `MEMENTO_AI_MODEL`, `MEMENTO_DOMAIN` (traefik only).
Local AI: `AI_ENABLED` (default false), `AI_NODES` (JSON array: name, url, capabilities, models per capability, optional priority / local / token; every `embed` node must use the same model), `AI_MAX_CHUNK_TOKENS` (50-2000, default 200), `AI_POLL_MS` (20-60000, default 5000). Invalid values stop the server from starting with a message.

## 8. Container
3-stage Dockerfile: client build (devDeps) → server deps (python3/make/g++, `npm ci --build-from-source --omit=dev` for native better-sqlite3) → runtime `node:20-alpine` + tini, `USER node`, `/data/{db,vault,sessions,tmp}`, healthcheck via `wget /health`. Compose: single bind mount `${MEMENTO_DATA}:/data`, `user: PUID:PGID`, `mem_limit 512m`, `stop_grace_period 30s`. **Unbuilt as of handover.**

## 9. Performance characteristics (design, not measured)
Streaming 64 KiB chunks means memory should not grow with file size. bcrypt cost 12 is the only CPU-heavy step (login). Not benchmarked on the N150; measure before quoting numbers (Sprint 1).

## 10. Extension points
- Transcription: built (section 11). New AI capabilities should go through `NodeRegistry.withNode` so the privacy gate applies.
- Thumbnails: generate from the decrypted stream **in memory**, store as a second `.enc` (kind `thumb`) in `media`. Never write plaintext.
- Comments/reactions: new tables referencing memories/users; reuse `canView`.
- Key rotation: needs a re-encrypt migration tool (not built).

## 11. Local AI layer
Optional (`AI_ENABLED=true`). The vault never depends on it: if no node answers, saving still works and jobs wait.
```
 memory saved ──► ai_jobs (SQLite) ──► worker ──► NodeRegistry ──► node (desktop GPU, or NAS-local)
                                                       ▲ privacy gate: 'private' only reaches nodes with local:true
 transcribe job: decrypt stream (memory only) ──► node ──► media.transcript ──► memories.transcript ──► FTS reindex
 embed job:      memory text ──► chunks ──► node ──► chunks.embedding (vectors)

 question ──► embed the question ──┐
         ──► FTS5 keyword search ──┴─► both filtered by VISIBLE ──► rank fusion ──► top passages
         ──► grounded prompt ──► chat node ──► validate: every sentence cites a passage ──► ask_log
```
- **Jobs:** `ai_jobs` rows with idempotency keys (enqueue ignores only a duplicate key; any other constraint violation throws). One job at a time. A real failure backs off 1 min, doubling (1, 2, 4, 8, 16 min), and the job is `failed` after 6 attempts. The code also caps the wait at 1 h, which only matters if the attempt limit is raised. A node that is eligible but unreachable *defers* the job (5 min) without using an attempt. A node that is not allowed, such as a private memory with no `local` node, *skips* it. At boot, jobs left `running` are put back to `pending`, and a backfill queues missing transcriptions and embeddings (idempotent while the node configuration is unchanged). The backfill treats a memory as needing embeddings when it has no chunks for the current model, or when its newest chunk is older than the memory's `updated_at` (so stale passages are refreshed); it enqueues everything in one transaction. The owner can run the same backfill, which also retries `failed` jobs.
- **Privacy gate:** `NodeRegistry.eligible(capability, privacy)` is the only place that decides which nodes may see a memory. `privacy` must be exactly `family` or `private` (else `TypeError`); only `local: true` nodes serve `private`. `withNode` also accepts a function returning the privacy; it is called before every attempt (failover included) and nodes no longer allowed are skipped (`NoEligibleNode` when none is left). The transcribe and embed jobs pass a function that re-reads the memory's privacy (a deleted memory counts as `private`); a transcription upload to a non-local node also re-reads it about every 4 MiB and aborts (job skipped) once the memory is private. In Ask, passages from private memories reach the chat model only when a `local` chat node exists.
- **Node client:** `node:http`/`https` (so very long transcriptions are not cut off by `fetch`'s fixed timeouts), never follows redirects, gives a node 8 s to accept the connection (separate from the per-call deadline), refuses response bodies over 32 MiB, and its errors carry only the node name plus an HTTP status or error code. `POST /api/ask` maps a chat node refusing the request to 502 with a generic message. Calls are `/v1/models` (health), `/v1/embeddings`, `/v1/chat/completions`, `/v1/audio/transcriptions` (multipart, streamed from the vault, with no file name sent).
- **Transcripts:** stored per file (`media.transcript`, `.transcript_segments`, `.transcript_language`); the memory transcript is the per-file texts joined in upload order, with `transcript_source = 'machine'` and the union of detected languages. A transcript a person typed or edited is `human` and is never overwritten by a machine run, including text that existed before the migration. `POST /api/memories/:id/transcribe {overwrite:true}` is the explicit way to replace it.
- **Embeddings:** the text of a memory (title, description, story, transcript) is cut into chunks of about `AI_MAX_CHUNK_TOKENS` (estimated at 3 characters per token, preferring sentence ends including the danda and Urdu/Arabic marks). Each chunk is embedded with a short header (title, date, contributor, people) and stored as a unit-length float32 BLOB with its model id and dimension. Vectors that are zero or contain non-finite numbers are rejected, and a job whose memory was edited meanwhile is skipped (the edit queued a fresh one; organizing a memory re-queues it too). **Chunks are invalidated when content changes, and every such route queues a fresh embed:** `PATCH /api/memories/:id` deletes the memory's chunks when the title, description, story, transcript or privacy changed; adding a file, deleting a file, and a transcript recompose that changes the text (a finished transcription, or a removed recording's machine transcript) do the same; organize does it when it changes tags, people or location. The delete runs in the same transaction as the change (one helper, `invalidateChunks`, which also works with AI off), so text a person removed is never served from old chunks while the re-embed job waits. Each of these routes (PATCH, organize, add media, delete media) also moves `updated_at` and calls `onMemorySaved`, which queues a new embed job, and a finished transcription queues one too. A PATCH that only edits tags, people or location keeps the old chunks (their text did not change) until the queued embed replaces them. Until the new chunks exist, retrieval finds the memory by keyword and quotes its current text. As a safety net, the backfill also re-queues any memory whose newest chunk is older than its `updated_at`. All `embed` nodes must use one model (checked at startup); changing the model means updating `AI_NODES`, restarting and letting the backfill re-embed.
- **Retrieval:** keyword search over `memory_fts` with the question's words joined by OR (combining marks are kept inside words, so Gurmukhi and Devanagari words match), plus a brute-force cosine scan over `chunks` of the current model. Both are filtered by `VISIBLE` in SQL, the results are fused by reciprocal rank, and every returned memory is re-checked with `canView`. If embedding the question fails for any reason (no embed node, node down, bad reply), retrieval falls back to keyword-only; the result carries `mode` (`keyword` or `hybrid`) and `degraded: true` when a node failure caused the fallback.
- **Answers:** the system prompt tells the model to use only the numbered sources and to answer `NO_RECORD` otherwise; the sources and the question sit in the user message, with `<` escaped and fake source labels broken up. The question is cut to 1000 characters inside `ask()` (the route accepts 500). The reply is split into sentences (an abbreviation-aware splitter), citations are normalised (`[S1, S2]` becomes `[S1][S2]`), citations to non-existent sources are removed, and sentences left with none are dropped and counted (`dropped`). If nothing remains the outcome is `no_record`. Persona sets the style (explorer, archivist, elder); the reply language follows the browser's language (sent by the Ask page) and falls back to English for an unknown code. If the chat node cannot be used, `POST /api/ask` returns 503 and no `ask_log` row is written.
- **Languages:** Whisper-class servers report one language per file, so a recording that mixes languages is transcribed with that single guess and accuracy for the rest is unknown. Per-language accuracy has not been measured; run `server/ai-eval`.
- **Migrations:** `server/src/migrations/` (`meta.schema_version`). Version 1 is the original v2.0 schema (`db.js`); version 2 (`002-ai-foundation.js`) adds the AI tables (`ai_jobs`, `chunks`, `ask_log`) and the transcript and prompt columns; version 3 (`003-ai-jobs-media-index.js`) adds an index on `ai_jobs(media_id)` (the backfill looks up each recording's jobs). Each runs in a transaction at startup, and applied migrations are never edited.
