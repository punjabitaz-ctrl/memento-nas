# Desktop AI node

The machine with the GPU runs the heavy models; the NAS only sends it work over your private network.
Family (non-private) memories are sent in memory and must not be stored on the node. Private memories are never sent.

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
4. Verify the node does not keep what it is sent: transcribe one test recording through it, then run
   `docker diff memento-whisper` and look for new audio files, and check the server's settings for any "save uploads" option.
   Record what you found in the knowledge base. If the server stores uploads, turn that off or pick another server.
5. On the NAS, set in `.env`:

       AI_ENABLED=true
       AI_NODES=[{"name":"desktop","url":"http://<desktop-tailscale-ip>:8000","capabilities":["transcribe"],"models":{"transcribe":"<whisper-model>"},"priority":10},{"name":"desktop-llm","url":"http://<desktop-tailscale-ip>:11434","capabilities":["embed","chat"],"models":{"embed":"<embedding-model>","chat":"<chat-model>"},"priority":10}]

   Model names are whatever the node reports; the server refuses URLs that are not on a private network.
6. Restart Memento. `GET /api/ai/status` (owner) shows each node as healthy or not.

## When the desktop is off
Jobs wait and retry; recordings still save; the memory shows "transcript on its way". Ask-the-archive falls back to keyword
search only and says so.
