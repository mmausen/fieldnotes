"""Speaker-attributed streaming transcription via transcribe.cpp (ggml/Metal).

transcribe.cpp does not port the multitalker speaker-attributed path, so speaker
identity has to come from the separate Sortformer diarizer. The two models run on
independent threads and are joined by timestamp:

  ASR thread   Parakeet, true cache-aware streaming -> tokens with timestamps
  DIAR thread  Sortformer over the whole session    -> speaker segments
  render       each word takes the speaker whose segment covers its start time

ASR is genuine streaming: every chunk is encoded exactly once. The Python Stream
wrapper only surfaces text, but the session still carries token rows during a
stream (the C header documents the streaming lifetime of transcribe_get_token
explicitly), so we copy those out and rebuild words from them.

Diarization has no push-audio entry point upstream -- the shipped entry point is
a batch run over a whole recording -- so it re-runs over the full session each
pass. That also keeps speaker ids globally consistent, removing any need to
stitch identity across windows, and it is cheap: the VERY_HIGH_LATENCY preset
runs ~150x realtime. The presets set internal lookahead, which costs nothing when
the audio is already captured, so the most accurate preset is also the fastest
(LOW_LATENCY is ~8x, i.e. 19x slower, and only pays off for real push-audio).
"""

import asyncio
import json
import logging
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).parent
CPP = HERE / "cpp"
MODELS = HERE / "models"
# the binding resolves the native library from this; setup.sh builds it here
os.environ.setdefault("TRANSCRIBE_LIBRARY", str(CPP / "build/src/libtranscribe.dylib"))

import transcribe_cpp as tc  # noqa: E402  (must follow TRANSCRIBE_LIBRARY)

ASR_GGUF = os.environ.get(
    "ASR_GGUF", str(MODELS / "multitalker-parakeet-streaming-0.6b-v1-Q8_0.gguf"))
DIAR_GGUF = os.environ.get(
    "DIAR_GGUF", str(MODELS / "diar_streaming_sortformer_4spk-v2.1-F32.gguf"))

SR = 16000
DIARIZE = os.environ.get("DIARIZE", "1") != "0"
# right-context in 80 ms frames: 13 -> 1.12 s latency, 6 -> 0.56 s, 1 -> 0.16 s
ATT_RIGHT = int(os.environ.get("ATT_RIGHT", "13"))
EMIT = float(os.environ.get("EMIT", "0.25"))          # min seconds between UI updates
DIAR_MAX = float(os.environ.get("DIAR_MAX", "900"))   # s of history fed to the diarizer
DIAR_PRESET = os.environ.get("DIAR_PRESET", "very_high_latency")
# a turn freezes once the session clock is this far past its end; frozen turns get a
# stable id so append-only clients (the tldraw canvas) can commit them exactly once
COMMIT_AFTER = float(os.environ.get("COMMIT_AFTER", "4"))
# batch-fallback only (models that cannot stream)
ASR_WINDOW = float(os.environ.get("ASR_WINDOW", "30"))  # s re-transcribed per pass
TAIL = float(os.environ.get("TAIL", "10"))              # s kept revisable
TICK = float(os.environ.get("TICK", "0.7"))             # min s between passes

STATIC = HERE / "static"
# built tldraw canvas, if setup.sh has produced one; served at / in preference to
# the built-in UI so the whole thing runs as a single process on a single port
CANVAS = HERE.parent / "canvas" / "dist"
log = logging.getLogger("transcribe")

_conn_lock = threading.Lock()


class Live:
    """Shared state for one live capture."""

    def __init__(self):
        self.lock = threading.Lock()
        self.pcm: "queue.Queue" = queue.Queue()  # -> ASR thread
        self.blocks = []      # full session audio, for the diarizer
        self.n = 0            # total samples captured
        self.words = []       # (t0_ms, t1_ms, text)
        self.spk = []         # (t0_ms, t1_ms, speaker_id)
        self.stop = threading.Event()
        self.dirty = threading.Event()

    def add(self, pcm):
        self.pcm.put(pcm)
        with self.lock:
            self.blocks.append(pcm)
            self.n += len(pcm)

    def audio(self, last_s):
        with self.lock:
            if not self.blocks:
                return np.zeros(0, np.float32), 0
            if len(self.blocks) > 1:
                self.blocks = [np.concatenate(self.blocks)]
            buf = self.blocks[0]
        start = max(0, len(buf) - int(last_s * SR))
        return buf[start:], start


def words_from_tokens(tokens):
    """Rebuild words from subword tokens; a leading space starts a new word.

    Reproduces the batch path's word rows exactly -- same count, same
    timestamps -- which is what makes streaming a drop-in for alignment.
    """
    out = []
    for t in tokens:
        if not t.text:
            continue
        if t.text.startswith(" ") or not out:
            out.append([float(t.t0_ms), float(t.t1_ms), t.text.strip()])
        else:
            out[-1][1] = float(t.t1_ms)
            out[-1][2] += t.text
    return [(a, b, w) for a, b, w in out if w]


def asr_stream_worker(live: Live, model):
    """Preferred path: cache-aware streaming, each chunk encoded exactly once."""
    opts = tc.ParakeetStreamOptions(att_context_right=ATT_RIGHT)
    last_emit = 0.0
    with model.session() as sess, sess.stream(timestamps="token", family=opts) as st:
        while not live.stop.is_set():
            pcm = live.pcm.get()
            if pcm is None:
                break
            try:
                upd = st.feed(pcm)
            except Exception:
                log.exception("asr")
                continue
            now = time.time()
            if not upd.result_changed or now - last_emit < EMIT:
                continue
            last_emit = now
            # copy the rows out before the next feed invalidates the snapshot
            words = words_from_tokens(sess._materialize().tokens)
            with live.lock:
                live.words = words
            live.dirty.set()


def asr_batch_worker(live: Live, model):
    """Fallback for offline-only models (e.g. parakeet-tdt-0.6b-v3, whisper).

    Re-transcribes a rolling window and freezes words older than TAIL, which
    bounds per-pass cost. Strictly more expensive than streaming -- the window
    is re-encoded every pass -- so it is only used when the model cannot stream.
    """
    frozen, frozen_upto = [], 0.0
    with model.session() as sess:
        while not live.stop.is_set():
            t0 = time.time()
            buf, offset = live.audio(ASR_WINDOW)
            if len(buf) < SR // 2:
                time.sleep(0.2)
                continue
            try:
                res = sess.run(buf, timestamps="word")
            except Exception:
                log.exception("asr")
                time.sleep(0.5)
                continue
            off = offset / SR * 1000.0
            fresh = [(w.t0_ms + off, w.t1_ms + off, w.text.strip()) for w in res.words]
            cut = max(0.0, live.n / SR * 1000.0 - TAIL * 1000.0)
            frozen.extend(w for w in fresh if frozen_upto <= w[1] < cut)
            frozen_upto = max(frozen_upto, cut)
            with live.lock:
                live.words = frozen + [w for w in fresh if w[1] >= frozen_upto]
            live.dirty.set()
            time.sleep(max(0.0, TICK - (time.time() - t0)))


def asr_worker(live: Live):
    model = tc.Model(ASR_GGUF)
    try:
        if model.capabilities.supports_streaming:
            asr_stream_worker(live, model)
        else:
            asr_batch_worker(live, model)
    finally:
        model.close()


def diar_worker(live: Live):
    """Diarize the whole session so speaker ids stay globally consistent."""
    model = tc.Model(DIAR_GGUF)
    opts = tc.SortformerStreamOptions(preset=DIAR_PRESET)
    with model.session() as sess:
        while not live.stop.is_set():
            t0 = time.time()
            buf, offset = live.audio(DIAR_MAX)
            if len(buf) < 2 * SR:
                time.sleep(0.4)
                continue
            try:
                res = sess.run(buf, family=opts)
            except Exception:
                log.exception("diar")
                time.sleep(0.5)
                continue
            off_ms = offset / SR * 1000.0
            with live.lock:
                live.spk = [(s.t0_ms + off_ms, s.t1_ms + off_ms, s.speaker_id)
                            for s in res.speaker_segments]
            live.dirty.set()
            # back off in proportion to how long the pass took, so long sessions
            # re-diarize less often instead of saturating the GPU
            time.sleep(max(0.5, (time.time() - t0) * 2))
    model.close()


def render(live: Live):
    """Join words to speakers by timestamp and group into turns.

    Each turn also carries t0/t1, a stable `id`, and `final`. A turn is final once
    the session clock has moved COMMIT_AFTER seconds past its end, after which its
    start time -- and so its id -- no longer moves. That lets a client append it
    once and never touch it again, instead of re-reconciling the whole transcript
    on every update. Clients that don't care (static/index.html, the smoke test)
    just ignore the extra fields.
    """
    with live.lock:
        words = sorted(live.words, key=lambda w: w[0])
        spk = list(live.spk)
        now_ms = live.n / SR * 1000.0
    if not words:
        return []

    out, cur = [], None
    for t0, t1, text in words:
        # Match on word START, not midpoint or overlap: RNN-T end times overshoot
        # the acoustics, so a turn's last word straddles the diarization boundary
        # and midpoint/max-overlap both push it onto the next speaker.
        who = None
        if spk:
            for a, b, sid in spk:
                if a <= t0 <= b:
                    who = sid
                    break
            if who is None:  # fall back to the nearest segment
                who = min(spk, key=lambda s: min(abs(t0 - s[0]), abs(t0 - s[1])))[2]
        if cur is not None and cur["_id"] == who:
            cur["text"] += " " + text
            cur["t1"] = t1
        else:
            cur = {"_id": who, "spk": f"speaker_{who}" if who is not None else "",
                   "text": text, "t0": t0, "t1": t1}
            out.append(cur)
    for s in out:
        s.pop("_id", None)
        s["text"] = s["text"].strip()
    out = [s for s in out if s["text"]]

    cutoff = now_ms - COMMIT_AFTER * 1000.0
    for i, s in enumerate(out):
        s["id"] = int(s["t0"])
        # Both conditions are needed. Age alone is not enough: the newest turn
        # keeps absorbing words, which pushes its t1 forward and would flip it
        # back out of final after a client had already committed it -- freezing
        # a shape that is missing its last few words. A turn only truly stops
        # growing once a later turn exists, so require that too. The last turn
        # is therefore never final; it stays in the live region until the next
        # speaker starts, or until the session ends.
        s["final"] = i < len(out) - 1 and s["t1"] < cutoff
    return out


app = FastAPI()


@app.on_event("startup")
def _startup():
    for p in [ASR_GGUF] + ([DIAR_GGUF] if DIARIZE else []):
        if not Path(p).exists():
            raise SystemExit(f"missing model: {p}\nRun ./setup.sh first.")
    log.info("asr:  %s", Path(ASR_GGUF).name)
    log.info("diar: %s", Path(DIAR_GGUF).name if DIARIZE else "(disabled)")
    m = tc.Model(ASR_GGUF)
    mode = "streaming" if m.capabilities.supports_streaming else "batch (model cannot stream)"
    log.info("asr mode: %s", mode)
    log.info("ui:   %s", "canvas (tldraw)" if (CANVAS / "index.html").exists()
             else "built-in (canvas not built -- run ./setup.sh)")
    log.info("ready (backend=%s, preset=%s) -> http://127.0.0.1:%s",
             m.backend, DIAR_PRESET, os.environ.get("PORT", "8000"))
    m.close()


if (CANVAS / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=CANVAS / "assets"), name="canvas-assets")
# local embedding model + onnxruntime wasm for the interview cross-referencer
# (kept off any CDN so the app stays fully offline)
if (CANVAS / "models").is_dir():
    app.mount("/models", StaticFiles(directory=CANVAS / "models"), name="canvas-models")
if (CANVAS / "ort").is_dir():
    app.mount("/ort", StaticFiles(directory=CANVAS / "ort"), name="canvas-ort")


@app.get("/")
def index():
    """tldraw canvas when it has been built, otherwise the built-in transcript UI."""
    if (CANVAS / "index.html").exists():
        return FileResponse(CANVAS / "index.html")
    return FileResponse(STATIC / "index.html")


@app.get("/legacy")
def legacy():
    """The plain transcript UI, always available regardless of the canvas build."""
    return FileResponse(STATIC / "index.html")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    if not _conn_lock.acquire(blocking=False):
        await ws.send_text(json.dumps({"type": "status", "text": "busy"}))
        await ws.close()
        return

    live = Live()
    loop = asyncio.get_running_loop()
    threads = [threading.Thread(target=asr_worker, args=(live,), daemon=True)]
    if DIARIZE:
        threads.append(threading.Thread(target=diar_worker, args=(live,), daemon=True))
    for t in threads:
        t.start()

    async def pusher():
        last = None
        while True:
            await asyncio.sleep(0.2)
            if not live.dirty.is_set():
                continue
            live.dirty.clear()
            segs = await loop.run_in_executor(None, render, live)
            if segs and segs != last:
                last = segs
                await ws.send_text(json.dumps({"type": "update", "segments": segs}))

    push_task = asyncio.create_task(pusher())
    try:
        while True:
            data = await ws.receive_bytes()
            live.add(np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0)
    except WebSocketDisconnect:
        pass
    finally:
        live.stop.set()
        live.pcm.put(None)
        push_task.cancel()
        for t in threads:
            t.join(timeout=10)
        _conn_lock.release()


if __name__ == "__main__":
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")), log_level="warning")
