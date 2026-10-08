# Security model: Memento NAS Edition v2.0

## What is protected

| Data | At rest | Notes |
|---|---|---|
| Uploaded files and recordings | **AES-256-GCM encrypted** | One `.enc` file per upload in `vault/` |
| Titles, descriptions, story text, dates, tags, people | **Not encrypted** | SQLite (`db/memento.sqlite`) so it can be searched. Use NAS volume encryption to cover it |
| Passwords | bcrypt (cost 12) | Never stored or logged in plain text |
| Sessions | Server-side, separate `sessions.sqlite` | Cookie `memento.sid`: httpOnly, SameSite=Lax, Secure when served over HTTPS |

## Vault file format ("MEM2")

- 4-byte magic + 16-byte random salt, then 64 KiB chunks, each with its own 16-byte GCM tag
- Per-file key = HKDF-SHA256(`MEMENTO_KEY`, salt, "memento-file-v2")
- Nonce = chunk counter; AAD = final-chunk flag + record id. This detects tampering, truncation, reordering and swapping one file for another
- Files stream through encryption: plaintext is **never written to disk** (upload → encrypt → `.part` → rename). Memory use stays flat regardless of file size
- Playback decrypts and verifies on the fly, including HTTP Range requests (seeking video/audio). An integrity failure aborts the response rather than serving bad data

## Key handling

- `MEMENTO_KEY` (64 hex chars) lives only in your `.env`; it is never stored in the database
- A key check value is stored in the database; the server refuses to start with a different key
- The server refuses placeholder or malformed keys and short session secrets
- **Losing the key means permanent data loss.** There is no recovery

## Access control

- Roles: **owner** (everything, manages family), **contributor** (add/edit own), **viewer** (read only)
- A memory is `family` (all members) or `private` (only its author, not even the owner)
- Owners cannot demote or remove the last owner. Disabled members are signed out immediately
- Login rate-limited (10 attempts / 15 min); response time is equalised for unknown users
- Password reset is done from the NAS shell (`scripts/reset-password.js`), i.e. requires physical/SSH admin access

## Web hardening

- CSRF: every state-changing request needs `X-Requested-With: memento` and a same-origin `Origin`
- Helmet CSP (self only; no third-party scripts, fonts, analytics or CDNs; fonts are bundled)
- Uploaded media is served with `nosniff` and `Content-Security-Policy: sandbox`; SVG uploads are rejected
- Container runs as a non-root user; request logs record method and path only

## Network

Memento speaks plain HTTP on port 3002 and expects you to terminate TLS in a reverse proxy or VPN if you need access beyond your LAN. Don't expose it directly to the internet. HSTS is left to the proxy.

## Optional cloud (Claude)

Disabled unless `ANTHROPIC_API_KEY` is set, and then used only when a user ticks "Ask Claude" on a specific memory. Only that memory's text is sent. Files and audio are never sent.

## Local AI nodes (optional)

Off unless `AI_ENABLED=true`. When on, Memento sends work to AI servers **you run** (typically a desktop with a GPU on your Tailscale network), and only to the nodes listed in `AI_NODES`. The browser never talks to a node.

- **What is sent to a node:** decrypted audio/video of *family* memories (for transcription); the text of family memories (title, description, story, transcript, plus the contributor's name, tagged people and date as a header) for embeddings; the asker's question (for embedding) and the matching passages (for the answer).
- **The question goes to the embedding node, whichever node that is.** It is the asker's own words, not a memory, so it is not held back from a remote node even when the answer might involve a private memory.
- **What is never sent to a remote node:** anything from a *private* memory. Private work only runs on a node you flag `local: true` (one running on the NAS itself). The only gate is `NodeRegistry.eligible` in `server/src/ai/nodes.js`; it fails closed (the privacy value must be exactly `family` or `private`, anything else is an error). If no local node exists, a private memory is simply not transcribed or embedded. Privacy is re-read from the database before every node attempt (including a failover to the next node), so a memory made private while a job runs is not sent on to a remote node. During a transcription upload to a remote node it is also re-read about every 4 MiB, and the upload is aborted (the job ends as skipped, nothing from that node is stored) once the memory is private. **Limitation:** audio already sent before the change (up to about 4 MiB plus network buffers) cannot be recalled.
- **Private memories and Ask:** the asker's own private memories can still match by keyword. Their passages are given to the chat model only if a `local: true` chat node exists; otherwise they are left out and the Ask page tells the asker that some private stories matched but were not used. Other people's private memories are never retrieved.
- **Where nodes may be:** loopback, RFC1918 ranges, Tailscale (`100.64.0.0/10`, `*.ts.net`), IPv6 loopback/ULA, `localhost`, a single-label name (such as a Docker service name), or a `.local/.lan/.internal/.home.arpa` name. Any other `AI_NODES` URL stops the server from starting. **This check is by name only: Memento does not resolve DNS, at startup or later.** A name you list that resolves to a public address, or is changed to one afterwards, would not be caught, so only list names you control. The node client does not follow redirects.
- **At rest:** the NAS still writes no plaintext audio to disk (decrypted audio is streamed to the node from memory). Whether a *node* keeps what it receives (uploads, logs, chat history) depends on the software you run there. Memento cannot check that; verify it (see `ai-node/README.md`) and record the result.
- **In transit:** use Tailscale (WireGuard) or HTTPS for any node that is not on the same machine. Plain HTTP is accepted, including over a LAN, so a node's token and your family's data are readable by anyone who can watch that network.
- **Node tokens:** a node's optional `token` lives in `AI_NODES` in your `.env`, is sent as a bearer token and is never logged. A token with control characters (such as a line break) and a node URL with a user name or password are refused at startup. Keep `.env` out of git.
- **What stays unencrypted in SQLite:** transcripts, text chunks, embedding vectors and the question/answer history (`ask_log`), like all other metadata. Vectors can leak some information about the text. Dataset-level encryption on the NAS covers all of it.
- **Answers:** produced only from retrieved passages the asker may see. Every sentence must carry a citation to one of those passages or it is dropped. A model can still misread or over-state a source, and a family memory written by someone else can say something wrong. Treat answers as pointers to the stories, and use "This looks wrong" to flag them.
- **Prompt injection:** memory text is passed to the model as data, inside a delimited block of the user message, with an instruction to ignore instructions in it; characters that could close the block or imitate a source label are neutralised. This reduces but does not eliminate the risk. The model has no tools and sees nothing the asker could not already read, so the realistic worst case is a wrong or misleading answer.
- **History and forwarding:** each person's questions and answers are stored in `ask_log`; each person sees and can delete only their own (the owner has no special access). Sending an unanswered question "to the family" turns its text into a prompt that other members can see.
- **Abuse limits:** questions are limited to 20 per minute per user and 500 characters per request. Node errors in server logs carry only the node name and an HTTP status or error code, never URLs, tokens, response bodies or memory text; Ask never shows node error text to the asker. A node must accept the connection within 8 seconds and may send at most 32 MiB in one response.
- **Who can trigger work:** a memory's author (or the owner, for family memories) can ask for it to be re-transcribed; only the owner can see node URLs and the job queue, or queue a backfill.

## Exports

The zip export is **unencrypted** by design (so your family can read it without Memento). It excludes other people's private memories. Store it accordingly.

## Not covered

- An attacker with both the NAS disk and your `.env` can decrypt everything
- A node that stores or logs what it receives (see above), or a network path to it that you do not trust
- Anyone who can read the SQLite file can read titles and text
- No audit log, 2FA or email-based recovery

## Reporting issues

Open a GitHub issue (no secrets or personal data) or contact the maintainer directly for anything sensitive.
