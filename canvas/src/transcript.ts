/** Append-only projection of the transcript onto the tldraw canvas.
 *
 * server.py rewrites the whole transcript on every update (~4x/sec) with no
 * stable ids, and turn boundaries move as the diarizer re-runs over a growing
 * session. Mapping segment -> shape and updating on each message would rewrite
 * every shape continuously, migrate text between shapes when a boundary shifts,
 * clobber user edits, and bury the undo stack.
 *
 * So we split on the server's `final` flag:
 *   final turn  -> created once as its own text shape, then never touched again
 *   live tail    -> a single grey shape, rewritten in place until it settles
 *
 * Because committed shapes are write-once, the user can move, edit, recolour and
 * connect them with arrows and nothing fights back. `committedUpto` is a
 * high-water mark in session time, so a turn whose boundary shifted after it was
 * committed can't be committed a second time under a new id.
 *
 * Every write goes through editor.run(..., { history: 'ignore' }) -- otherwise
 * Cmd-Z walks backwards through the transcript instead of the user's own edits.
 */
import { createShapeId, toRichText, type Editor, type TLShapeId } from 'tldraw'
import type { Turn } from './types'

const WIDTH = 560
const GAP = 14
// mirrors the s0-s3 colours in transcribe-diarize/static/index.html
const SPEAKER_COLOR = ['blue', 'green', 'orange', 'violet'] as const
const SCROLL_MARGIN = 120

function spkIndex(spk: string): number | null {
  const m = /(\d+)/.exec(spk)
  return m ? parseInt(m[1], 10) : null
}

function label(t: Turn): string {
  const i = spkIndex(t.spk)
  return i === null ? '' : `S${i}  `
}

function colorFor(spk: string) {
  const i = spkIndex(spk)
  return i === null ? ('black' as const) : SPEAKER_COLOR[i % SPEAKER_COLOR.length]
}

export class TranscriptCanvas {
  private committedUpto = 0 // ms of session audio already on the canvas
  private liveId: TLShapeId | null = null
  private x = 0
  private nextY = 0
  private follow = true
  private active = false

  constructor(private editor: Editor) {}

  /** Place this session below anything already on the page. */
  beginSession() {
    const b = this.editor.getCurrentPageBounds()
    this.x = b ? b.minX : 0
    this.nextY = b ? b.maxY + 80 : 0
    this.committedUpto = 0
    this.liveId = null
    this.active = true
  }

  /** Leave the unsettled tail on the canvas; it is still real transcript. */
  endSession() {
    if (this.liveId) {
      this.nextY += (this.editor.getShapePageBounds(this.liveId)?.h ?? 24) + GAP
      this.liveId = null
    }
    // closing the socket doesn't stop an already-dispatched message from
    // landing, and without this it would start a second live shape
    this.active = false
  }

  setFollow(v: boolean) {
    this.follow = v
  }

  apply(turns: Turn[]) {
    if (!this.active) return
    this.editor.run(
      () => {
        for (const t of turns) {
          if (t.final && t.t1 > this.committedUpto) this.commit(t)
        }
        this.drawLive(turns.filter((t) => !t.final))
      },
      { history: 'ignore' },
    )
  }

  private commit(t: Turn) {
    const id = createShapeId(`turn-${t.id}`)
    this.committedUpto = Math.max(this.committedUpto, t.t1)
    if (this.editor.getShape(id)) return // already placed under this id

    this.editor.createShape({
      id,
      type: 'text',
      x: this.x,
      y: this.nextY,
      props: {
        richText: toRichText(label(t) + t.text),
        color: colorFor(t.spk),
        size: 's',
        font: 'sans',
        textAlign: 'start',
        autoSize: false,
        w: WIDTH,
      },
    })
    this.nextY += (this.editor.getShapePageBounds(id)?.h ?? 24) + GAP
    this.keepInView()
  }

  private drawLive(live: Turn[]) {
    const text = live.map((t) => label(t) + t.text).join('\n')
    if (!text.trim()) {
      if (this.liveId) {
        this.editor.deleteShape(this.liveId)
        this.liveId = null
      }
      return
    }
    if (!this.liveId) {
      this.liveId = createShapeId(`live-${Date.now()}`)
      this.editor.createShape({
        id: this.liveId,
        type: 'text',
        x: this.x,
        y: this.nextY,
        props: {
          richText: toRichText(text),
          color: 'grey', // grey = not yet settled, like the .dim class in the original UI
          size: 's',
          font: 'sans',
          textAlign: 'start',
          autoSize: false,
          w: WIDTH,
        },
      })
    } else {
      this.editor.updateShape({
        id: this.liveId,
        type: 'text',
        x: this.x,
        y: this.nextY,
        props: { richText: toRichText(text) },
      })
    }
  }

  /** Scroll only when the write head has fallen off the bottom of the viewport. */
  private keepInView() {
    if (!this.follow) return
    const vp = this.editor.getViewportPageBounds()
    if (this.nextY > vp.maxY - SCROLL_MARGIN || this.nextY < vp.minY) {
      this.editor.centerOnPoint({ x: this.x + WIDTH / 2, y: this.nextY })
    }
  }
}
