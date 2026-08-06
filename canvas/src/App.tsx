import { useCallback, useEffect, useRef, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import { Capture, WS_URL } from './capture'
import { TranscriptCanvas } from './transcript'
import { Matcher } from './interview/matcher'
import { InterviewTreeCanvas } from './interview/InterviewTreeCanvas'
import type { Source, Turn } from './types'

export default function App() {
  const editorRef = useRef<Editor | null>(null)
  const canvasRef = useRef<TranscriptCanvas | null>(null)
  const captureRef = useRef<Capture | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState('idle')
  const [running, setRunning] = useState(false)
  const [follow, setFollow] = useState(true)
  const [fileMode, setFileMode] = useState(false)
  const [playing, setPlaying] = useState(false)

  // interview cross-referencing
  const matcherRef = useRef<Matcher | null>(null)
  const treeRef = useRef<InterviewTreeCanvas | null>(null)
  const seenRef = useRef<Set<number>>(new Set())
  const lastTurnsRef = useRef<Turn[]>([])
  const queueRef = useRef<{ text: string; spk: string }[]>([])
  const drainingRef = useRef(false)
  const [showInterview, setShowInterview] = useState(false)
  const [interviewStatus, setInterviewStatus] = useState('off')
  const [tick, setTick] = useState(0)

  const drain = useCallback(async () => {
    if (drainingRef.current) return
    const m = matcherRef.current
    if (!m) return
    drainingRef.current = true
    try {
      while (queueRef.current.length) {
        const { text, spk } = queueRef.current.shift()!
        const changed = await m.ingest(text, spk)
        if (changed) setTick((x) => x + 1)
      }
    } finally {
      drainingRef.current = false
    }
  }, [])

  // ingest each committed turn once into the matcher
  const feedMatcher = useCallback(
    (turns: Turn[]) => {
      lastTurnsRef.current = turns
      const m = matcherRef.current
      if (!m || !m.ready) return
      for (const t of turns) {
        if (t.final && !seenRef.current.has(t.id)) {
          seenRef.current.add(t.id)
          queueRef.current.push({ text: t.text, spk: t.spk })
        }
      }
      void drain()
    },
    [drain],
  )

  // ingest the still-unsettled tail (turns that never went `final`) when a
  // recording ends, so the whole transcript gets cross-referenced
  const flushMatcher = useCallback(() => {
    const m = matcherRef.current
    if (!m || !m.ready) return
    for (const t of lastTurnsRef.current) {
      if (!seenRef.current.has(t.id) && t.text.trim()) {
        seenRef.current.add(t.id)
        queueRef.current.push({ text: t.text, spk: t.spk })
      }
    }
    void drain()
  }, [drain])

  const toggleInterview = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    if (showInterview) {
      treeRef.current?.clear()
      setShowInterview(false)
      return
    }
    setShowInterview(true)

    let m = matcherRef.current
    if (!m) {
      m = new Matcher()
      matcherRef.current = m
    }
    // draw the tree immediately (structure + current colours), then load the
    // model in the background and recolour once it's ready
    if (!treeRef.current) treeRef.current = new InterviewTreeCanvas(editor)
    treeRef.current.build(m)

    if (!m.ready) {
      setInterviewStatus('loading model…')
      try {
        await m.init(setInterviewStatus)
        treeRef.current.apply(m)
        // local testing hook: __interview.feed("an answer") drives the matcher
        // without audio (mirrors A1's "Relation test cases" page)
        ;(window as unknown as { __interview?: unknown }).__interview = {
          matcher: m,
          feed: async (text: string, spk = 'speaker_1') => {
            const changed = await m.ingest(text, spk)
            setTick((x) => x + 1)
            return { changed, current: m.currentQid, next: m.nextQid, active: m.activeModule }
          },
        }
      } catch (e) {
        setInterviewStatus('model failed: ' + (e as Error).message)
      }
    }
  }, [showInterview])

  // push matcher state onto the canvas tree whenever it changes
  useEffect(() => {
    if (showInterview && matcherRef.current) treeRef.current?.apply(matcherRef.current)
  }, [tick, showInterview])

  // start of any new recording resets what the matcher has heard
  const newInterviewSession = () => {
    seenRef.current.clear()
    queueRef.current = []
    matcherRef.current?.reset()
    setTick((x) => x + 1)
  }

  const onMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    ;(window as unknown as { __editor?: Editor }).__editor = editor
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
    newInterviewSession()

    const cap = new Capture()
    captureRef.current = cap
    setRunning(true)

    const ok = await cap.start(source, {
      onTurns: (turns) => {
        canvas.apply(turns)
        feedMatcher(turns)
      },
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

  const startFile = async (file: File) => {
    const editor = editorRef.current
    if (!editor || running) return

    const canvas = new TranscriptCanvas(editor)
    canvas.beginSession()
    canvas.setFollow(follow)
    canvasRef.current = canvas
    newInterviewSession()

    const cap = new Capture()
    captureRef.current = cap
    setRunning(true)
    setFileMode(true)

    const ok = await cap.loadFile(file, {
      onTurns: (turns) => {
        canvas.apply(turns)
        feedMatcher(turns)
      },
      onStatus: setStatus,
      onState: setPlaying,
      onReset: () => {
        canvas.reset()
        newInterviewSession()
      },
      onMarker: (labelText) => canvas.marker(labelText),
      onFinished: () => {
        canvas.flush()
        flushMatcher()
      },
      onEnded: () => {
        canvas.endSession()
        setRunning(false)
        setFileMode(false)
        setPlaying(false)
      },
    })
    if (!ok) {
      canvas.endSession()
      setRunning(false)
      setFileMode(false)
      setPlaying(false)
    }
  }

  const playPause = () => captureRef.current?.playPause()
  const rewind = () => void captureRef.current?.rewind()
  const forward = () => captureRef.current?.forward()

  const stop = () => {
    flushMatcher()
    captureRef.current?.stop()
    canvasRef.current?.endSession()
    setRunning(false)
    setFileMode(false)
    setPlaying(false)
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
        <button style={btn(false)} onClick={() => fileRef.current?.click()} disabled={running}>
          Load audio
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = '' // allow re-selecting the same file
            if (f) void startFile(f)
          }}
        />
        {fileMode && (
          <>
            <button style={btn(false)} onClick={rewind} title="Rewind to start">
              ⏮
            </button>
            <button style={btn(playing)} onClick={playPause} title={playing ? 'Pause' : 'Play'}>
              {playing ? '⏸' : '▶'}
            </button>
            <button style={btn(false)} onClick={forward} title="Skip forward 10s">
              ⏩
            </button>
          </>
        )}
        <button style={btn(false)} onClick={stop} disabled={!running}>
          Stop
        </button>
        <button style={btn(follow)} onClick={toggleFollow}>
          Follow
        </button>
        <button style={btn(showInterview)} onClick={() => void toggleInterview()}>
          Interview
        </button>
        <span style={{ fontSize: 12, opacity: 0.7 }} title={WS_URL}>
          {showInterview && !matcherRef.current?.ready ? interviewStatus : status}
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
