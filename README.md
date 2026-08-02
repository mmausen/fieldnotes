# Speaker-attributed live transcription on a tldraw canvas

Live speaker-labelled transcript from your mic or system audio, rendered onto a local
[tldraw](https://tldraw.dev) whiteboard as text shapes you can move, edit, recolour and
connect with arrows.

Runs entirely locally on [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
(ggml, Metal-accelerated on Apple Silicon) — no cloud, no Python ML stack, no data leaves
the machine.

```
S1  Good morning. I wanted to go over the quarterly numbers with you today.
S2  Sure, let's start with the revenue figures from the second quarter.
S1  Revenue was up 11%, mostly from the new subscription tier.
S2  That is better than we forecast. What about customer churn?     <- grey, still settling
```

| | |
|---|---|
| ASR | `multitalker-parakeet-streaming-0.6b-v1` (Q8_0, 734 MB) — 2.18% WER, ~43× realtime |
| Diarization | `diar_streaming_sortformer_4spk-v2.1` (F32, 449 MB) — up to 4 speakers, ~150× realtime |
| Canvas | tldraw 5.x, React 19, Vite |
| Verified on | Apple M3 Max, macOS 26.5.2, Metal (upstream also verified on M4 Max) |

---

## Contents

- [Quick start](#quick-start) · [Requirements](#requirements) · [Running](#running)
- [Audio sources](#audio-sources)
- [How it works](#how-it-works) — [the two-model split](#the-two-model-split),
  [timestamps](#getting-timestamps-out-of-the-stream),
  [turn metadata](#turn-metadata-id-and-final),
  [the canvas](#why-the-canvas-is-append-only),
  [two non-obvious things](#two-non-obvious-things)
- [Configuration](#configuration) · [Swapping the ASR model](#swapping-the-asr-model)
- [Tests](#tests) · [Development](#development) · [Troubleshooting](#troubleshooting)
- [Limits](#limits) · [Licences](#licences)

---

## Quick start

```bash
./setup.sh
transcribe-diarize/.venv/bin/python transcribe-diarize/server.py
```

Open <http://127.0.0.1:8000> and click **Mic** or **System audio**.

That's the whole thing — one process, one port. `setup.sh` is idempotent: the first run
takes a while (a C++ build plus ~1.6 GB of weights), re-runs take seconds.

Use `127.0.0.1` or `localhost`. Browser audio capture requires a secure context, and
plain `http://` on a LAN IP is not one.

## Requirements

macOS on Apple Silicon (Metal). All of these must be on `PATH`; `setup.sh` checks and
tells you what's missing:

```bash
brew install cmake uv node python
```

`git` too (`xcode-select --install`). About 3 GB of free disk.

## Setup

```bash
./setup.sh
```

Five steps, each skipped if already done:

1. **python venv** at `transcribe-diarize/.venv` — deliberately not the system or
   Homebrew interpreter, since the `transcribe_cpp` binding is built against our local
   `libtranscribe` and shouldn't leak out of the project.
2. **transcribe.cpp** — cloned at a pinned commit and built as a shared library.
3. **python deps** — `requirements.txt` plus the binding, installed into the venv.
4. **models** — ASR downloaded; the diarizer converted locally from the NVIDIA NeMo
   checkpoint, because the published sortformer GGUF repo is not publicly readable (401).
5. **tldraw canvas** — `npm install` and a production build into `canvas/dist`.

Everything afterwards must run through `transcribe-diarize/.venv/bin/python`, not a bare
`python` — the binding exists only inside the venv.

## Running

```bash
transcribe-diarize/.venv/bin/python transcribe-diarize/server.py
```

| route | |
|---|---|
| `/` | the tldraw canvas, when `canvas/dist` exists |
| `/legacy` | the plain transcript UI, always available |
| `/ws` | websocket: int16 PCM up, transcript JSON down |

The server logs which UI it picked at startup. If the canvas hasn't been built, `/` falls
back to the plain UI rather than erroring.

**Canvas controls.** `Mic` / `System audio` / `Stop`, plus a `Follow` toggle that keeps
the camera on the write head — it only scrolls once the write head drops off the bottom
of the viewport, and it's an explicit toggle rather than auto-detecting panning, so it
won't surprise you mid-drag.

Canvas contents persist in IndexedDB under `persistenceKey="transcript-canvas"`. Each new
capture session is placed below whatever is already on the page, so sessions accumulate
rather than overwrite. Clear the page with tldraw's own menu.

## Audio sources

- **Mic** — `getUserMedia`, system default input device.
- **System audio** — `getDisplayMedia`. On macOS Chrome this is **tab audio only**:
  choose the *Chrome Tab* option and tick **Share tab audio**. macOS does not expose
  whole-screen audio to the browser; Safari doesn't support it at all.

For true system-wide capture, install a loopback device, make it the default input, and
use the **Mic** button:

```bash
brew install --cask blackhole-2ch
```

(Then build a Multi-Output Device in Audio MIDI Setup so you can still hear playback.)

---

## How it works

The browser captures 16 kHz mono via an `AudioWorklet` and sends 100 ms int16 PCM blocks
over a websocket. Server-side, two models run on **independent threads** over the captured
audio and are joined by timestamp. The canvas then projects the result onto tldraw.

### The two-model split

- **ASR thread** — Parakeet, genuine cache-aware streaming: each chunk is encoded exactly
  once, never re-run.
- **DIAR thread** — Sortformer over the *whole* session. Re-diarizing everything each pass
  keeps speaker ids globally consistent, which removes any need to stitch speaker identity
  across windows. Diarization has no push-audio entry point upstream — the shipped entry
  point is a batch run over a whole recording.
- **Render** — each word takes the speaker whose segment contains its start time;
  consecutive same-speaker words are grouped into turns.

The split exists because **the multitalker speaker-attributed path is not ported**.
transcribe.cpp ships this checkpoint in `single_speaker_mode`: *"It does not separate
speakers, diarize, or emit speaker turns."* Speaker identity must therefore come from the
separate Sortformer model, hence the timestamp join.

### Getting timestamps out of the stream

The Python `Stream` wrapper exposes only text — `feed()` and `text()`. That looks like it
forces a batch re-run for timestamps, but it doesn't: the underlying session still carries
**token rows** during a stream, and the C header documents their streaming lifetime
explicitly (row `text` aliases a snapshot invalidated by the next `feed()`). So the ASR
thread feeds the stream, copies the token rows out via the session materializer, and
rebuilds words from them — a leading space starts a new word. That reproduces the batch
path's word rows exactly: same count, same timestamps.

This model reports `max_timestamp_kind == "token"`; the batch path's word rows are
themselves synthesized from these same tokens.

### Turn metadata: `id` and `final`

Every turn goes out with `t0`, `t1`, a stable `id`, and a `final` flag:

```json
{"id": 4960, "spk": "speaker_2", "text": "Sure, let's start with...",
 "t0": 4960, "t1": 8400, "final": true}
```

`final` means the turn has stopped changing, so a client can place it once and never
reconcile it again. A turn is final when **both** hold:

1. a later turn exists, and
2. its end is `COMMIT_AFTER` seconds behind the session clock.

**Both conditions are required, and this is not obvious.** Age alone is not enough: the
newest turn keeps absorbing words, which pushes its `t1` forward and flips it back *out*
of `final` after a client has already committed it — freezing a shape that is missing its
last few words. This was caught empirically on `samples/two_speakers.wav`, where an
age-only rule produced one such reversion per run. A turn only truly stops growing once a
later turn exists.

A consequence worth knowing: **the last turn of a session never becomes final.** It stays
in the live region until the next speaker starts, or until you press Stop.

`static/index.html` and `tests/test_stream.py` ignore these fields entirely and are
unaffected by them.

### Why the canvas is append-only

`server.py` rewrites the *entire* transcript on every update (~4×/sec at `EMIT=0.25`),
with no stable ids, and turn boundaries genuinely move as the diarizer re-runs over a
growing session. Mapping segment → shape and updating on each message would rewrite every
shape continuously, migrate text between shapes when a boundary shifts, clobber anything
the user had edited, and bury the undo stack within a minute.

So turns are split by `final`:

| | |
|---|---|
| **committed** (`final: true`) | created once as its own text shape, then never touched |
| **live tail** (`final: false`) | one grey shape, rewritten in place until it settles |

Because committed shapes are write-once, you can rearrange and annotate them freely and
nothing fights back. `committedUpto` is a high-water mark in session time, so a turn whose
boundary shifts after being committed can't reappear under a new id.

All canvas writes go through `editor.run(fn, { history: 'ignore' })`. Without it, Cmd-Z
walks backwards through the transcript instead of undoing your own edits.

Speaker colours mirror the plain UI: S0 blue, S1 green, S2 orange, S3 violet; the
unsettled tail is grey.

**The trade-off:** `final` is a heuristic, so the canvas is not a faithful mirror of the
transcript. If the diarizer revises a boundary behind a committed line, that shape stays
as it was. That's the right trade for a whiteboard you're annotating — stability beats
exactness — but if you need exactness, raise `COMMIT_AFTER` and accept a longer unsettled
tail.

### Two non-obvious things

**Use the `very_high_latency` diarizer preset, not `low_latency`.** The presets set the
model's internal *lookahead*, which costs nothing when the audio is already captured — so
the most accurate operating point is also by far the cheapest:

| preset | 16 s audio | 64 s audio |
|---|---|---|
| `very_high_latency` | 189× RT | 147× RT |
| `default` | 165× | 116× |
| `low_latency` | 13.9× | **7.9×** |

Identical segments, ~19× the throughput. `low_latency` only earns its cost for genuine
push-audio streaming, which this API doesn't offer.

**Align words to speakers by word START time** — not midpoint, not maximum overlap. RNN-T
end timestamps overshoot the acoustics, so a turn's final word straddles the diarization
boundary. In `samples/two_speakers.wav`, "today." spans 4.16–4.72 s against a boundary at
4.32 s: midpoint (4.44) and max-overlap (0.24 s vs 0.16 s) both misassign it to the next
speaker. Start time places every boundary word correctly.

---

## Configuration

All via environment variables, read by `server.py`.

| var | default | |
|---|---|---|
| `ASR_GGUF` | multitalker-parakeet Q8_0 | any transcribe.cpp ASR model — see below |
| `DIAR_GGUF` | sortformer F32 | |
| `DIARIZE` | `1` | `0` = flat transcript, ASR only |
| `DIAR_PRESET` | `very_high_latency` | see table above |
| `DIAR_MAX` | `900` | seconds of history fed to the diarizer |
| `ATT_RIGHT` | `13` | ASR right-context, 80 ms frames: `13` = 1.12 s latency, `6` = 0.56 s |
| `EMIT` | `0.25` | minimum seconds between UI updates |
| `COMMIT_AFTER` | `4` | seconds a turn must be quiet before it's marked `final` |
| `PORT` | `8000` | |

Batch-fallback only (ignored when the model streams):

| var | default | |
|---|---|---|
| `ASR_WINDOW` | `30` | seconds re-transcribed each pass |
| `TAIL` | `10` | seconds kept revisable; older words freeze |
| `TICK` | `0.7` | minimum seconds between passes |

Canvas-side, `VITE_WS_URL` overrides the websocket URL (default: port 8000 on the current
hostname, which is correct both when served by FastAPI and from the Vite dev server).

## Swapping the ASR model

Set `ASR_GGUF`. The server checks `capabilities.supports_streaming` at startup and picks a
path automatically, logging which one it used:

- **streaming** (preferred) — each chunk encoded once. Requires a streaming model.
- **batch fallback** — re-transcribes a rolling `ASR_WINDOW` every `TICK`, freezing words
  older than `TAIL`. Works with any model, but re-encodes the window every pass, so it
  costs far more GPU for the same audio.

**Most parakeet variants cannot stream.** Check before assuming:

```python
import transcribe_cpp as tc
c = tc.Model("models/your-model.gguf").capabilities
print(c.supports_streaming, c.max_timestamp_kind)
```

| model | Q8_0 | streaming | notes |
|---|---|---|---|
| `multitalker-parakeet-streaming-0.6b-v1` (default) | 734 MB | **yes** | 2.18% WER, writes "11%" |
| `nemotron-3.5-asr-streaming-0.6b` | 716 MB | **yes** | native PnC, 40 locales, writes "eleven percent" |
| `voxtral-mini-4b-realtime-2602` | 4.73 GB | **yes** | streaming audio-LLM, 2.07% WER |
| `parakeet-tdt-0.6b-v3` | 705 MB | no | 1.94% WER, forces batch path |
| whisper / canary / cohere | varies | no | cohere is 1.26% WER but offline-only |

The two 0.6B streaming models are interchangeable — same size, same
`ParakeetStreamOptions`, pure env-var swap:

```bash
ASR_GGUF=transcribe-diarize/models/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf \
  transcribe-diarize/.venv/bin/python transcribe-diarize/server.py
```

**If punctuation/formatting is the problem, try nemotron-3.5 first.** On
`samples/two_speakers.wav` all of these punctuate identically — the sample is read speech
and too easy to separate them — so the choice has to be made on your own spontaneous
audio. Note the one difference that *is* visible: the default does inverse text
normalisation ("11%"), nemotron-3.5 does not ("eleven percent"). Pick accordingly.

`voxtral-mini-4b-realtime-2602` is the heavyweight streaming option — an audio-LLM, so
likely the best at formatting spontaneous speech — but it is 6.5× the size for a slightly
worse WER, and uses `VoxtralRealtimeStreamOptions` rather than `ParakeetStreamOptions`, so
`asr_stream_worker` needs a small change to select the right extension. Untested here.

Diarization quality is unaffected by any of this — it comes entirely from Sortformer.

---

## Tests

With the server running:

```bash
transcribe-diarize/.venv/bin/python transcribe-diarize/tests/test_stream.py
```

Streams `samples/two_speakers.wav` at real-time speed and asserts the transcript comes
back as alternating speaker turns. Takes ~22 s (the sample is 16 s and is streamed at
1×). Expected output:

```
OK: 4 turns, 2 speakers, alternating
```

Typecheck and build the canvas:

```bash
npm --prefix canvas run build
```

## Development

For canvas work with hot reload, run the two servers separately:

```bash
transcribe-diarize/.venv/bin/python transcribe-diarize/server.py   # :8000, the API
npm --prefix canvas run dev                                        # :5173, the UI
```

Open <http://localhost:5173>. The dev server talks to `:8000` for the websocket;
WebSockets don't do CORS preflight and `localhost` is a secure context, so cross-port
capture works. Re-run `npm --prefix canvas run build` when you're done, so the version
served at `:8000` matches.

**Working without a microphone.** Dev builds expose `window.__transcript`, which replays
recorded server output through the real canvas code:

```js
fetch('/payloads.json').then(r => r.json()).then(f => __transcript.replay(f, 40))
```

`canvas/public/payloads.json` holds 16 update frames captured from a real run. The hook is
stripped from production builds. Regenerate the fixture by recording `update` frames off
`/ws` while streaming the sample.

### Layout

```
setup.sh                      builds everything (this is the only setup entry point)
README.md                     this file (the only doc)

transcribe-diarize/
  server.py                   websocket, two model threads, alignment, static serving
  static/index.html           the plain transcript UI, served at /legacy
  tests/test_stream.py        smoke test against a running server
  samples/two_speakers.wav    two-speaker test audio
  requirements.txt
  .venv/                      python env                        (gitignored)
  cpp/                        vendored transcribe.cpp + build   (gitignored, ~1.7 GB)
  models/                     GGUF weights                      (gitignored, ~1.1 GB)

canvas/
  src/capture.ts              AudioWorklet capture -> int16 blocks over the websocket
  src/transcript.ts           the append-only projection: commit, live tail, follow
  src/App.tsx                 Tldraw + toolbar + dev replay hook
  src/types.ts
  public/payloads.json        recorded frames for the dev hook
  dist/                       production build, served at /    (gitignored)
  node_modules/                                                (gitignored)
```

`cpp/`, `models/`, `.venv/`, `node_modules/` and `dist/` are deliberately **not**
committed — `cpp/` carries its own `.git`, and between them they're several GB. `setup.sh`
reproduces all of them.

---

## Troubleshooting

**"libtranscribe.0.2.0.dylib is damaged / can't be opened" (macOS Gatekeeper).**
The native library was *copied* onto the machine instead of built on it. Anything arriving
via zip, AirDrop, Slack or a browser download gets the `com.apple.quarantine` attribute,
and the library is only adhoc/linker-signed — no Developer ID, not notarized — so
Gatekeeper refuses to load it.

Don't hand-copy `cpp/` or `models/`. They're gitignored for this reason: clone the repo and
run `./setup.sh`, which compiles the library locally. Locally built binaries are never
quarantined.

If a copied tree is already in place, clear the attribute rather than rebuilding:

```bash
xattr -dr com.apple.quarantine transcribe-diarize/cpp/
```

Check what's set on a file with `xattr -l <file>`. A clean, locally built one shows only
`com.apple.provenance`, which is harmless.

**"busy" in the status bar.** `/ws` accepts one connection at a time. Close the other tab
— including a stale `:5173` dev tab if you're also running `:8000`.

**The canvas shows the plain UI instead of tldraw.** `canvas/dist` doesn't exist. Run
`npm --prefix canvas run build`, or just `./setup.sh` again.

**`npm warn allow-scripts esbuild`.** Harmless. npm 11 blocks install scripts by default;
esbuild ships its platform binary as an optional dependency, so it works anyway.

## Limits

- **No overlapping-speech separation.** Diarization assigns each instant to one speaker, so
  simultaneous talkers interleave rather than splitting into per-speaker channels. True
  separation needs NVIDIA's NeMo multitalker path, which transcribe.cpp doesn't port.
- **English only** — the ASR checkpoint is English-only by training.
- **One stream at a time**; a second websocket connection is rejected as busy.
- Speaker turn boundaries can shift slightly as the diarizer re-runs over a growing
  session. On the canvas, committed shapes do not retroactively follow such a shift — see
  [the trade-off](#why-the-canvas-is-append-only).
- Max 4 speakers (Sortformer 4spk).
- The last turn of a session stays grey (uncommitted) until someone else speaks or you
  press Stop.

## Licences

**tldraw** requires a license key **in production**, where production means HTTPS on a
non-localhost hostname. HTTP or `localhost` counts as development and the SDK works
normally with no key — which is what this setup is. If you ever put it behind a real HTTPS
domain you will need one: free hobby tier for non-commercial use, paid commercial licence
otherwise, and without a valid key the SDK logs licence errors and won't function properly.
See [tldraw.dev/sdk-features/license-key](https://tldraw.dev/sdk-features/license-key).

**transcribe.cpp** is MIT. **Both model checkpoints are NVIDIA**, released under the
[NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/).
Check those before redistributing weights.

Code in this repo: whatever you choose.
