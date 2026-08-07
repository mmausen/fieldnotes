/** Renders the A1 interview tree onto the tldraw canvas *as it is drawn in
 * A1.tldr* -- same boxes, same text, same arrows, same layout -- then colours
 * the question boxes live from the Matcher. Nothing is an overlay; it's the real
 * A1 tree embedded on the infinite canvas.
 *
 * A1's shapes are recreated verbatim (their exact props, just translated to sit
 * left of the transcript). A question box keeps its original A1 styling until it
 * is mentioned/answered, so an untouched tree looks exactly like A1.
 */
import {
  Box,
  createShapeId,
  toRichText,
  type Editor,
  type TLShapeId,
  type TLShapePartial,
} from 'tldraw'
import a1 from './a1tree.json'
import type { Matcher } from './matcher'
import type { QState } from './types'

type Raw = {
  type: string
  x: number
  y: number
  rotation: number
  props: Record<string, unknown>
  qid?: string
}

// colour overrides applied on top of A1's own styling as a question progresses;
// `red` (unanswered) restores the box's original A1 colour/fill
const OVERRIDE: Partial<Record<QState, { color: string; fill: string }>> = {
  yellow: { color: 'yellow', fill: 'semi' },
  green: { color: 'green', fill: 'solid' },
  grey: { color: 'grey', fill: 'semi' },
  reopen: { color: 'violet', fill: 'solid' },
}

const sid = (k: string) => createShapeId(`iv-${k}`)

export class InterviewTreeCanvas {
  private built = false
  private box = new Map<string, { cx: number; cy: number; w: number; h: number }>()
  private orig = new Map<string, { color: string; fill: string }>()
  private lastState = new Map<string, QState>()
  private follow = true
  private followedQid: string | null = null

  constructor(private editor: Editor) {}

  /** When on, the camera glides to frame the current (and next) question. */
  setFollow(v: boolean) {
    this.follow = v
    this.followedQid = null // re-follow the current question next apply
  }

  isBuilt() {
    return this.built
  }

  build(matcher: Matcher) {
    this.clear()
    const m = (a1 as { meta: { minX: number; minY: number; maxX: number; maxY: number } }).meta
    const shapes = (a1 as { shapes: Raw[] }).shapes
    const b = this.editor.getCurrentPageBounds()
    // place A1's bounding box just left of whatever's already on the page
    const targetX = (b ? b.minX : 0) - (m.maxX - m.minX) - 500
    const targetY = b ? b.minY : 0
    const off = { x: targetX - m.minX, y: targetY - m.minY }

    const partials: TLShapePartial[] = []
    let i = 0
    for (const s of shapes) {
      const id = s.qid ? sid(`q-${s.qid}`) : sid(`s${i++}`)
      // A1 was authored on a newer schema; drop props this build doesn't know
      const props = { ...s.props }
      delete props.flipX
      delete props.flipY
      partials.push({
        id,
        type: s.type,
        x: s.x + off.x,
        y: s.y + off.y,
        rotation: s.rotation,
        props,
      } as TLShapePartial)
      if (s.qid) {
        const w = Number(s.props.w) || 480
        const h = Number(s.props.h) || 94
        this.box.set(s.qid, { cx: s.x + off.x + w / 2, cy: s.y + off.y + h / 2, w, h })
        this.orig.set(s.qid, {
          color: (s.props.color as string) ?? 'black',
          fill: (s.props.fill as string) ?? 'none',
        })
        this.lastState.set(s.qid, 'red')
      }
    }

    this.editor.run(
      () => {
        this.editor.createShapes(partials)
        this.editor.createShapes([
          this.textShape('current', targetX, targetY - 150, '', 'black', 'l'),
          this.textShape('notes', targetX, targetY - 90, 'Notes', 'grey', 'm'),
        ])
      },
      { history: 'ignore' },
    )

    this.built = true
    this.editor.zoomToBounds(
      new Box(targetX - 80, targetY - 200, m.maxX - m.minX + 160, m.maxY - m.minY + 320),
      { inset: 40, animation: { duration: 300 } },
    )
    this.apply(matcher)
  }

  apply(matcher: Matcher) {
    if (!this.built) return
    this.editor.run(
      () => {
        for (const q of matcher.questions) {
          if (this.lastState.get(q.id) === q.state) continue
          this.lastState.set(q.id, q.state)
          const style = OVERRIDE[q.state] ?? this.orig.get(q.id) ?? { color: 'black', fill: 'none' }
          this.editor.updateShape({
            id: sid(`q-${q.id}`),
            type: 'geo',
            props: { color: style.color, fill: style.fill },
          } as TLShapePartial)
        }
        this.ring('now', matcher.currentQid, 'solid')
        this.ring('next', matcher.nextQid, 'dashed')

        const cur = matcher.questions.find((q) => q.id === matcher.currentQid)
        this.editor.updateShape({
          id: sid('current'),
          type: 'text',
          props: { richText: toRichText(cur ? `▸ NOW  ${cur.id}  ${cur.text}` : '') },
        } as TLShapePartial)
        const lines = matcher.notes
          .slice(0, 10)
          .map((n) =>
            n.kind === 'crossref'
              ? `⤳ ${n.qid} (${n.moduleName}) — raised while in module ${n.activeModule}`
              : `↻ ${n.qid} — mentioned again`,
          )
        this.editor.updateShape({
          id: sid('notes'),
          type: 'text',
          props: { richText: toRichText(['Notes', ...lines].join('\n')) },
        } as TLShapePartial)
      },
      { history: 'ignore' },
    )

    this.followCamera(matcher.currentQid, matcher.nextQid)
  }

  /** Glide the camera to frame the current question (and its next), once per
   * new current question, at a steady zoom so it reads like a moving playhead. */
  private followCamera(currentQid: string | null, nextQid: string | null) {
    if (!this.follow || !currentQid || currentQid === this.followedQid) return
    const c = this.box.get(currentQid)
    if (!c) return
    this.followedQid = currentQid
    let minX = c.cx - c.w / 2
    let minY = c.cy - c.h / 2
    let maxX = c.cx + c.w / 2
    let maxY = c.cy + c.h / 2
    const n = nextQid ? this.box.get(nextQid) : undefined
    if (n) {
      minX = Math.min(minX, n.cx - n.w / 2)
      minY = Math.min(minY, n.cy - n.h / 2)
      maxX = Math.max(maxX, n.cx + n.w / 2)
      maxY = Math.max(maxY, n.cy + n.h / 2)
    }
    // pad to a comfortable, roughly constant window so the zoom stays steady
    const padX = 520
    const padY = 340
    const box = new Box(minX - padX, minY - padY, maxX - minX + padX * 2, maxY - minY + padY * 2)
    this.editor.zoomToBounds(box, {
      inset: 0,
      animation: { duration: 650, easing: (t) => 1 - Math.pow(1 - t, 3) },
    })
  }

  /** A rectangle highlight around the current/next question box. */
  private ring(key: string, qid: string | null, dash: string) {
    const id = sid(`ring-${key}`)
    const bx = qid ? this.box.get(qid) : undefined
    const existing = this.editor.getShape(id)
    if (!bx) {
      if (existing) this.editor.deleteShape(id)
      return
    }
    const pad = 10
    const shape = {
      id,
      type: 'geo',
      x: bx.cx - bx.w / 2 - pad,
      y: bx.cy - bx.h / 2 - pad,
      props: {
        geo: 'rectangle',
        w: bx.w + pad * 2,
        h: bx.h + pad * 2,
        color: 'black',
        fill: 'none',
        dash,
        size: 'm',
      },
    } as TLShapePartial
    if (existing) this.editor.updateShape(shape)
    else this.editor.createShape(shape)
  }

  private textShape(key: string, x: number, y: number, text: string, color: string, size: string) {
    return {
      id: sid(key),
      type: 'text',
      x,
      y,
      props: {
        richText: toRichText(text),
        color,
        size,
        font: 'sans',
        textAlign: 'start',
        autoSize: false,
        w: 900,
      },
    } as TLShapePartial
  }

  clear() {
    const ours = this.editor
      .getCurrentPageShapes()
      .filter((s) => String(s.id).includes('iv-'))
      .map((s) => s.id as TLShapeId)
    if (ours.length) this.editor.run(() => this.editor.deleteShapes(ours), { history: 'ignore' })
    this.built = false
    this.box.clear()
    this.orig.clear()
    this.lastState.clear()
  }
}
