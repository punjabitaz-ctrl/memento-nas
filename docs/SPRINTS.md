# Sprint plan

Status key: ☐ todo · ◐ in progress · ✔ done. Update this file as you work. Dates are targets, not promises; sprints are sized for a few evenings each.

## Sprint 0 (do first): Run it on the TrueNAS box
**Goal:** Memento reachable on the LAN from the NAS, data on a real dataset, surviving reboot.
| ☐ | Task | Done when |
|---|---|---|
| 0.1 | Record TrueNAS version, pool layout, docker availability over SSH → add to KNOWLEDGE_BASE §4 | Facts written, "unverified" items resolved |
| 0.2 | Create dataset `<pool>/apps/memento` (Apps preset, **no ACL**, consider encryption) and `chown` to the container UID (default plan: 568:568) | `ls -ln` shows owner |
| 0.3 | Get an image: build on the box (`docker build -t memento-nas:2.0.0 .`) **or** set up GitHub Actions → GHCR. Fix any Dockerfile problems found (first-ever build) | Image exists; `docker run` prints healthy `/health` |
| 0.4 | Install via TrueNAS Apps → Install via YAML using a compose derived from `docker-compose.yml` (no `build:`; `image:`; `user: "568:568"`; bind mount the dataset to `/data`; `TRUST_PROXY` as needed). Commit the working YAML as `deploy/truenas-app.yml` | App shows Running/healthy |
| 0.5 | Run `e2e/run.mjs` against `http://<nas-ip>:3002` from a laptop (fresh data dir) | All steps pass |
| 0.6 | Reboot TrueNAS; confirm app returns and data persists; test wrong-key refusal | Both confirmed |
**Acceptance:** SPEC §6 items 1, 2, 7. **Risk:** custom-app YAML limits, permission errors (see KB §4).

## Sprint 1: Prove it (measure, back up, HTTPS)
| ☐ | Task | Done when |
|---|---|---|
| 1.1 | Tailscale HTTPS (`tailscale serve --bg 3002` or catalog app/sidecar), `TRUST_PROXY=true`; document the exact steps that worked | Phone records and saves a voice story over HTTPS |
| 1.2 | Upload a ~1 GB video; record peak container memory (`docker stats`) and throughput; test seeking on playback | Numbers written in KB §5 (observed, not estimated) |
| 1.3 | Snapshot → destroy container → restore dataset snapshot + same key on a fresh container | All media/stories readable (SPEC §6.6) |
| 1.4 | Off-box replication or backup of the dataset (pick: second pool, USB, remote TrueNAS, cloud via encrypted dataset) | One restore from the off-box copy |
| 1.5 | Test Safari/iOS recorder (mp4 path) and Firefox | Pass/fail noted per browser |
| 1.6 | Add basic schema-migration mechanism (`meta.schema_version`, ordered idempotent steps) + test | Upgrade from a v2.0 DB works |
| 1.7 | Commit, tag `v2.0.0`, push to GitHub; README "Install on TrueNAS" section written from reality | Tagged release |
**Acceptance:** SPEC §6 items 3–6, 8.

## Sprint 2: Make it feel finished
| ☐ | Task | Notes |
|---|---|---|
| 2.1 | Thumbnails for images/video posters, generated **in memory** from the decrypted stream, stored encrypted (`kind` thumb) | Keep rule 1; cap sizes; backfill job for existing media |
| 2.2 | Fix audio duration/seek: remux or store client-measured duration in `media.duration` (column exists) | Seeking works for new recordings |
| 2.3 | Resumable/chunked uploads for flaky Wi-Fi | Interrupted 1 GB upload resumes |
| 2.4 | Screen-reader and keyboard pass on Record, Add, Search; fix findings | Checklist in repo |
| 2.5 | Elder-flow usability test with a real family member (owner to choose); log what confuses them | 5 concrete fixes |

## Sprint 3: Local transcription (privacy-preserving)
| ☐ | Task | Notes |
|---|---|---|
| 3.1 | Choose engine: whisper.cpp / faster-whisper container on the N150 (CPU only; measure real-time factor before committing) | Decision recorded in KB with measured numbers |
| 3.2 | `POST /memories/:id/transcribe` streams decrypted audio to the local engine, saves `memories.transcript`, reindexes FTS | Never writes plaintext audio to disk |
| 3.3 | UI: "Transcribe" button, progress, edit transcript | Elders can search by what they said |
| 3.4 | Compose adds the transcription service on an internal network only | No internet egress |

## Sprint 4: Family features
Comments and reactions (new tables, reuse `canView`) · notification-free "new since you last visited" · printable story/book export (PDF) · per-memory sharing to a subset of members (extends privacy model, so update SECURITY.md) · optional Claude narration (opt-in).

## Backlog / ideas
Key rotation tool (re-encrypt) · audit log · 2FA/passkeys · ARM64 build + test · import from Google Photos Takeout / folders · full-vault encrypted backup file (MEM2 + db) · multi-language UI (Spanish first) · "legacy contact" recovery sheet for the key.

## Open decisions for the owner
1. Image delivery: build on the NAS vs GHCR via CI (CI is cleaner for versioning, costs a public/private registry decision).
2. Encrypt the dataset at the ZFS level? (Recommended: protects the unencrypted metadata; costs key/passphrase handling at boot.)
3. Family access: Tailscale-only (private) vs a public hostname + reverse proxy.

## Definition of done (every task)
Tests added/updated and passing (`npm test`; E2E where UI changed) · no new external requests · rules in `CLAUDE.md` respected · README/SECURITY/docs updated · nothing fabricated (numbers are measured) · commit only when the owner asks.
