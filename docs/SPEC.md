# Product Spec: Memento v2.0 NAS Edition

## 1. Purpose
Give a family a private place to capture, keep and rediscover their stories, voices and photos. Everything stays on hardware they own. Elders should be able to contribute by simply talking; relatives should be able to browse without technical skill.

## 2. Users and personas
| Persona | Who | Needs | Layout |
|---|---|---|---|
| **Elder** | Parent/grandparent sharing stories | One big button, a question to answer, no menus | `elder`: Share → Record, Prompts, My stories |
| **Archivist** | The family organiser (usually the owner) | Import old photos/scans, tidy metadata, manage members, back up | `archivist`: Manage / Create / Explore / Tools |
| **Explorer** | Younger relatives | Browse by time, person, search | `explorer`: Timeline, Search, People, Stories |
Roles (separate from persona): **owner** (all + family management), **contributor** (add and edit own), **viewer** (read/listen only).

## 3. Goals / non-goals
**Goals:** self-hosted on a NAS; files encrypted at rest; works offline on a LAN; zero third-party requests; family accounts without email; fast search; easy export.
**Non-goals (v2.0):** public sharing, cloud sync, native mobile apps, multi-vault/multi-tenant, social features, printing.

## 4. Functional requirements (all implemented unless marked ☐)
**F1 Setup & accounts**
- First visit creates the owner (name, login, password 10–72 bytes); setup screen forces acknowledgement of key backup. Setup closes once a user exists.
- Owner adds members (login + starting password, role, persona), changes roles, disables, resets passwords. Cannot remove/demote the last owner.
- Sign in/out; users change own password, persona and settings (text size normal/large/extra-large, high contrast, reduced motion).
**F2 Capture**
- Record a voice story in-browser (HTTPS/localhost only), with listen-back before saving; optional prompt attached.
- Write a story; upload photos/video/audio/documents (multiple per memory) with progress.
- Fuzzy dates: year, month or day precision. Location, tags, people, `family`/`private` visibility.
- Weekly prompt (deterministic ISO-week pick), 149 built-in prompts in 12 categories, custom prompts, votes.
**F3 Organise**
- "Tidy up": offline heuristic suggests tags, people, date, summary; user applies selectively.
- Optional "Ask Claude" per memory (only if key configured; text only; explicit tick).
- Edit/delete memories and individual files.
**F4 Browse & search**
- Stories list (all / mine), timeline by year, decade gap analysis ("no stories from the 1970s yet"), on-this-day, people index and person page with "Tell the story" narration (offline), tags, stats dashboard.
- Full-text search with highlighting (FTS5 porter; LIKE fallback for prefixes).
**F5 Protect & export**
- Encrypted vault; private memories hidden from everyone but the author.
- Owner/any member can download a streamed zip of everything they can see.
**F6 Operate**
- `/health`, graceful shutdown, key-mismatch refusal, config validation, `reset-password.js`, structured error messages for the NAS admin.
**F7 Transcription** (local, privacy-preserving): implemented against OpenAI-compatible local nodes (job queue with retries, per-file transcripts, a person's edits are never overwritten, per-file language detection). Off unless `AI_ENABLED=true`. Accuracy per language is **not yet measured**; run `server/ai-eval`.
**F11 Ask the archive** (grounded, cited Q&A over the family's stories, persona-aware, forwards unanswered questions to elders as prompts): implemented against local nodes; every answer sentence must cite a memory the asker may see, and private memories never reach a remote node. Quality depends on the chosen models and has **not yet been measured**; tested against a fake node only.
☐ **F8 Comments & reactions**: not built.
☐ **F9 Thumbnails / HEIC preview**: not built.
☐ **F10 Key rotation tool**: not built.

## 5. Non-functional requirements
| Area | Requirement | Status |
|---|---|---|
| Security | See SECURITY.md; AES-256-GCM chunked, bcrypt 12, CSRF header+origin, CSP, rate limit | Implemented, unit/integration tested |
| Privacy | No external requests (browser asserted by E2E); Claude strictly opt-in; local AI only talks to configured private-network nodes, and private memories never reach a non-`local` node | Browser requests verified in E2E; node behaviour tested against a fake node only |
| Reliability | Atomic writes (`.part`→rename); SQLite WAL + `synchronous=FULL`; stale `.part` cleanup; graceful SIGTERM 25 s | Implemented; power-loss behaviour untested |
| Resource | Runs in 512 MB container limit | **Not measured**; verify in Sprint 1 |
| Scale | Designed for a single family: ≤ ~20 users, tens of thousands of memories, TB of media | Not load-tested |
| Browsers | Current Chrome, Edge, Firefox, Safari (iOS/macOS) | Only Chromium tested; Safari recorder path coded (mp4 negotiation) but untested |
| Accessibility | Large text, high contrast, reduced motion, keyboard operable, labelled controls | Partially verified (settings apply & persist); no screen-reader audit |
| Offline | Works on LAN with no internet | Yes (bundled fonts) |

## 6. Acceptance criteria for "v2.0 on TrueNAS" (definition of done for Sprint 0–1)
1. `docker compose up -d --build` (or equivalent TrueNAS app) starts and `/health` returns ok within 30 s.
2. Container runs as the dataset owner; data persists across container restart **and** TrueNAS reboot.
3. Owner setup, upload of a 1 GB video, and playback with seeking all work over the LAN.
4. Container memory stays under 512 MB during that upload (record the observed peak, do not guess).
5. HTTPS URL (Tailscale) works and the Record page can capture and save audio on a phone.
6. Restoring a ZFS snapshot of the data dataset + the same `MEMENTO_KEY` on a fresh container reads all media.
7. Starting with a wrong key refuses to boot with a clear message.
8. `docs/KNOWLEDGE_BASE.md` updated with whatever TrueNAS actually required.

## 7. Risks
| Risk | Impact | Mitigation |
|---|---|---|
| Key lost | Total data loss | Setup screen warning, README/SECURITY, key canary; consider printed recovery sheet |
| Metadata unencrypted | Text readable if disk stolen | TrueNAS dataset encryption (recommend); documented |
| Plain HTTP on LAN | Credential sniffing on LAN | HTTPS via Tailscale/reverse proxy; Secure cookie auto |
| TrueNAS app model changes between releases | Deployment breaks | Pin image tags; keep compose canonical; document tested TrueNAS version |
| Single-container SQLite | No HA | Snapshots + backups; acceptable for family scale |
| Large uploads over flaky Wi-Fi | Failed uploads | Chunked/resumable upload (backlog) |
