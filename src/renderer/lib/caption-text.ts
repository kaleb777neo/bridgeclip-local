import type { CandidateEdit, EditorProject, EditorWord } from '../../shared/clip-editor'

/**
 * Real caption text for the editor preview, mirroring the engine's caption
 * pipeline: caption edits (same word count keeps timings, otherwise spread
 * over the line), hyphen-split tokens rejoined ("m" + "-aș" -> "m-aș"),
 * suppression ranges and the final cuts, then the engine's word grouping
 * (max words per group, sentence and comma breaks).
 */

const SENTENCE_END = new Set(['.', '!', '?'])
const HYPHEN_JOIN_MAX_GAP_MS = 500

export interface PreviewWord { text: string; start_ms: number; end_ms: number }
export interface PreviewGroup { words: PreviewWord[]; start_ms: number; end_ms: number }

/** Same rejoin as the engine's merge_hyphen_splits: one spoken clitic, one word. */
export function mergeHyphenSplits<T extends { text: string; start_ms: number; end_ms: number }>(words: T[]): T[] {
  const merged: T[] = []
  for (const word of words) {
    const text = word.text.replace(/\s+/g, ' ')
    const prev = merged[merged.length - 1]
    if (prev && text && (text.startsWith('-') || prev.text.endsWith('-')) && word.start_ms - prev.end_ms <= HYPHEN_JOIN_MAX_GAP_MS) {
      merged[merged.length - 1] = { ...prev, text: prev.text + text, end_ms: Math.max(prev.end_ms, word.end_ms) } as T
    } else if (text) {
      merged.push({ ...word, text } as T)
    }
  }
  return merged
}

/** The engine's caption_transcript retiming for an edited line. */
function retimed(original: EditorWord[] | undefined, lineStart: number, lineEnd: number, tokens: string[]): EditorWord[] {
  if (original && original.length === tokens.length) {
    return tokens.map((text, i) => ({ ...original[i], text }))
  }
  const start = original?.length ? original[0].start_ms : lineStart
  const end = original?.length ? original[original.length - 1].end_ms : lineEnd
  const span = Math.max(1, end - start)
  return tokens.map((text, i) => ({ text, start_ms: Math.round(start + i * span / tokens.length), end_ms: Math.round(start + (i + 1) * span / tokens.length) }))
}

/** Words the burned captions will show, in source time: edits, cuts, suppression applied. */
export function effectiveCaptionWords(project: EditorProject, candidate: CandidateEdit): EditorWord[] {
  const edits = new Map((candidate.caption_edits ?? []).map((edit) => [edit.segment, edit.text]))
  const suppressed = candidate.caption_suppression_ranges ?? []
  const inRanges = (t: number): boolean => candidate.ranges.some(([a, b]) => t >= a && t < b)
  const suppressedAt = (t: number): boolean => suppressed.some(([a, b]) => t >= a && t < b)
  const words: EditorWord[] = []
  project.transcript.forEach((line, index) => {
    let tokens: EditorWord[] | undefined
    const edit = edits.get(index)
    if (edit !== undefined) {
      const parts = edit.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
      if (!parts.length) return // An empty correction hides this line.
      tokens = retimed(line.words, line.start_ms, line.end_ms, parts)
    }
    const stream = tokens ?? line.words ?? retimed(undefined, line.start_ms, line.end_ms, line.text.split(/\s+/).filter(Boolean))
    for (const word of stream) {
      if (word.text.trim() && inRanges(word.start_ms) && !suppressedAt(word.start_ms)) {
        words.push({ text: word.text, start_ms: word.start_ms, end_ms: word.end_ms })
      }
    }
  })
  return mergeHyphenSplits(words)
}

/** The engine's _group_words: max words per group, sentence ends, commas. */
export function captionGroups(words: EditorWord[], maxPerGroup: number): PreviewGroup[] {
  const groups: PreviewGroup[] = []
  let current: EditorWord[] = []
  const push = (): void => {
    if (!current.length) return
    groups.push({ words: current, start_ms: current[0].start_ms, end_ms: current[current.length - 1].end_ms })
    current = []
  }
  for (const word of words) {
    current.push(word)
    const text = word.text.trim()
    const atLimit = current.length >= maxPerGroup
    const atSentenceEnd = Boolean(text) && SENTENCE_END.has(text[text.length - 1])
    const atComma = text.endsWith(',') && current.length >= 2
    if (atLimit || atSentenceEnd || atComma) push()
  }
  push()
  return groups
}

export type PreviewWordState = 'past' | 'active' | 'future'

export interface ActiveCaption { group: PreviewGroup; states: PreviewWordState[] }

/**
 * The caption on screen at source time `time`, matching the engine's timing:
 * a group stays up through silence until the next group begins (max 700 ms).
 * Null when the playhead is outside the cuts or in silence past the linger.
 */
export function activeCaptionAt(groups: PreviewGroup[], time: number, lingerMs = 700): ActiveCaption | null {
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    const next = groups[i + 1]
    const until = next ? next.start_ms : group.end_ms + lingerMs
    if (time >= group.start_ms && time < until) {
      const states = group.words.map((word) =>
        time >= word.end_ms ? 'past' : time >= word.start_ms ? 'active' : 'future') as PreviewWordState[]
      // Between words the active one is the last spoken, like the burn shows.
      if (!states.includes('active') && !states.includes('past')) states[0] = 'active'
      else if (!states.includes('active') && states.includes('past')) {
        const lastPast = states.lastIndexOf('past')
        if (lastPast + 1 < states.length) states[lastPast + 1] = 'active'
      }
      return { group, states }
    }
  }
  return null
}
