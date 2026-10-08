# Memento: NAS Edition (v2.0)

A private, encrypted vault for your family's stories, voices, photos and documents. It runs on **your** NAS in a single Docker container. Nothing is sent to the cloud unless you explicitly ask for it.

- **Record or write** stories (prompted by 149 built-in questions, or your own)
- **Upload** photos, scans, video, audio and documents. Every file is encrypted before it touches the disk
- **Browse** by timeline, person, tag, or full-text search; spot the decades with no stories yet
- **Share with family** using separate accounts (owner / contributor / view-only) and three simple layouts (elder, archivist, explorer)
- **Private by default option:** mark any memory *private* and even the vault owner can't see it
- **Take it with you:** one-click zip export of everything

Stack: Node 20, Express, SQLite (WAL + FTS5), React 18. Runs in about 150 MB RAM.

---

## 1. Install on your NAS

You need Docker (Synology *Container Manager*, QNAP *Container Station*, or plain Docker) and SSH or a terminal.

```bash
git clone https://github.com/punjabitaz-ctrl/memento-nas.git
cd memento-nas

sh generate-key.sh          # writes .env with a fresh MEMENTO_KEY + SESSION_SECRET
nano .env                   # set MEMENTO_DATA, PUID, PGID (see below)

mkdir -p /volume1/docker/memento        # whatever you set as MEMENTO_DATA
docker compose up -d --build
```

Open `http://<nas-ip>:3002`. The first visit shows the owner setup screen.

### Settings that matter on a NAS

| `.env` setting | What to put |
|---|---|
| `MEMENTO_DATA` | Folder for all data. Synology `/volume1/docker/memento`, QNAP `/share/Container/memento` |
| `PUID` / `PGID` | Numeric owner of that folder (`ls -ln /volume1/docker`). Often `1026:100` on Synology. Wrong values give a "permission denied" error in the logs |
| `HOST_PORT` | Change if 3002 is taken |
| `MAX_FILE_SIZE_MB` | Per-file upload limit (default 500) |
| `TRUST_PROXY` | `true` when behind a reverse proxy |
| `ANTHROPIC_API_KEY` | Optional, see "Claude" below |

The container refuses to start with a clear message if the key is a placeholder, malformed, or **different from the key the vault was created with** (so a typo can't silently lock you out).

### TrueNAS (the reference target for this project)

Short version; the working, tested steps are tracked in `docs/SPRINTS.md` (Sprint 0) and `docs/KNOWLEDGE_BASE.md` §4.

1. Create a dataset such as `<pool>/apps/memento` (Apps preset, **no ACL**) and make it owned by the user the container runs as (TrueNAS's generic apps user is `568`).
2. In `.env`: `MEMENTO_DATA=/mnt/<pool>/apps/memento`, `PUID=568`, `PGID=568`.
3. Build or pull the image, then run via `docker compose` over SSH, or paste a compose without `build:` into Apps → Install via YAML.
4. For HTTPS (needed for voice recording), use Tailscale (`tailscale serve`).

### Voice recording needs HTTPS

Browsers only allow microphone access on `https://` or `localhost`. On plain `http://<nas-ip>:3002` the Record page tells people so and offers upload instead. To enable it, put Memento behind HTTPS and set `TRUST_PROXY=true`:

- **Synology:** Control Panel → Login Portal → Advanced → Reverse Proxy → `https://memento.<your-ddns>` → `http://localhost:3002`
- **Tailscale:** `tailscale serve --bg 3002` gives you a private `https://<nas>.<tailnet>.ts.net`
- **Nginx Proxy Manager / Traefik:** `docker-compose.traefik.yml` is included; set `MEMENTO_DOMAIN` and `TRUST_PROXY=true`

Don't forward port 3002 straight to the internet. Use a VPN (Tailscale / WireGuard) or an HTTPS reverse proxy.

---

## 2. Back it up (important)

Back up **both**, together:

1. The `MEMENTO_DATA` folder (`db/`, `vault/`; `sessions/` and `tmp/` are optional)
2. Your **`MEMENTO_KEY`**, stored *separately* from the NAS (password manager + a printed copy)

Without the key the vault is unreadable by design. Without the folder there is nothing to decrypt. A backup of the folder is safe to keep on an external drive or cloud storage because the files are encrypted. Note that the SQLite database (titles, dates, tags, people names, story text) is **not** encrypted; see SECURITY.md.

Take the owner's **Export** (Help & backup page) occasionally as well. It produces a plain zip of everything you can see, readable without Memento.

## 3. Everyday operations

```bash
docker compose logs -f memento              # logs
git pull && docker compose up -d --build   # update
docker exec -it memento node scripts/reset-password.js --list
docker exec -it memento node scripts/reset-password.js <login> 'new long password'
```

Family members are created by the owner on the **Family** page (no email needed). The last owner can't be removed or demoted.

## 4. Claude (optional)

With no `ANTHROPIC_API_KEY`, the "Tidy up" button uses a built-in offline organizer to suggest tags, people, a date and a summary, and "Tell the story" builds a narrative from stored text, all on your NAS.

If you set a key, each memory gets an **"Ask Claude"** checkbox. Only the text of that one memory is sent, only when ticked, and never files. Claude never sees audio; to get transcripts, see the next section.

## 5. Local AI (optional)

Off by default. If you run AI models on a machine you own (for example a desktop with a GPU), Memento can:

- **transcribe voice stories**, so people can search for what was said (a transcript someone has typed or corrected is never overwritten), and
- let family members **ask the archive** questions and get short answers that cite the stories they came from. If the archive has no record, the question can be sent to an elder as a new prompt.

Privacy in short: Memento only talks to the nodes you list in `AI_NODES`, and refuses to start if one is not on your own network (loopback, LAN or Tailscale). Family memories are sent to those machines; *private* memories are never sent to a node unless you flag it `local: true` (a model running on the NAS itself). What a node stores or logs is up to the software on it, so check it. Details: `SECURITY.md`.

How to set it up: `ai-node/README.md` (desktop node kit) and the `AI_*` variables in `.env.example`. Choose models by measuring them on your own recordings with `server/ai-eval`. So far this has only been tested against a fake node, not a real model.

## 6. What's inside

```
server/   Express API, AES-256-GCM vault, SQLite, local AI layer, tests (npm test)
client/   React app (Vite); built into client/dist and served by the server
ai-node/  Optional kit for running the AI models on another machine
e2e/      Browser tests (Playwright): run.mjs (whole app), ai.mjs (transcripts + Ask)
Dockerfile, docker-compose.yml, docker-compose.traefik.yml, .env.example, generate-key.sh
```

Development: `cd server && npm i && npm test`; `cd client && npm i && npm run dev` (proxies to a server on :3002).

## 7. Known limits

- Voice recordings are only transcribed if you set up local AI (section 5); accuracy per language is not yet measured, and recordings that mix languages are expected to be weaker
- Answers from "Ask the archive" can still misread a story; check the cited memories
- No comments/reactions or book printing yet
- Thumbnails aren't generated, so large photos load at full size; HEIC/RAW won't preview in browsers (downloads work)
- Tested on x86-64; the Dockerfile targets arm64 too but that build is untested
- Memory/search metadata is not encrypted at rest (full-disk encryption on the NAS volume is recommended)
