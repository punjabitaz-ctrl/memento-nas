# Knowledge base

## 1. Provenance
- The NAS repo (`punjabitaz-ctrl/memento-nas`) originally held only a deployment scaffold (Dockerfile, compose, README, SECURITY) describing a v2.0 whose source was never committed.
- An earlier local MVP (`F:\ClaudeCode\memento-mvp`, identical zip) held the UI, personas, prompt library and timeline ideas, but not the v2.0 server.
- This codebase **rebuilds v2.0 to the scaffold's contract** and ports the MVP's UX, persona model, stylesheet and 149 prompts (deduplicated). Old README/SECURITY claims (single IV, one account, connect-sqlite3, "temp file") were obsolete and replaced.
- `memento-build-brief.md` (earlier handoff) is superseded by `docs/`.

## 2. Decision log (why things are the way they are)
| # | Decision | Reason |
|---|---|---|
| D1 | Chunked STREAM-style AES-GCM, 64 KiB chunks | Constant memory for multi-GB video on a small NAS; verified Range seeking; tamper/truncation detection |
| D2 | HKDF per-file key from master key + random salt | No key reuse across files; no per-file key storage |
| D3 | Plaintext never on disk | Stated security promise; `.part`→rename |
| D4 | Metadata unencrypted in SQLite | Need FTS search; encrypting rows would kill search. Recommend dataset encryption |
| D5 | Key canary in `meta` | A typo'd `MEMENTO_KEY` would otherwise start a "working" empty-looking vault |
| D6 | Private memories hidden even from owner | Elders may record things they don't want the family organiser to see |
| D7 | Owner creates members (no email) | NAS has no mail; keeps everything local |
| D8 | Header `X-Requested-With: memento` + Origin check for CSRF | Simple, no token plumbing, SameSite=Lax as second layer |
| D9 | Custom SQLite session store in separate DB | Drop `connect-sqlite3`; keeps session churn out of the data DB |
| D10 | Offline heuristic organizer default; Claude opt-in per item, text only | Privacy promise |
| D11 | No audio transcription in v2.0 | Cloud STT violates privacy promise; local STT is a future sprint |
| D12 | CommonJS server, no TypeScript on server | Matches scaffold, fewer build steps in Alpine |
| D13 | Bind-mount single data folder, not named volumes | NAS admins need a path to snapshot/back up; named volumes hide data |
| D14 | `user: PUID:PGID` in compose | NAS datasets have non-1000 owners; mismatch = EACCES |
| D15 | Fonts bundled locally | Google Fonts leaks visits and breaks offline |
| D16 | SVG uploads rejected; media served `nosniff` + `CSP: sandbox` | Stored-XSS prevention on same origin |
| D17 | bcrypt via `bcryptjs` (pure JS) | No second native build in Alpine; password max 72 bytes enforced |
| D18 | Export is plain zip | Escape hatch: family can read without Memento; documented as unencrypted |

## 3. Gotchas and bugs already hit (don't re-learn)
- **Microphone needs a secure context.** `navigator.mediaDevices` is undefined on `http://<lan-ip>`. Recorder detects it and explains. Test over HTTPS or `localhost`.
- **Search prefixes:** FTS5 `porter` stems tokens, so prefix queries like `cinna*` can miss; `search` falls back to a LIKE query when FTS returns nothing.
- **RecorderPanel remount bug:** rendering the recorder in two conditional branches remounted it and lost the recording. Keep one instance in a stable tree position (see `Create.tsx` comment).
- **Optimistic settings:** `saveSettings` updates UI first, rolls back on server error. Reading `user` from a ref avoids stale closures.
- **CSP blocks `eval`:** Playwright `waitForFunction` with strings fails under the app's CSP; pass functions.
- **`node --test` with a directory arg** fails on some Node versions; script uses the glob `test/*.test.js`.
- **MediaRecorder webm has no duration metadata**, so `audio.duration` is `Infinity`/null in Chrome and seeking is rough. Cosmetic; fix with a remux or by storing duration client-side (backlog).
- **Test race:** concurrent uploads in tests need to await the response before reading the vault dir.
- **`.env` safety:** `generate-key.sh` refuses to overwrite a `.env` that has real keys, because replacing `MEMENTO_KEY` on a populated vault orphans all data.
- **Sandbox where this was authored** had no Docker daemon and no access to nodejs.org (node-gyp header download fails). Neither is a product bug.

## 4. TrueNAS notes

**Verified from TrueNAS docs/forum (read during handover):**
- TrueNAS "Apps" (SCALE 24.10 and later, "Community Edition" 25.04+) run on Docker and can install a **custom app from YAML** (Docker Compose syntax) via Apps → Discover Apps → Install via YAML.
- Forum guidance for compose apps ([forum thread](https://forums.truenas.com/t/docker-compose-acl-permissins-hell/52140)): avoid ACLs on app datasets unless needed; create an **Apps dataset with the "Apps" preset and no ACL**, a **child dataset per app**; the generic apps user is **568**; set ownership to the UID/GID the container runs as; use `user: UID:GID` for images that run non-root (PUID/PGID only for images that start as root and drop privileges); use host-path bind mounts; snapshot before changes.
- Docs: [Install Custom App screens (25.04)](https://www.truenas.com/docs/scale/25.04/scaleuireference/apps/installcustomappscreens/).

**Consequences for Memento (design inference, to confirm in Sprint 0):**
- Memento starts as non-root and does not drop privileges, so use `user: "568:568"` in compose and `chown -R 568:568` the app dataset (or choose another UID and match it). Do **not** use PUID/PGID semantic; Memento's `PUID`/`PGID` only feed `user:`.
- Dataset suggestion: `tank/apps/memento` (preset Apps, no ACL, optionally encrypted) → `MEMENTO_DATA=/mnt/<pool>/apps/memento`. Snapshot schedule on this dataset is the backup story; replicate off-box too.

**Unverified: check on the real box, then update this file:**
- Whether the custom-app YAML installer accepts `build:` (likely not; expect a prebuilt image). Options: (a) build over SSH with `docker build -t memento-nas:2.0.0 .` and reference the local tag, (b) CI to GHCR (GitHub Actions) and reference `ghcr.io/...`. Pick one and document.
- Exact TrueNAS version on the box and whether the docker CLI is usable over SSH.
- Whether the Tailscale app from the TrueNAS catalog (or a Tailscale sidecar container in the same compose) is the better HTTPS route; `tailscale serve --bg 3002` is the intended mechanism and also requires HTTPS certificates enabled in the tailnet.
- CPU/RAM behaviour of an upload of a large video on the N150 (record the real numbers).
- Which pool layout the user has (bays/RAID); this decides where the dataset lives.

## 5. Operational runbook
- **Backup:** ZFS snapshots of the data dataset (+ replicate off-box). Key backed up separately. Restore test = Sprint 1.
- **Wrong key:** container exits with `KEY_MISMATCH`; fix `.env`; never "reset" the canary on a populated vault.
- **Forgot a password:** `docker exec -it memento node scripts/reset-password.js <login> '<new pw>'` (list users with `--list`).
- **Upgrade:** `git pull`, rebuild image, restart. SQLite schema is `CREATE IF NOT EXISTS`; there is **no migration framework yet**, so any schema change must add an explicit, idempotent migration (backlog item).
- **Disk full:** uploads fail and `.part` is removed; export errors are listed in `EXPORT_ERRORS.txt`.

## 6. Glossary
Vault = the `/data/vault` folder of `.enc` files · MEM2 = this encrypted file format · Canary = encrypted known string proving the key is right · Persona = UI layout choice · Fuzzy date = year/month/day precision date · Owner/contributor/viewer = roles

## 7. Known limitations (honest list)
Metadata unencrypted · no transcription · no thumbnails (large images load full-size; HEIC won't preview) · no comments · no schema migrations · no resumable uploads · no audit log/2FA · only Chromium E2E-tested · arm64 untested · Docker image never built at handover · no performance numbers.
