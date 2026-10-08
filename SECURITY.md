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

## Exports

The zip export is **unencrypted** by design (so your family can read it without Memento). It excludes other people's private memories. Store it accordingly.

## Not covered

- An attacker with both the NAS disk and your `.env` can decrypt everything
- Anyone who can read the SQLite file can read titles and text
- No audit log, 2FA or email-based recovery

## Reporting issues

Open a GitHub issue (no secrets or personal data) or contact the maintainer directly for anything sensitive.
