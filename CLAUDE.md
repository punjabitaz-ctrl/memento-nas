# CLAUDE.md: start here

Memento v2.0 NAS Edition: a privacy-first, encrypted family memory vault, self-hosted in one Docker container. **Target host: TrueNAS (Intel N150, 16 GB RAM, 512 GB SSD boot, 4 bays), x86-64.**

Read in this order: this file → `docs/SPRINTS.md` (what to do now) → `docs/ARCHITECTURE.md` → `docs/SPEC.md` → `docs/KNOWLEDGE_BASE.md` (decisions, gotchas, TrueNAS notes).

## State at handover (2026-10-08)
- Server + client are complete for the v2.0 scope. **All server tests pass** (`cd server && npm test`; 165 tests on `ai-foundation`, plus one known Windows-only teardown error in `api.test.js`). A Playwright browser test (`e2e/run.mjs`) passed the whole flow: setup → write → photo → voice → search → timeline → people → viewer permissions → accessibility → mobile → zero external requests.
- **Never built as a Docker image.** The authoring environment had no Docker daemon. Dockerfile, compose files and `generate-key.sh` are written but unverified on a real daemon. Their first job is Sprint 0.
- Nothing has been run on TrueNAS. The source is on GitHub (`punjabitaz-ctrl/memento-nas`) on branches `v2.0-source` and `ai-foundation`, not on `main`. The Docker image has still never been built.
- **Local AI slice (branch ai-foundation):** job queue, node registry, transcription, embeddings, hybrid retrieval, grounded Ask-the-archive, migrations. Tested against a fake node only; no real model has been run yet (do the ai-eval measurements and `docs/KNOWLEDGE_BASE.md` entry first).

## Commands
```bash
cd server && npm ci && npm test                  # no network, no AI node needed
cd client && npm ci && npm run build             # tsc + vite → client/dist
sh generate-key.sh                               # makes .env (refuses to overwrite a real one)
docker compose up -d --build                     # NAS run
node e2e/run.mjs                                 # browser E2E, fresh data dir required
node e2e/ai.mjs                                  # browser E2E for transcript + Ask (fake AI node, fresh temp data dir)
node server/ai-eval/run.js --node <url> --model <m> --dir <recordings>   # measure a transcription node on your own audio
```
Local dev: server `MEMENTO_KEY=<64hex> SESSION_SECRET=<32+> DATA_DIR=./.devdata PORT=3002 node server/index.js`; client `npm run dev` (proxies /api to :3002).
If `npm ci` fails compiling better-sqlite3 with node-gyp header download errors, the machine has no internet access to nodejs.org; install on a networked machine or use the Docker build.

## Non-negotiable rules
1. **Never write plaintext user files to disk.** Uploads go busboy → EncryptStream → `<id>.part` → rename `.enc`. Don't add temp-file or thumbnail code that breaks this.
2. **Never change the MEM2 format or key derivation** without a versioned migration. Existing vaults would become unreadable.
3. **Never commit `.env`, keys, or user data.** Never print `MEMENTO_KEY` into logs.
4. **No external network calls from the browser or server**, other than (a) the opt-in Claude call and (b) the configured local AI nodes (`AI_NODES`), which must be loopback, LAN or Tailscale addresses (`server/src/ai/netguard.js` refuses anything else at startup). The browser never calls a node. The E2E tests assert zero external requests. No CDNs, no Google Fonts, no analytics.
5. **Private memories stay invisible to everyone except their author** (even the owner). Every new query that returns memories must go through `VISIBLE`/`canView` in `server/src/memories.js`. **Private memories are also never sent to an AI node that is not flagged `local: true`**: the only gate is `NodeRegistry.eligible` in `server/src/ai/nodes.js`; never bypass it.
6. **Never state metrics, benchmarks or "tested on X" that were not actually run.** Standing preference: no fabricated figures.
7. Docs must match the code. If you change behaviour, update README/SECURITY/`docs/` in the same commit.

## Working with the owner
Peer-level, direct, quick synthesis first, expand when asked. Ask clarifying questions when a decision is genuinely his. Commit only when asked; commit trailer: `Co-Authored-By: Claude <noreply@anthropic.com>`.

## First job
Sprint 0 in `docs/SPRINTS.md`: get the image built and running on the TrueNAS box with correct permissions, then HTTPS via Tailscale.
