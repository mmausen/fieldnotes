/** Mic / tab-audio / file capture, ported from transcribe-diarize/static/index.html.
 *
 * Captures 16 kHz mono through an AudioWorklet (mic/system) or decodes a file,
 * and pushes 100 ms int16 blocks over the websocket -- the exact wire format
 * server.py expects. Kept byte-for-byte compatible with the original page so /ws
 * needs no changes and its single-connection lock stays correct.
 *
 * File playback adds a tape-style transport (play/pause, rewind-to-start, skip
 * forward). The server timeline is append-only -- its clock is the running count
 * of samples it has received -- so:
 *   - pause/play just stops/resumes sending; the clock only advances with audio.
 *   - skip forward advances the playhead WITHOUT sending, so the skipped span is
 *     simply never transcribed; timestamps stay consistent.
 *   - rewind can't un-send audio, so it tears down the socket and opens a fresh
 *     session from the top (onReset lets the canvas clear first).
 */
import type { Source, Turn } from './types'

const SR = 16000
const BLOCK = 1600 // 100 ms
const SKIP = 10 // seconds per forward skip

const workletSrc = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${BLOCK}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${BLOCK}) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('cap', Cap);`

export const WS_URL: string =
  (import.meta.env.VITE_WS_URL as string | undefined) ??
  `ws://${location.hostname || '127.0.0.1'}:8000/ws`

export type CaptureHandlers = {
  onTurns: (turns: Turn[]) => void
  onStatus: (text: string) => void
  onEnded: () => void
  /** file transport only: playhead play/pause state changed */
  onState?: (playing: boolean) => void
  /** file transport only: session is restarting from the top; clear the canvas */
  onReset?: () => void
  /** file transport only: playback reached the end and the last update landed */
  onFinished?: () => void
  /** file transport only: playhead jumped; draw a divider at this label */
  onMarker?: (label: string) => void
}

/** Downmix + resample a decoded AudioBuffer to 16 kHz mono int16. */
async function toInt16Mono16k(audio: AudioBuffer): Promise<Int16Array> {
  const frames = Math.max(1, Math.ceil(audio.duration * SR))
  const off = new OfflineAudioContext(1, frames, SR)
  const src = off.createBufferSource()
  src.buffer = audio
  src.connect(off.destination) // multi-channel -> 1-channel downmixes per spec
  src.start()
  const ch = (await off.startRendering()).getChannelData(0)
  const pcm = new Int16Array(ch.length)
  for (let i = 0; i < ch.length; i++) {
    const v = Math.max(-1, Math.min(1, ch[i]))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return pcm
}

function mmss(samples: number): string {
  const s = Math.round(samples / SR)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export class Capture {
  private ctx?: AudioContext
  private node?: AudioWorkletNode
  private stream?: MediaStream
  private ws?: WebSocket
  private running = false

  // file transport state
  private pcm?: Int16Array
  private pos = 0
  private playing = false
  private pumpTimer?: ReturnType<typeof setTimeout>
  private fileHandlers?: CaptureHandlers

  /** Open a websocket wired to `h` and resolve once it is open (or failed). */
  private openWs(h: CaptureHandlers): Promise<boolean> {
    const ws = new WebSocket(WS_URL)
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string)
      if (m.type === 'update') h.onTurns(m.segments as Turn[])
      else if (m.type === 'status') h.onStatus(m.text)
    }
    ws.onclose = () => {
      if (this.running) {
        h.onStatus('disconnected')
        this.stop()
        h.onEnded()
      }
    }
    ws.onerror = () => h.onStatus('websocket error — is server.py running?')
    return new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true)
      // onerror fires before onclose when the connection never opens
      ws.addEventListener('error', () => resolve(false), { once: true })
    })
  }

  /** Detach handlers first so a deliberate close doesn't fire onEnded. */
  private teardownWs() {
    const ws = this.ws
    this.ws = undefined
    if (!ws) return
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.onopen = null
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    } catch {}
  }

  async start(source: Source, h: CaptureHandlers): Promise<boolean> {
    if (this.running) return false

    try {
      this.stream =
        source === 'mic'
          ? await navigator.mediaDevices.getUserMedia({
              audio: {
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
              },
            })
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    } catch (e) {
      h.onStatus('capture denied: ' + (e as Error).name)
      return false
    }

    if (source === 'sys') {
      // we only ever wanted the audio track; drop video immediately
      this.stream.getVideoTracks().forEach((t) => t.stop())
      if (!this.stream.getAudioTracks().length) {
        h.onStatus('no audio track — tick "Share tab audio"')
        this.stream.getTracks().forEach((t) => t.stop())
        return false
      }
    }
    this.stream.getAudioTracks()[0].onended = () => this.stop()

    this.running = true

    if (!(await this.openWs(h))) {
      this.running = false
      this.stream.getTracks().forEach((t) => t.stop())
      h.onStatus(`cannot reach ${WS_URL}`)
      return false
    }
    const ws = this.ws!

    this.ctx = new AudioContext({ sampleRate: SR })
    await this.ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' })),
    )
    this.node = new AudioWorkletNode(this.ctx, 'cap', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    })
    this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const f = ev.data
      const pcm = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) {
        const v = Math.max(-1, Math.min(1, f[i]))
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      ws.send(pcm.buffer)
    }
    this.ctx.createMediaStreamSource(this.stream).connect(this.node)
    h.onStatus(source === 'mic' ? 'listening (mic)' : 'listening (system)')
    return true
  }

  /** Decode an audio file and start playing it into a fresh session. */
  async loadFile(file: File, h: CaptureHandlers): Promise<boolean> {
    if (this.running) return false
    try {
      const dec = new AudioContext()
      const audio = await dec.decodeAudioData(await file.arrayBuffer())
      await dec.close()
      this.pcm = await toInt16Mono16k(audio)
    } catch (e) {
      h.onStatus('decode failed: ' + (e as Error).message)
      return false
    }
    if (!this.pcm.length) {
      h.onStatus('no audio in file')
      return false
    }
    this.fileHandlers = h
    this.pos = 0
    return this.openSession()
  }

  /** (Re)open the socket and start streaming from the current playhead. */
  private async openSession(): Promise<boolean> {
    const h = this.fileHandlers!
    this.teardownWs()
    this.running = true
    if (!(await this.openWs(h))) {
      this.running = false
      h.onStatus(`cannot reach ${WS_URL}`)
      return false
    }
    this.setPlaying(true)
    this.pump()
    return true
  }

  private setPlaying(v: boolean) {
    this.playing = v
    this.fileHandlers?.onState?.(v)
  }

  private report(state: string) {
    if (this.pcm) this.fileHandlers?.onStatus(`${state}  ${mmss(this.pos)} / ${mmss(this.pcm.length)}`)
  }

  /** Send one 100 ms block, paced at realtime, while playing. */
  private pump = () => {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    if (!this.running || !this.playing || !this.pcm) return
    if (this.pos >= this.pcm.length) {
      this.setPlaying(false)
      this.report('ended')
      // give the server a beat to run its final pass and send the last update,
      // then commit the still-grey tail in colour. Stay loaded so ⏮ can replay.
      const h = this.fileHandlers
      setTimeout(() => {
        if (this.running && this.pcm && this.pos >= this.pcm.length) h?.onFinished?.()
      }, 1500)
      return
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      const end = Math.min(this.pos + BLOCK, this.pcm.length)
      this.ws.send(this.pcm.slice(this.pos, end).buffer)
      this.pos = end
      this.report('playing')
    }
    this.pumpTimer = setTimeout(this.pump, 100)
  }

  /** Toggle play/pause of file playback. No-op for mic/system capture. */
  playPause() {
    if (!this.pcm || !this.running) return
    if (this.playing) {
      this.setPlaying(false)
      this.report('paused')
    } else {
      if (this.pos >= this.pcm.length) return // at the end; use rewind
      this.setPlaying(true)
      this.pump()
    }
  }

  /** Restart transcription from the top: fresh session + cleared canvas. */
  async rewind() {
    if (!this.pcm) return
    this.pos = 0
    this.fileHandlers?.onReset?.()
    this.fileHandlers?.onMarker?.(`⏮ ${mmss(0)}`)
    await this.openSession()
  }

  /** Skip the playhead forward; skipped audio is never transcribed. */
  forward() {
    if (!this.pcm) return
    this.pos = Math.min(this.pcm.length, this.pos + SKIP * SR)
    this.fileHandlers?.onMarker?.(`⏭ ${mmss(this.pos)}`)
    this.report(this.playing ? 'playing' : 'paused')
  }

  stop() {
    if (!this.running) return
    this.running = false
    this.playing = false
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    this.pcm = undefined
    this.fileHandlers = undefined
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close()
    } catch {}
    try {
      this.node?.disconnect()
    } catch {}
    try {
      this.ctx?.close()
    } catch {}
    try {
      this.stream?.getTracks().forEach((t) => t.stop())
    } catch {}
  }
}
