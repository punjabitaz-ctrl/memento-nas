# Memento — Security Architecture

## Encryption

All media files and documents are encrypted **before** being written to disk using **AES-256-GCM** — the same algorithm used by Signal, WhatsApp, and TLS 1.3.

### How it works

```
Upload flow:
  Browser → [HTTPS/LAN] → Server (RAM only) → AES-256-GCM encrypt → /data/vault/<uuid>.enc

Serve flow:
  Browser ← [HTTPS/LAN] ← Server (streams decrypt) ← /data/vault/<uuid>.enc
```

- The plaintext file **never touches disk** except the one-time write during upload (temp file → encrypt → delete temp)
- Media is decrypted **in memory (streaming)** directly to the HTTP response — no cleartext is written to disk when viewing
- Each file gets a **random 96-bit IV** (initialization vector), so two identical files produce different ciphertext
- A **128-bit GCM authentication tag** appended to each file detects any tampering or corruption

### Encrypted format

```
[ 12 bytes IV ] [ encrypted content ] [ 16 bytes GCM auth tag ]
```

### Your key (`MEMENTO_KEY`)

- 256-bit AES key stored as a 64-character hex string
- Loaded from the `MEMENTO_KEY` environment variable — **never stored in the database**
- The database contains **only encrypted file paths** (like `abc123.enc`) — not the key
- If someone steals your NAS hard drive or Docker volumes, they get nothing without the key

---

## Authentication

- Session-based auth with bcrypt password hashing (cost factor 12)
- Sessions stored in a separate SQLite database; persisted across container restarts
- Session cookies: `HttpOnly`, `SameSite=Lax`, 30-day expiry
- Set `TRUST_PROXY=true` + a proper reverse proxy for `Secure` cookies over HTTPS
- One vault = one account (family vault model); no multi-tenancy in v1

---

## Data Stays Local

**By default, no data leaves your machine.** AI organizing runs via local heuristics.

If you set `ANTHROPIC_API_KEY`:
- Only the **single item being added** is sent to Anthropic (title, note, filename, and optionally a ≤2MB image crop)
- No bulk batch processing, no background scanning of your vault
- The AI call is opt-in per deployment, not per item

---

## What's NOT encrypted

The **database** (`memento.sqlite`) stores metadata: titles, notes, dates, people, tags, summaries. This metadata is **not encrypted at rest** in v2.0. A future version may add field-level metadata encryption.

For maximum protection, place the Docker volume on an encrypted NAS volume (Synology SHR with encryption, VeraCrypt, LUKS, etc.).

---

## Key Management

```
MEMENTO_KEY is your vault.
Lose the key = lose access to every file. Forever.
```

Recommended backup strategy:
1. Print the key and store in a fireproof safe
2. Add to a reputable password manager (1Password, Bitwarden)
3. Write on a physical medium stored in a different physical location
4. Consider a sealed envelope with a trusted person for estate purposes

**Do NOT** store the key in the same Docker volume as your vault.

---

## Threat Model

| Threat | Protected? | Notes |
|---|---|---|
| NAS drive theft | ✅ Yes | AES-256-GCM encrypted vault |
| Docker volume snapshot | ✅ Yes | Without MEMENTO_KEY, files are unreadable |
| Database file access | ⚠️ Partial | Metadata (titles, notes) not encrypted |
| Network eavesdropping (LAN) | ⚠️ Use HTTPS | Enable reverse proxy + TLS for remote access |
| Compromised container | ❌ No | Key is in env; if container is compromised, key is exposed |
| Weak password | ❌ No | Use a strong password; bcrypt slows brute force |
| Lost key | ❌ No | Vault is permanently unreadable |

---

## Reporting Issues

This is a personal/family use project. Security concerns: open a GitHub issue marked `[security]`.
