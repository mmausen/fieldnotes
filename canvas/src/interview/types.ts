export type QState = 'red' | 'yellow' | 'green' | 'grey' | 'reopen'

export interface TreeQuestion {
  id: string
  text: string
  note?: string
}
export interface TreeModule {
  index: number
  name: string
  questions: TreeQuestion[]
}
export interface Tree {
  source: string
  modules: TreeModule[]
  legend: Record<string, string>
}

/** A question with live cross-referencing state. */
export interface QuestionRT extends TreeQuestion {
  module: number
  moduleName: string
  score: number // best cosine seen so far
  state: QState
  mentions: Mention[]
}

export interface Mention {
  turn: number // index of the turn that mentioned it
  score: number
  text: string
  spk: string
  crossModule: boolean // mentioned while a different module was active
}

export interface Note {
  kind: 'mentioned' | 'crossref'
  qid: string
  module: number
  moduleName: string
  activeModule: number | null
  text: string
  spk: string
  turn: number
}
