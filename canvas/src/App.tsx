import { useCallback, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { Capture, WS_URL } from './capture'
import { TranscriptCanvas } from './transcript'
import type { Source, Turn } from './types'

export default function App() {
  const editorRef = useRef<Editor | null>(null)
  const canvasRef = useRef<TranscriptCanvas | null>(null)
  const captureRef = useRef<Capture | null>(null)
  const [status, setStatus] = useState('idle')
  const [running, setRunning] = useState(false)
  const [follow, setFollow] = useState(true)

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    if (import.meta.env.DEV) {
      // dev hook: replay recorded server payloads without a microphone, e.g.
      //   __transcript.replay(await (await fetch('/payloads.json')).json())
      ;(window as globalThis.Window & { __transcript?: unknown }).__transcript = {
        editor,
        feed: (turns: Turn[]) => {
          if (!canvasRef.current) {
            canvasRef.current = new TranscriptCanvas(editor)
            canvasRef.current.beginSession()
          }
          canvasRef.current.apply(turns)
        },
        replay: async (frames: Turn[][], delayMs = 60) => {
          for (const f of frames) {
            ;(window as globalThis.Window & { __transcript?: any }).__transcript.feed(f)
            await new Promise((r) => setTimeout(r, delayMs))
          }
          canvasRef.current?.endSession()
          return editor.getCurrentPageShapes().length
        },
      }
    }
  }, [])

  const start = async (source: Source) => {
    const editor = editorRef.current
    if (!editor || running) return

    const canvas = new TranscriptCanvas(editor)
    canvas.beginSession()
    canvas.setFollow(follow)
    canvasRef.current = canvas

    const cap = new Capture()
    captureRef.current = cap
    setRunning(true)

    const ok = await cap.start(source, {
      onTurns: (turns) => canvas.apply(turns),
      onStatus: setStatus,
      onEnded: () => {
        canvas.endSession()
        setRunning(false)
      },
    })
    if (!ok) {
      canvas.endSession()
      setRunning(false)
    }
  }

  const stop = () => {
    captureRef.current?.stop()
    canvasRef.current?.endSession()
    setRunning(false)
    setStatus('idle')
  }

  const toggleFollow = () => {
    const next = !follow
    setFollow(next)
    canvasRef.current?.setFollow(next)
  }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw persistenceKey="transcript-canvas" onMount={onMount} />
      <div style={bar}>
        <button style={btn(false)} onClick={() => start('mic')} disabled={running}>
          Mic
        </button>
        <button style={btn(false)} onClick={() => start('sys')} disabled={running}>
          System audio
        </button>
        <button style={btn(false)} onClick={stop} disabled={!running}>
          Stop
        </button>
        <button style={btn(follow)} onClick={toggleFollow}>
          Follow
        </button>
        <span style={{ fontSize: 12, opacity: 0.7 }} title={WS_URL}>
          {status}
        </span>
      </div>
    </div>
  )
}

const bar: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 400, // above tldraw's own UI layer
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '6px 10px',
  borderRadius: 8,
  background: 'var(--color-panel, #fff)',
  boxShadow: '0 1px 4px rgba(0,0,0,.18)',
  font: '13px ui-sans-serif, system-ui, sans-serif',
  pointerEvents: 'all',
}

const btn = (on: boolean): React.CSSProperties => ({
  font: 'inherit',
  padding: '4px 10px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid rgba(0,0,0,.18)',
  background: on ? '#2f6d4f' : 'transparent',
  color: on ? '#fff' : 'inherit',
})
