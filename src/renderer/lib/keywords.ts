/** Split transcript text into plain and keyword-highlighted segments for the editor. */
export type KeywordSegment = { text: string; keyword: boolean }

const escapeRegExp = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function keywordSegments(text: string, keywords: string[] | undefined): KeywordSegment[] {
  const terms = [...new Set((keywords ?? []).map((k) => k.trim().toLowerCase()).filter((k) => k.length > 2))].sort((a, b) => b.length - a.length)
  if (!terms.length || !text) return [{ text, keyword: false }]
  const pattern = new RegExp(`\\b(${terms.map(escapeRegExp).join('|')})\\b`, 'gi')
  const out: KeywordSegment[] = []
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), keyword: false })
    out.push({ text: text.slice(at, at + match[0].length), keyword: true })
    last = at + match[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), keyword: false })
  return out
}
