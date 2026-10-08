# Desktop AI node

The machine with the GPU runs the heavy models; the NAS only sends it work over your private network.
Family (non-private) memories are sent in memory and must not be stored on the node. Private memories are only ever sent to a node marked `"local": true`. That flag is meant for a model running on the NAS itself. The desktop node in this guide is not on the NAS, so do NOT mark it `local`.

## Requirements
- Docker with NVIDIA GPU support (Docker Desktop + WSL2 on Windows, or the NVIDIA container toolkit on Linux)
- Tailscale on both the desktop and the NAS (or a trusted LAN)

## Steps
1. `cp .env.example .env`. Set `NODE_BIND` to the desktop's Tailscale IP (`tailscale ip -4`).
2. Choose a Whisper server. It must expose `POST /v1/audio/transcriptions` with `response_format=verbose_json`.
   A candidate to evaluate is the project formerly called faster-whisper-server (now Speaches). Look up its current image name
   and tag on its own page, run `docker pull` on it, and put the result in `WHISPER_IMAGE`. Do not guess the tag.
3. `docker compose up -d`, then pull models into Ollama, for example `docker exec memento-ollama ollama pull <embedding-model>`
   and `... ollama pull <chat-model>`. Choose models with `server/ai-eval` and note them in `docs/KNOWLEDGE_BASE.md`.
   Use ONE embedding model everywhere: vectors from different models cannot be compared.
4. Verify the node does not keep what it is sent. Do this for BOTH containers, `memento-whisper` and `memento-ollama`, because
   Ollama receives family transcript and chat text too. Send one test recording through Whisper and one test chat or embedding
   request through Ollama, then check:
   - (a) A clean `docker diff <container>` is NOT proof. It does not show writes to mounted volumes (this compose file mounts
     model-cache volumes), files that were written and then deleted before you ran it, or log output.
   - (b) Check the mounted volumes for new files. Compose prefixes volume names with the project name, so run `docker volume ls`
     to find them. Immediately before the test request (and after any model pulls), create a marker file on the host. Then, adapting
     the names to your system:

         docker run --rm -v <volume>:/v -v <marker-file>:/marker:ro alpine find /v -type f -newer /marker

     Any file listed was written after the marker. Find out what it is. An empty result covers only the test you ran.
   - (c) Read `docker logs <container>` for request bodies, transcripts, prompts or answers.
   - (d) Read each server's own documentation and settings for storing uploads, request logging and history, and switch them off.
     If a server stores uploads and you cannot turn that off, pick another server.
   - (e) Record what you found, and anything you could not verify, in `docs/KNOWLEDGE_BASE.md`.

   This is an operator responsibility. The Memento server cannot enforce what a node does with the data it receives. It can check
   that a node URL is on a private network, and it sends private memories only to `local` nodes.
5. On the NAS, set in `.env`:

       AI_ENABLED=true
       AI_NODES=[{"name":"desktop","url":"http://<desktop-tailscale-ip>:8000","capabilities":["transcribe"],"models":{"transcribe":"<whisper-model>"},"priority":10},{"name":"desktop-llm","url":"http://<desktop-tailscale-ip>:11434","capabilities":["embed","chat"],"models":{"embed":"<embedding-model>","chat":"<chat-model>"},"priority":10}]

   Model names are whatever the node reports; the server refuses URLs that are not on a private network.
6. Restart Memento. `GET /api/ai/status` (owner) shows each node as healthy or not.

## Notes
- **`WHISPER_IMAGE` is needed for every compose command.** `docker compose up` fails without it, even if you only want Ollama,
  because compose reads the variable for the whole file (`docker compose config` shows the error). Set it, then start only
  Ollama with `docker compose up -d ollama`.
- **AI_NODES URLs must NOT include `/v1`.** Use `http://<ip>:<port>`. The server appends `/v1/...` itself.
- **A Tailscale `NODE_BIND` needs that interface up when the container starts.** If Tailscale is not up yet, the port cannot bind.
  With `restart: unless-stopped`, Docker keeps retrying, so the node comes up once Tailscale does.
- **`--token` on a command line is visible to other local users.** Process listings show it. Use a throwaway token for `ai-eval`
  runs, never your real node token.

## When the desktop is off
Jobs wait and retry; recordings still save; the memory shows "transcript on its way". Ask-the-archive falls back to keyword
search only and says so.
