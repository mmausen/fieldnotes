/** Mic / tab-audio capture, ported from transcribe-diarize/static/index.html.
 *
 * Captures 16 kHz mono through an AudioWorklet and pushes 100 ms int16 blocks
 * over the websocket -- the exact wire format server.py expects. Kept
 * byte-for-byte compatible with the original page so /ws needs no changes and
 * its single-connection lock stays correct.
 */
import type { Source, Turn } from './types'

const SR = 16000
const BLOCK = 1600 // 100 ms

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
}

export class Capture {
  private ctx?: AudioContext
  private node?: AudioWorkletNode
  private stream?: MediaStream
  private ws?: WebSocket
  private running = false

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

    try {
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        // onerror fires before onclose when the connection never opens
        ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true })
      })
    } catch {
      this.running = false
      this.stream.getTracks().forEach((t) => t.stop())
      h.onStatus(`cannot reach ${WS_URL}`)
      return false
    }

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

  stop() {
    if (!this.running) return
    this.running = false
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
