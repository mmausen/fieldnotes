#!/usr/bin/env python3
"""Smoke test: stream a two-speaker sample at real-time speed through the server.

Start the server first, then:  python tests/test_stream.py

Expects 4 alternating speaker turns matching samples/two_speakers.wav.
Exits non-zero if the transcript is empty or the speakers don't alternate.
"""

import asyncio
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

ROOT = Path(__file__).resolve().parent.parent
URL = "ws://127.0.0.1:8000/ws"
BLOCK = 1600  # 100 ms, same as the browser worklet

EXPECTED = [
    "Good morning. I wanted to go over the quarterly numbers with you today.",
    "Sure, let's start with the revenue figures from the second quarter.",
    "Revenue was up 11%, mostly from the new subscription tier.",
    "That is better than we forecast. What about customer churn?",
]


async def main() -> int:
    audio, sr = sf.read(ROOT / "samples/two_speakers.wav", dtype="float32")
    assert sr == 16000, sr
    segs = []

    async with websockets.connect(URL) as ws:
        async def recv():
            nonlocal segs
            async for raw in ws:
                m = json.loads(raw)
                if m["type"] == "update":
                    segs = m["segments"]

        task = asyncio.create_task(recv())
        # trailing silence, as a live mic would send: the streaming decoder holds
        # the last ~1.1 s as tentative until further audio flushes it
        padded = np.concatenate([audio, np.zeros(2 * 16000, np.float32)])
        for i in range(0, len(padded), BLOCK):
            await ws.send(
                np.clip(padded[i:i + BLOCK] * 32767, -32768, 32767).astype(np.int16).tobytes()
            )
            await asyncio.sleep(0.1)  # real time
        await asyncio.sleep(3)  # let the final passes land
        task.cancel()

    print(f"--- {len(segs)} turns ---")
    for s in segs:
        print(f"{s['spk']:>10}: {s['text']}")

    if not segs:
        print("\nFAIL: no transcript", file=sys.stderr)
        return 1
    speakers = [s["spk"] for s in segs]
    if len(set(speakers)) < 2:
        print(f"\nFAIL: expected >=2 speakers, got {set(speakers)}", file=sys.stderr)
        return 1
    if any(a == b for a, b in zip(speakers, speakers[1:])):
        print(f"\nFAIL: speakers should alternate, got {speakers}", file=sys.stderr)
        return 1
    print(f"\nOK: {len(segs)} turns, {len(set(speakers))} speakers, alternating")
    print("\n(reference transcript)")
    for line in EXPECTED:
        print(f"  {line}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
