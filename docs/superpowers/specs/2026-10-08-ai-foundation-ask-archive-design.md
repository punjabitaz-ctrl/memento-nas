# Design: AI foundation + "Ask the archive"

Status: implemented on branch ai-foundation, tested against a fake node only; synced with the code after review · Date: 2026-10-08 · Scope: first AI slice of Memento NAS

## 1. Purpose

Memento is a self-hosted, encrypted family vault serving three generations: elders who found the archive, middle-generation archivists who run it, and younger relatives who ask who they are and where they come from. Their questions should become the elders' next prompts, which keeps the archive growing.

This slice adds local AI so that voice stories become searchable text, and a descendant can ask the archive a question and get an answer grounded in, and cited to, real memories.

## 2. Decisions already made (with the owner)

| Decision | Choice |
|---|---|
| Where AI runs | **Hybrid**: desktop GPU node (over Tailscale) as primary; NAS (N150, CPU) as fallback for small jobs |
| First slice | AI foundation + Ask the archive |
| Trust boundary | Family memories may go to the node; **private memories never leave the NAS** |
| Languages | English, Punjabi, Urdu/Hindi, Spanish, French, Portuguese, Tamil, Romanian; frequent mixed-language recordings |
| Learning | Local, inspectable rows only. No fine-tuning on family data |

## 3. Non-goals for this slice

Elder interviewer, capability-training/coaching UI, R&D feedback loop beyond a local "report this answer" log, voice cloning or answering "as" a deceased person, fine-tuning, video understanding, speaker diarization.

## 4. Architecture

```
Elder records → vault (MEM2-encrypted, unchanged)
   → job row in `ai_jobs`
   → worker streams DECRYPTED audio to an AI node in memory (never to disk)
        family memories only
   ← transcript + segments + detected languages
   → stored in SQLite (editable), then chunked + embedded
Descendant asks a question
   → embed question → retrieve chunks the ASKER may see (VISIBLE/canView)
   → chat model answers from those chunks only → citations validated
   → no support found → "no record yet" + button to send the question to an elder as a prompt
```

If no node is reachable, jobs wait and the UI shows "transcript pending". The vault itself never depends on AI.

### 4.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `server/src/ai/nodes.js` | Node registry, health checks, per-capability selection, failover, **private-memory choke point** | config |
| `server/src/ai/jobs.js` | `ai_jobs` queue: enqueue, claim, retry with backoff, idempotency key, resume after restart | db |
| `server/src/ai/transcribe.js` | Decrypt-stream a media file to a node's transcription endpoint; store transcript, segments, languages | crypto, nodes |
| `server/src/ai/embed.js` | Chunk text, request embeddings, store vectors with model id and dimension | nodes, db |
| `server/src/ai/retrieve.js` | Hybrid FTS5 + vector retrieval, always filtered through `VISIBLE` for the asking user | memories |
| `server/src/ai/answer.js` | Build the grounded prompt, call chat, validate citations, shape the answer per persona | retrieve, nodes |
| `server/src/routes/ai.js` | `POST /api/ask`, `GET /api/ask/history`, `DELETE /api/ask/:id`, `POST /api/ask/:id/report`, `POST /api/ask/:id/forward`, `POST /api/memories/:id/transcribe`, `GET /api/ai/status`, `POST /api/ai/backfill`. (A transcript is edited through the existing memory `PATCH`.) | the above |
| `server/src/migrations/` | Ordered idempotent schema migrations (`meta.schema_version`). Prerequisite for the tables below (Sprint 1.6) | db |
| `ai-node/` | Compose file and docs to run the desktop node (faster-whisper server, Ollama/llama.cpp, embedding model) | none |
| `server/ai-eval/` | Measurement harness run by the owner on real recordings | nodes |

Nodes expose **OpenAI-compatible HTTP** endpoints (`/v1/audio/transcriptions`, `/v1/embeddings`, `/v1/chat/completions`). That keeps models and runtimes swappable without vault code changes.

### 4.2 Data model additions

- `ai_jobs(id, kind transcribe|embed, memory_id, media_id, status pending|running|done|failed, attempts, next_run_at, last_error, idempotency_key UNIQUE, created_at)`.
- Transcript source and languages live on `memories` (`transcript_source ''|machine|human`, `transcript_languages` JSON; `memories.transcript` is the joined text). The per-file transcript text, segments (JSON with timestamps) and detected language live on `media` (`media.transcript`, `media.transcript_segments`, `media.transcript_language`).
- `chunks(id, memory_id, ord, text, model, dim, embedding BLOB, created_at)` (the language is not stored in v1). Vectors are stored as float32 (or int8-quantized if measurement shows memory pressure) and scanned in batches. Family scale (tens of thousands of memories) makes an approximate index unnecessary; this is to be **confirmed by measurement**, not assumed.
- `ask_log(id, user_id, question, answer, cited, outcome answered|no_record|reported, created_at)`: local, visible to its author, deletable.
- `prompts` gains `source` (`'ask'` for forwarded questions), `requested_by` and `addressed_to` (JSON list of user ids).

### 4.3 Configuration

`AI_NODES` (JSON array: name, url, capabilities, a model per capability, optional priority, `local` and token), `AI_ENABLED` (default false), `AI_MAX_CHUNK_TOKENS`, `AI_POLL_MS`. A node URL must be loopback, RFC1918, Tailscale (100.64.0.0/10, `*.ts.net`), IPv6 ULA, `localhost`, a single-label name, or a `.local/.lan/.internal/.home.arpa` name. The check is by name or IP only (no DNS lookup), so it is a guard against mistakes, not against a hostile name server. Otherwise the server refuses to start with a clear message. Every `embed` node must use the same model. Nothing is enabled by default.

## 5. Ask-the-archive behaviour

1. **Grounding.** Only retrieved chunks are given to the model. Every answer sentence carries one or more `[memory id]` citations. Validation rejects citations that were not retrieved and drops sentences with none. If nothing valid remains, the response is "I can't find that in the archive yet."
2. **Visibility.** Retrieval is a SQL query that joins `VISIBLE`. Q&A can never surface another member's private memory. Private memories are not embedded by remote nodes.
3. **Voice.** The archive answers as itself. It does not role-play or imitate a deceased relative. (Revisit only on explicit owner request.)
4. **Gaps feed the cycle.** A "no record" result offers "Ask an elder about this", which creates a prompt addressed to chosen members. This is the loop from descendants' questions to elders' next recordings.
5. **Persona-aware output.** Explorer: plain language, short quotes, play-from-timestamp. Archivist: adds sources, retrieval scores and transcript source (machine/human). Elder: not an Ask user in v1.
6. **Languages.** Reply in the asker's UI language. Show the original-language excerpt beside a translation labelled "machine translation".
7. **Report.** "Report this answer" writes `outcome=reported` for later review. Nothing leaves the NAS.

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| Node down or slow | Job stays `pending`, backoff retry; memory shows "transcript pending"; saving never blocks |
| Poor transcript | Marked `machine`; author/archivist can edit; edited text becomes `human` and re-runs never overwrite it |
| Hallucinated answer | Citation validation; "report this answer" |
| Private memory selected for a remote node | `nodes.js` refuses; the memory stays untranscribed (or uses the NAS fallback if it can do the job) |
| Node URL outside private ranges | Startup refusal |
| Re-embedding after model change | `chunks.model/dim` allow side-by-side; retrieval uses only the current model; a backfill job fills in the rest |

## 7. Security and rules impact

- **Rule 1 (no plaintext on disk):** kept. Decrypted audio is piped to the node over HTTP in memory. The node is configured not to persist uploads, and the desktop setup doc must say so; this is verified manually and written down, not assumed.
- **Rule 4 (no external network calls):** amended to permit calls to **configured private-network AI nodes** (and still the opt-in Claude call). The e2e assertion of zero external requests stays; the browser never talks to a node directly.
- **Rule 5 (private stays private):** extended to retrieval, embeddings and the choke point above.
- Transport: Tailscale (WireGuard) encrypts the NAS-to-desktop link. LAN-only plain HTTP to a node is allowed but logged as a warning.
- Update `SECURITY.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `SPEC.md` in the same change as the code.

## 8. Testing and measurement

- **Unit (no GPU, CI):** fake node with canned responses covers queue retry and idempotency, failover, private-memory choke point, URL-range validation, citation validation, and `VISIBLE` filtering in retrieval.
- **API/integration:** transcript edit flow, `ask` for two users where one has a private memory with a matching answer (must not leak), forward-to-elder creates a prompt.
- **E2E (extend `e2e/run.mjs`):** record → transcript appears → ask → cited answer → a second user cannot retrieve the first user's private memory.
- **Measurement harness (`ai-eval`)** on 5–10 of the owner's real recordings across the languages above: word/character error rate against hand-corrected transcripts, seconds of compute per audio-minute, peak VRAM and RAM. Model choices (Whisper size, embedding model, chat model) are made from these results. **No accuracy or speed claims go in docs until they have been measured.**

## 9. Open items to resolve during planning

1. Model shortlist per capability, decided from `ai-eval` results (not guessed here).
2. Embedding storage format (float32 vs int8) and scan strategy, decided from measured RAM under the 512 MB container limit.
3. Whether the NAS fallback node is a separate small container or in-process; start with "fallback does embeddings only".
4. Sprint 0 (first Docker build and TrueNAS run) runs in parallel; AI development targets the dev server first.

## 10. Later slices (not designed here)

Elder interviewer (adaptive follow-up questions) · persona capability coaching · local R&D signals feeding the backlog · family comments and reactions · speaker diarization.

## 11. Implementation notes (where the code differs from the draft above)

- Plain HTTP to a node is accepted without a logged warning; use Tailscale or HTTPS off the local machine (SECURITY.md).
- Persona only changes the style instruction given to the model. Retrieval scores, transcript source in the Ask answer and play-from-timestamp are not shown in the UI. Segments with timestamps are stored but not yet used.
- The reply language follows the browser's language; translation of quoted excerpts is requested in the prompt, not a separate step.
- A forwarded question becomes an ordinary family prompt. `prompts.addressed_to` stores the ids of every enabled member whose persona is `elder` (not chosen members), but the field is stored only and is not yet used for filtering: no screen or query reads it, so every member sees the prompt. Forwarding is idempotent per user and question.
- Dependency versions: `server/package.json` pins `better-sqlite3` at `^9.6.0`, which the Docker build on Node 20 uses. Development on Node 24 used `better-sqlite3` 12 installed locally with `--no-save` (9.6 has no Node 24 prebuild), so the test suite has not run against 9.6. In Sprint 0, run `npm test` inside `node:20-alpine` with 9.6, and consider bumping to `^12` once the Docker build has validated it.
- Privacy gate details: the privacy value must be exactly `family` or `private`; the question text is embedded on any embedding node (it is the asker's words); the asker's own private passages go to the chat model only if a `local: true` chat node exists.
- No NAS-local fallback node ships with this slice; the `local: true` flag and its tests exist so one can be added after `ai-eval` shows what the NAS can run.
- Jobs: a failure backs off 1 min doubling, `failed` after 6 attempts; an unreachable node defers a job without using an attempt; a node that is not allowed skips it. There is no resumable per-job progress, so a transcription restarts from the beginning.
