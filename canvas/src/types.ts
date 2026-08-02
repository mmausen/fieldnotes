/** One speaker turn as emitted by server.py's render(). */
export type Turn = {
  id: number
  spk: string // "speaker_0" .. "speaker_3", or "" when diarization is off
  text: string
  t0: number // ms into the session
  t1: number
  final: boolean
}

export type Source = 'mic' | 'sys'
