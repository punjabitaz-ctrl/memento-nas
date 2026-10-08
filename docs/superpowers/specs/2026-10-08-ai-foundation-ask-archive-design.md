# Design: AI foundation + "Ask the archive"

Status: draft for review · Date: 2026-10-08 · Scope: first AI slice of Memento NAS

## 1. Purpose

Memento is a self-hosted, encrypted family vault serving three generations: elders who found the archive, middle-generation archivists who run it, and younger relatives who ask who they are and where they come from. Their questions should become the elders' next prompts, which keeps the archive growing.

This slice adds local AI so that voice stories become searchable text, and a descendant can ask the archive a question and get an answer grounded in, and cited to, real memories.

## 2. Decisions already made (with the owner)

| Decision | Choice |
|---|---|
| Where AI runs | **Hybrid**: desktop GPU node (RTX 5070 12 GB, over Tailscale) as primary; NAS (N150, CPU) as fallback for small jobs |
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
| `server/src/routes/ai.js` | `POST /api/ask`, `POST /api/memories/:id/transcribe`, `PATCH` transcript, `GET /api/ai/status`, `POST /api/ask/:id/report`, `POST /api/ask/:id/forward` | the above |
| `server/migrations/` | Ordered idempotent schema migrations (`meta.schema_version`). Prerequisite for the tables below (Sprint 1.6) | db |
| `ai-node/` | Compose file and docs to run the desktop node (faster-whisper server, Ollama/llama.cpp, embedding model) | none |
| `server/ai-eval/` | Measurement harness run by the owner on real recordings | nodes |

Nodes expose **OpenAI-compatible HTTP** endpoints (`/v1/audio/transcriptions`, `/v1/embeddings`, `/v1/chat/completions`). That keeps models and runtimes swappable without vault code changes.

### 4.2 Data model additions

- `ai_jobs(id, kind transcribe|embed, memory_id, media_id, status pending|running|done|failed, attempts, next_run_at, last_error, idempotency_key UNIQUE, created_at)`.
- `memories.transcript` (exists) plus `transcript_source machine|human`, `transcript_languages` (JSON), `transcript_segments` (JSON with timestamps).
- `chunks(id, memory_id, ord, text, lang, model, dim, embedding BLOB)`. Vectors are stored as float32 (or int8-quantized if measurement shows memory pressure) and scanned in batches. Family scale (tens of thousands of memories) makes an approximate index unnecessary; this is to be **confirmed by measurement**, not assumed.
- `ask_log(id, user_id, question, answer, cited_memory_ids, outcome answered|no_record|reported, created_at)`: local, visible to its author, deletable.
- `prompts` gains a `requested_by` and `source ask` marker for forwarded questions.

### 4.3 Configuration

`AI_NODES` (JSON or env list: url, capabilities, priority, optional token), `AI_ENABLED` (default false), `AI_MAX_CHUNK_TOKENS`. A node URL must resolve to a loopback, RFC1918 or Tailscale (100.64.0.0/10) address. Otherwise the server refuses to start with a clear message. Nothing is enabled by default.

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
