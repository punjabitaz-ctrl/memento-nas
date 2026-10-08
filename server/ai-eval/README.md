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

## Reading the numbers
- **WER is misleading for languages written without spaces between words** (for example Chinese, Japanese or Thai). WER splits on
  spaces, so a whole unspaced transcript counts as one word and the score says little. Rely on CER for those languages.
- **Compute time is wall-clock.** It includes the upload and any cold model load on the server. Run the set twice and keep the
  second run, or discard the first file as warm-up, before you compare models.
- **"Peak GPU MiB" is the memory in use on the whole GPU**, including other programs (for example a model that is already loaded),
  sampled every 500 ms. It is an upper bound for this run, not the memory this run added, and a sample can miss a short spike.
  Files shorter than the sampling interval usually show `n/a` even when `nvidia-smi` is installed.
- **An empty reference `.txt` scores WER 1.00 if the model produced any text** (CER behaves the same way). Check that no reference
  file is empty before you trust the numbers.
- **CER is slow on very long transcripts**, because the edit distance cost grows with the product of the two text lengths. That is
  fine for story-length recordings.

For the embedding and chat models, use the runtime's own timing output (for example `ollama run <model> --verbose`) and note it
in the same knowledge-base entry.
