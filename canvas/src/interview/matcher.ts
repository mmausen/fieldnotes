/** Cross-references live transcript turns against the interview tree.
 *
 * Each incoming utterance is embedded and compared (cosine) to every question.
 * A question's colour is driven by the best score it has ever seen:
 *   >= GREEN  entails / answered      (green)
 *   >= YELLOW suggests / mentioned    (yellow)
 *   else      unanswered              (red)
 * grey (pruned) and reopen (contradicts) are reserved for later; the offline
 * embedding engine can't reason about them, so they're not set automatically.
 *
 * "Where we are" is the module of the most recent strong match. When a turn's
 * best match lands in a *different* module, that's logged as a cross-module
 * mention; a match on an already-mentioned question in the active module is
 * logged as an "already mentioned" note.
 */
import treeJson from './tree.json'
import { embed, cosine, warmup } from './embed'
import type { Note, QuestionRT, QState, Tree } from './types'

// Calibrated for all-MiniLM-L6-v2 cosine between an interview *answer* and a
// *question* (asymmetric, so scores run lower than statement-vs-statement). On
// the A1 tree, on-topic answers land ~0.44-0.66 and off-topic noise tops out
// ~0.25 — a clean gap. A1's 0.55/0.75 were for statement-vs-statement; these are
// the empirical Q-vs-A equivalents. Tune here if you swap the model.
export const GREEN = 0.55 // entails / answered
export const YELLOW = 0.4 // suggests / loosely mentioned

function stateFor(score: number): QState {
  if (score >= GREEN) return 'green'
  if (score >= YELLOW) return 'yellow'
  return 'red'
}

export class Matcher {
  readonly tree = treeJson as Tree
  questions: QuestionRT[] = []
  notes: Note[] = []
  activeModule: number | null = null
  currentQid: string | null = null
  nextQid: string | null = null
  ready = false

  private vecs: Float32Array[] = []
  private turnCount = 0

  constructor() {
    for (const m of this.tree.modules) {
      for (const q of m.questions) {
        this.questions.push({
          ...q,
          module: m.index,
          moduleName: m.name,
          score: 0,
          state: 'red',
          mentions: [],
        })
      }
    }
    this.recomputeNext()
  }

  /** Load + embed the model and all questions. Call once. */
  async init(onProgress?: (msg: string) => void): Promise<void> {
    onProgress?.('loading model…')
    await warmup()
    onProgress?.('embedding questions…')
    this.vecs = await embed(this.questions.map((q) => q.text))
    this.ready = true
    onProgress?.('ready')
  }

  /** Ingest one transcript turn; returns true if anything changed. */
  async ingest(text: string, spk: string): Promise<boolean> {
    if (!this.ready || !text.trim()) return false
    const turn = this.turnCount++
    const [v] = await embed([text])
    if (!v) return false

    let bestIdx = -1
    let bestScore = -1
    for (let i = 0; i < this.questions.length; i++) {
      const s = cosine(v, this.vecs[i])
      const q = this.questions[i]
      if (s > q.score) {
        q.score = s
        q.state = stateFor(s)
      }
      if (s > bestScore) {
        bestScore = s
        bestIdx = i
      }
    }
    if (bestIdx < 0 || bestScore < YELLOW) return false

    const q = this.questions[bestIdx]
    const priorMentions = q.mentions.length
    const crossModule = this.activeModule !== null && q.module !== this.activeModule

    q.mentions.push({ turn, score: bestScore, text, spk, crossModule })

    if (crossModule) {
      this.notes.unshift({
        kind: 'crossref',
        qid: q.id,
        module: q.module,
        moduleName: q.moduleName,
        activeModule: this.activeModule,
        text,
        spk,
        turn,
      })
    } else if (priorMentions > 0) {
      this.notes.unshift({
        kind: 'mentioned',
        qid: q.id,
        module: q.module,
        moduleName: q.moduleName,
        activeModule: this.activeModule,
        text,
        spk,
        turn,
      })
    }

    // "where we are": follow the topic into its module (unless this was a fleeting
    // cross-module aside — we still move, since the conversation went there)
    this.activeModule = q.module
    this.currentQid = q.id
    this.recomputeNext()
    return true
  }

  /** Next still-unanswered question in the active module, in tree order. */
  private recomputeNext() {
    const mod = this.activeModule ?? 1
    const inMod = this.questions.filter((q) => q.module === mod)
    const next = inMod.find((q) => q.state === 'red')
    this.nextQid = next ? next.id : null
  }

  /** Clear all live state for a new interview (keeps the embedded questions). */
  reset() {
    for (const q of this.questions) {
      q.score = 0
      q.state = 'red'
      q.mentions = []
    }
    this.notes = []
    this.activeModule = null
    this.currentQid = null
    this.turnCount = 0
    this.recomputeNext()
  }

  /** Manually override a question's colour (grey=prune, reopen=contradiction). */
  setState(qid: string, state: QState) {
    const q = this.questions.find((x) => x.id === qid)
    if (q) q.state = state
  }
}
