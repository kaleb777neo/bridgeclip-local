/**
 * Auto Censor's built-in profanity: the stems the one-click scan flags.
 * Matching is exact-stem plus common inflections (see censorWordHit), so
 * "fuck" catches "fucking" without dragging in "class" via the "ass" stem.
 */
export const builtinCensorWords: readonly string[] = [
  'ass', 'asshole', 'bastard', 'bitch', 'bollocks', 'bugger', 'bullshit', 'cock',
  'crap', 'crappy', 'cunt', 'damn', 'goddamn', 'dammit', 'dick', 'dickhead',
  'dildo', 'fuck', 'fucker', 'motherfucker', 'jackass', 'jerk', 'nigga', 'nigger',
  'prick', 'pussy', 'retard', 'shit', 'shitty', 'slut', 'twat', 'wanker', 'whore'
]

/** Inflections a stem also catches; mirrors CENSOR_SUFFIXES in the engine. */
const CENSOR_SUFFIXES = ['s', 'es', 'ed', 'ing', 'in', 'er', 'ers', 'y', 'ty']

/** True when a transcript token matches a censor stem (case/punctuation-insensitive). */
export function censorWordHit(token: string, stems: readonly string[]): boolean {
  const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
  if (!core) return false
  return stems.some((stem) => core === stem || (core.startsWith(stem) && CENSOR_SUFFIXES.includes(core.slice(stem.length))))
}
