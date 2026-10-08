# ai-eval: measure before you choose

Run this on the machine that will host the AI node, with 5-10 of your own recordings (different languages, mixed-language
stories, phone and studio audio). Put the hand-corrected transcript beside each file (`story1.m4a` + `story1.txt`).

    cd server
    node ai-eval/run.js --node http://127.0.0.1:8000 --model <whisper-model-name> --dir /path/to/recordings --out whisper-<model>.md

Try each candidate model and keep the result files. Pick the smallest model whose WER you can live with for the languages
your family actually speaks; record the choice and the numbers in `docs/KNOWLEDGE_BASE.md`. Do not copy numbers from anywhere
else into the docs.

Needs `ffprobe` (ships with ffmpeg) for audio length and `nvidia-smi` for GPU memory; both are optional and show `n/a` when missing.
WER and CER show `n/a` for files that have no `.txt` beside them. Scoring ignores case and punctuation but keeps vowel signs
and other combining marks, so a missing mark in Gurmukhi or Devanagari counts as an error.

The script exits 0 when at least one file was transcribed, 1 when every file failed, and 2 when the arguments or the folder
are wrong.

For the embedding and chat models, use the runtime's own timing output (for example `ollama run <model> --verbose`) and note it
in the same knowledge-base entry.
