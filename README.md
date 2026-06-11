# Memento v2.0 — NAS Edition

> A privacy-first AI memory vault. Self-hosted on your NAS. Your family's lifetime of photos, audio, documents, and stories — encrypted, searchable, narratable, always owned by you.

---

## What it does

- **Ingest** photos, videos, audio, documents, and written notes
- **Encrypt** every file at rest with AES-256-GCM using your key
- **Auto-organize** with AI tags, summaries, people, and date detection (offline heuristics by default; Claude API optional)
- **Timeline** — browse memories grouped by year
- **Search** — full-text across titles, notes, tags, people, places, and AI summaries
- **Narrate** — type a name or year, get a short story woven from your memories
- **Export** — one click produces a plain zip of all decrypted files for estate handover

---

## Requirements

- Docker + Docker Compose (v2+)
- NAS with at least **256MB RAM free** (512MB recommended)
- **ARM64** (Synology ARM, QNAP, RPi) or **AMD64** (Intel/AMD) — both supported

---

## Quickstart (5 minutes)

### 1. Generate your encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Outputs something like: a3f8c12e...
```

Or, if Node isn't on your machine, use the NAS terminal / Docker exec into any node container.

> ⚠️ **This key is your vault.** Back it up in a password manager, a printed paper in a safe, or a USB drive kept separately. Losing it makes every file permanently unreadable.

### 2. Configure

```bash
cp .env.example .env
nano .env
```

At minimum, set:
```
MEMENTO_KEY=<your 64-char hex key>
SESSION_SECRET=<another random hex string>
HOST_PORT=3002
```

### 3. Deploy

```bash
docker compose up -d --build
```

The first build takes 3–8 minutes (compiles native SQLite bindings for your architecture).
Subsequent restarts take 5 seconds.

### 4. Open

```
http://<your-nas-ip>:3002
```

On first visit, you'll be prompted to create your account. After that, login is required.

---

## NAS-specific instructions

### Synology DSM (Container Manager)

1. Open **Container Manager** → **Project** → **Create**
2. Choose **Create from YAML**, paste the contents of `docker-compose.yml`
3. Or use the file upload: place the entire `memento/` folder in a shared folder, then set the path
4. Set your `.env` values in the environment section of the wizard

Alternatively, SSH into your NAS and run:
```bash
cd /volume1/docker/memento
docker compose up -d --build
```

### QNAP Container Station

1. SSH to your QNAP or use Container Station → **Create** → **Upload Docker Compose**
2. Place the project folder in `/share/CACHEDEV1_DATA/Container/memento/`
3. `docker compose up -d --build`

### Unraid

1. Install the **Docker Compose Manager** plugin
2. Create a new compose project, paste `docker-compose.yml`
3. Set variables in the compose template

### Reverse proxy (Nginx Proxy Manager / Synology's built-in proxy)

Set in `.env`:
```
TRUST_PROXY=true
```

Then configure your reverse proxy to point to `http://localhost:3002`.

For **Traefik**, use `docker-compose.traefik.yml` instead:
```bash
docker compose -f docker-compose.traefik.yml up -d --build
```

---

## Backup strategy

Memento uses three named Docker volumes:

| Volume | Contents | Include in backup |
|---|---|---|
| `memento-vault` | AES-256 encrypted media files | ✅ Yes |
| `memento-db` | SQLite database (metadata) | ✅ Yes |
| `memento-sessions` | Login sessions | Optional |

**On Synology:** Use **Hyper Backup** → Backup Docker volumes `memento-vault` and `memento-db`.

**With rsync:**
```bash
# Find volume paths
docker volume inspect memento-vault --format '{{ .Mountpoint }}'
docker volume inspect memento-db --format '{{ .Mountpoint }}'

# Rsync to external location
rsync -av /var/lib/docker/volumes/memento-vault/ /backup/memento-vault/
rsync -av /var/lib/docker/volumes/memento-db/   /backup/memento-db/
```

> ⚠️ Back up your `MEMENTO_KEY` separately from the vault files. A backup of both without the key is worthless.

---

## Updates

```bash
cd /path/to/memento
git pull  # or download new release
docker compose up -d --build
```

Data volumes are preserved across updates. The build step recompiles if needed.

---

## Enable AI (optional)

By default, Memento runs fully offline — no data leaves your machine.

To enable richer AI summaries and photo understanding:

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com)
2. Add to `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   MEMENTO_AI_MODEL=claude-haiku-4-5-20251001
   ```
3. Restart: `docker compose up -d`

Only the item being added is sent per request. No bulk processing, no background calls.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20 · Express 4 · better-sqlite3 9 |
| Encryption | AES-256-GCM (Node crypto, streaming) |
| Sessions | express-session + connect-sqlite3 |
| Frontend | React 18 · React Router 6 · Vite 5 |
| Container | Alpine Linux · tini (PID 1) |
| Database | SQLite (WAL mode) + FTS5 full-text search |

---

## Troubleshooting

**Build fails on ARM64 (native module error)**
The Dockerfile installs `python3 make g++` for native compilation. If it still fails, try:
```bash
docker compose build --no-cache
```

**Port already in use**
Change `HOST_PORT` in `.env` and restart.

**Forgot password**
SSH to your NAS, exec into the container, and reset:
```bash
docker exec -it memento sh
# Inside container:
node -e "
  const db = require('better-sqlite3')('/data/db/memento.sqlite');
  const bcrypt = require('bcryptjs');
  const hash = bcrypt.hashSync('newpassword', 12);
  db.prepare('UPDATE users SET password_hash = ?').run(hash);
  console.log('Password reset to: newpassword');
"
```

**Check logs**
```bash
docker compose logs -f memento
```

**Health check**
```bash
curl http://localhost:3002/health
# {"status":"ok","version":"2.0.0","time":"..."}
```

---

## Privacy model

| Concern | How Memento handles it |
|---|---|
| Data location | Runs on hardware you control. No cloud dependency. |
| Encryption at rest | Every file encrypted with AES-256-GCM. Database stores metadata only. |
| AI mode | Offline by default. Claude API is opt-in, per-item, never bulk. |
| Authentication | Session-based login. No anonymous access. |
| Export | One-click full decrypted zip. Your data is never held hostage. |

---

*Memento v2.0 — built for one family, designed to last.*
