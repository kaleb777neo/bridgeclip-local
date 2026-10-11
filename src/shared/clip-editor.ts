/** Persisted source-time edits. Media paths and review results are main-process owned. */
export type Crop = [number, number, number, number]
export type CropCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export type EditorRange = [number, number]
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
export const overlayPositions: readonly OverlayPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']
/** Uploaded media reference: "<32 hex>.<ext>", resolved to a file by main. */
export function isAssetRef(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(value)
}
export interface LogoOverlay { asset: string; position: OverlayPosition; /** Fraction of output width, 0.05–0.5. */ scale: number; /** 0.1–1. */ opacity: number }
export interface MusicOverlay {
  asset: string
  /** Music level under speech, 0–1. */
  gain: number
  /** Audio fades on the looping bed, 0–5000 ms per side (absent = no fade). */
  fade_in_ms?: number
  fade_out_ms?: number
  /** Where in the track the bed starts, 0–600000 ms (absent = from the top). */
  start_ms?: number
}
export interface BRollOverlay {
  asset: string; start_ms: number; end_ms: number
  /** Framing while the insert plays: fill (default), pip (speaker in a small window over the B-roll) or split. */
  layout?: 'fill' | 'pip' | 'split'
  /** split only: stack the B-roll on top instead of the bottom. */
  swap?: boolean
}
export interface TextOverlay { text: string; start_ms: number; end_ms: number; position: OverlayPosition
  /** Lower Third preset (Name Tag / Location); absent = a plain text card. */
  preset?: string
  /** Per-box look for plain text cards; ignored by Lower Third presets. */
  style?: TextBoxStyle
  variant?: 'solid' | 'color' | 'image'
  /** Accent color for the 'color' variant, as #rrggbb. */
  color?: string
  /** Secondary line for presets that support one (a role under the name, a region under a place). */
  sub?: string
  /** Asset ref shown as the band background, for the 'image' variant. */
  image?: string }
export type LowerThirdVariant = NonNullable<TextOverlay['variant']>
export interface LowerThirdPreset { id: string; label: string; kind: 'name-tag' | 'location'; position: OverlayPosition
  sub: boolean; variants: LowerThirdVariant[]; tone: string }
/** The 12 animated Lower Third presets, mirrored by LOWER_THIRDS in the engine's rendering_service. */
export const lowerThirdPresets: LowerThirdPreset[] = [
  { id: 'name-classic', label: 'Classic bar', kind: 'name-tag', position: 'bottom-left', sub: true, variants: ['solid', 'color'], tone: '#14161c' },
  { id: 'name-accent', label: 'Accent line', kind: 'name-tag', position: 'bottom-left', sub: false, variants: ['solid', 'color'], tone: '#1a5fdf' },
  { id: 'name-side', label: 'Side tab', kind: 'name-tag', position: 'bottom-left', sub: true, variants: ['solid', 'color'], tone: '#7c3aed' },
  { id: 'name-two-line', label: 'Two line', kind: 'name-tag', position: 'bottom-left', sub: true, variants: ['solid', 'color'], tone: '#0e7a5f' },
  { id: 'name-clean', label: 'Clean', kind: 'name-tag', position: 'bottom-left', sub: false, variants: ['solid'], tone: '#ffffff' },
  { id: 'name-card', label: 'Card', kind: 'name-tag', position: 'bottom-left', sub: true, variants: ['solid', 'color', 'image'], tone: '#1c1e26' },
  { id: 'loc-pill', label: 'Pill', kind: 'location', position: 'bottom-left', sub: false, variants: ['solid', 'color'], tone: '#b3261e' },
  { id: 'loc-ticker', label: 'News ticker', kind: 'location', position: 'bottom-left', sub: false, variants: ['solid', 'color', 'image'], tone: '#111827' },
  { id: 'loc-pin', label: 'Map pin', kind: 'location', position: 'bottom-left', sub: false, variants: ['solid', 'color'], tone: '#c2410c' },
  { id: 'loc-banner', label: 'Banner', kind: 'location', position: 'center', sub: true, variants: ['solid', 'color', 'image'], tone: '#0f172a' },
  { id: 'loc-frame', label: 'Frame', kind: 'location', position: 'bottom-left', sub: false, variants: ['solid'], tone: '#e5e7eb' },
  { id: 'loc-spotlight', label: 'Spotlight', kind: 'location', position: 'bottom-left', sub: false, variants: ['solid', 'color', 'image'], tone: '#050608' }
]
export function lowerThirdPreset(id: string): LowerThirdPreset | undefined {
  return lowerThirdPresets.find((preset) => preset.id === id)
}
/** Built-in CTA badge, drawn at render time; timed like a text overlay when start/end are present. */
export interface CtaBadge { kind: 'subscribe' | 'follow'; position: OverlayPosition; start_ms?: number; end_ms?: number }
export interface CameraScan {
  start_ms: number; end_ms: number
  /** Presentation times from every decoded source frame, never a guessed FPS. */
  frames: number[]
  markers: { at_ms: number; score: number }[]
}
export interface EditorScene {
  at_ms: number; layout: 'fill' | 'split' | 'fit'; crops: Crop[]
  /** Incoming eased movement, in source milliseconds. Absent/zero is a cut. */
  transition_ms?: number
  /** How transition_ms renders: crop easing (default), crossfade, or wipe. */
  transition_kind?: 'motion' | 'dissolve' | 'wipe' | 'crossfade' | 'crosszoom' | 'zoomin' | 'zoomout' | 'fadein' | 'fadeout'
}
export interface EditorQuestion {
  id: string; prompt: string; yes: string; no: string; probability: number | null; threshold: number; status: string
}
export interface EditorReview {
  signature: string; reviewed_at: string; decision: string; questions: EditorQuestion[]
  cuts: { interval: EditorRange; questions: EditorQuestion[] }[]
}
export interface CandidateEdit {
  id: string; title: string; ranges: EditorRange[]; scenes: EditorScene[]
  captions: boolean; caption_preset: string; video_speed: number
  /** Per-clip caption customisation layered on top of the picked preset. */
  caption_style?: CaptionStyleOverrides
  status: 'refining' | 'ready' | 'baked' | 'discarded'
  caption_edits: { segment: number; text: string }[]
  /** Source-time intervals where our burned-in captions are hidden. */
  caption_suppression_ranges: EditorRange[]
  /** Scoped visual edits (grades, sharpen/soften, region blur) baked over the footage. */
  range_edits?: RangeEdit[]
  /** Voiceover Studio settings: a scratch AI voiceover previewed via the engine. */
  voiceover?: VoiceoverConfig
  /** Caption block center, as a fraction of output height. Null uses layout placement. */
  caption_y?: number | null
  /** Caption block center, as a fraction of output width. Null stays centered. */
  caption_x?: number | null
  /** Auto Reframe: speaker tracking drives scene crops. False pins the user's crops. */
  auto_reframe?: boolean
  dismissed_camera_markers?: number[]
  logo?: LogoOverlay
  /** Uploaded video prepended to the baked clip. */
  intro_asset?: string
  /** Uploaded video appended to the baked clip. */
  outro_asset?: string
  music?: MusicOverlay
  brolls?: BRollOverlay[]
  text_overlays?: TextOverlay[]
  /** Motion Studio reference assets, kept referenced so the sweep spares them between plan and generate. */
  motion_refs?: { asset: string; kind: 'image' | 'video' | 'audio' }[]
  cta_badges?: CtaBadge[]
  /** Speech/full-mix output level, 0–2. Absent is 1. */
  audio_gain?: number
  /** Speech Enhancement, baked at export (0–1, absent = off): noise removal and voice lift/clarity. */
  speech_denoise?: number
  speech_enhance?: number
  /** Auto Censor: mask these words in captions and mute/bleep them in the audio. */
  censor?: CensorConfig
}
/** How censored words are processed: caption masking style and speech handling. */
export interface CensorConfig { words: string[]; captions: 'asterisk' | 'first' | 'off'; audio: 'mute' | 'bleep' | 'off' }
/** Caption font faces shipped in engine/assets/fonts, by their engine names. */
export const CAPTION_FONT_FACES = ['Montserrat Black', 'Montserrat ExtraBold', 'Poppins Black', 'Poppins ExtraBold', 'Anton', 'Archivo Black', 'Instrument Serif Italic', 'Plus Jakarta Sans'] as const
export type CaptionFontFace = (typeof CAPTION_FONT_FACES)[number]
/** Editor caption customisation: two colour wells, font, size and case. */
export interface CaptionStyleOverrides {
  /** Text fill, #rrggbb. */
  primaryColor: string
  /** Active-word accent fill, #rrggbb. */
  highlightColor: string
  /** One of CAPTION_FONT_FACES. */
  font: string
  /** Font size multiplier on the preset's base size, 0.5–2. */
  sizeScale: number
  uppercase?: boolean
}
export interface EditorCandidate extends CandidateEdit {
  camera_scan?: CameraScan
  /** Engine-owned: 'tracked' = analyzed speaker tracking, 'centered' = analysis unavailable. */
  framing?: 'tracked' | 'centered'
  requires_visual_context?: boolean; score: number; reason: string; review: EditorReview | null; exports: number[]
  /** Main-owned: SHA-256 of the last baked render identity, so undoing "Refine again" can restore Baked. */
  baked_hash?: string
}
/** Word-level timing for transcript lines; absent on older projects. */
export interface EditorWord { start_ms: number; end_ms: number; text: string }
export interface EditorProject {
  version: 1; revision: number; title: string; duration_ms: number; width: number; height: number
  /** Main-owned media generation; absent on projects using the original source. */
  source_id?: string
  preview_id?: string
  frame_preview?: boolean
  /** A fast per-reel import kept only this source-time window as the preview; absent = whole video. */
  preview_start_ms?: number
  preview_end_ms?: number
  /** Source and preview were deleted to save space; the project is read-only. */
  media_freed?: boolean
  aspect_ratio: '9:16' | '16:9' | '1:1'; candidates: EditorCandidate[]
  transcript: { start_ms: number; end_ms: number; text: string; speaker?: string; words?: EditorWord[] }[]
  /** Display names for transcript speaker ids ("S1" → "Tanya"). */
  speaker_names?: Record<string, string>
  /** Source-level vocabulary used to highlight keywords in the transcript. */
  keywords?: string[]
}
export interface EditorProgress { phase: 'scan' | 'preview' | 'audio' | 'motion'; percent: number
  /** Download phase only: bytes moved so far, the expected total and the current rate. */
  downloadedBytes?: number; totalBytes?: number; bytesPerSecond?: number
  /** Scan phase only: the video came from the Library's own copy, not the network. */
  local?: boolean }
export type EditorOperation = 'save' | 'review' | 'export' | 'export-all' | 'replace-source' | 'scan-cameras' | 'auto-frame' | 'create-project' | 'build-preview' | 'import-audio' | 'motion-render' | 'voice-voices' | 'voice-preview'
export interface EditorBatch { completed: number; total: number; failed?: number }
export interface EditorSession {
  progress?: EditorProgress; project: EditorProject; sourcePath: string; previewPath: string
  operation?: EditorOperation | null; batch?: EditorBatch
  /** Bytes used by the editor's source and preview, freed by "Free editor media". */
  mediaBytes?: number
  /** Absolute paths for every uploaded asset referenced by the project. */
  assetPaths?: Record<string, string>
}
/** Status counts for Library and Jobs, without sending the project to the renderer. */
export interface EditorProgressSummary {
  total: number; remaining: number; initialCandidate: number
  counts: Record<CandidateEdit['status'], number>
  /** Preview frame for a run without exports; null once media is freed. */
  previewPath: string | null; thumbnailMs: number; mediaFreed: boolean
  /** The preview's source-time window (0..duration when it covers the whole video). */
  previewStartMs: number; previewEndMs: number
  operation: EditorOperation | null; batch?: EditorBatch; progress?: EditorProgress
}

/** Main's stale-revision save error. The editor offers "Reload project" for it. */
export const EDITOR_REVISION_CONFLICT = 'This project changed. Reopen it before saving.'
/** Main throws this when an automatic run's source is not a re-downloadable URL; the renderer then asks for the file. */
export const EDITOR_NEEDS_SOURCE = '__editor_needs_source__'
/** Main throws this when the original video is nowhere on this PC; the renderer asks before any download. */
export const EDITOR_NEEDS_MATERIAL = '__editor_needs_material__'

/**
 * The ask that replaces a silent multi-gigabyte download. It names the video and its
 * length, so the choice is about his file and not about a spinner.
 */
export function editorNeedsMaterial(title: string, durationSeconds: number): string {
  const minutes = Math.max(1, Math.round(durationSeconds / 60))
  return `Editing works on the full original video, not on the finished reel. "${title}" (${minutes} min) is no longer in your Library, so BridgeClip can't open it from disk.`
}
/** Fixed worker failure codes (see bridge/editor_runner.py); no tool output crosses the bridge. */
export const editorErrorCodes = ['duration', 'geometry', 'audio', 'invalid', 'project_changed', 'invalid_edit', 'not_ready',
  'source_missing', 'source_incompatible', 'render_failed', 'scan_too_long', 'review_unavailable', 'engine_unavailable',
  'cancelled', 'timeout'] as const
export type EditorErrorCode = typeof editorErrorCodes[number]
export function isEditorErrorCode(value: unknown): value is EditorErrorCode {
  return typeof value === 'string' && (editorErrorCodes as readonly string[]).includes(value)
}

export const sourceReplacementErrors: Record<string, string> = {
  duration: 'The replacement has a different duration. Choose the exact same video with the same timing.',
  geometry: 'The replacement has different framing or orientation. Choose the same video and aspect ratio.',
  audio: 'The replacement has different audio availability. Choose the same video with the same audio.',
  invalid: 'Could not read the replacement video. Choose a playable video file.'
}

const logs = 'Details are in Help → Show Logs.'
const common: Partial<Record<EditorErrorCode, string>> = {
  project_changed: 'This project changed. Reopen the editor and try again.',
  source_missing: "The editor's source video is missing. Use Replace source with the original video, then try again.",
  source_incompatible: "FFmpeg could not read the editor's source video. Use Replace source with a playable copy of the same video.",
  engine_unavailable: 'The video engine could not start. Open Settings and run System check.'
}
/** A user-facing message for a failed editor worker. Only render setup problems point to System check. */
export function editorFailureMessage(action: Exclude<EditorOperation, 'save'>, code?: EditorErrorCode): string {
  if (action === 'create-project') {
    return code === 'source_missing' ? 'The original video could not be re-downloaded. Choose its file to make these clips editable.'
      : code === 'cancelled' ? 'Preparing the editable copy was cancelled.'
      : code === 'timeout' ? 'Preparing the editable copy took too long and was stopped. Try again.'
      : code === 'render_failed' ? `Could not build a preview from the original video. Try reconnecting it with a playable copy. ${logs}`
      : code && common[code] ? common[code]!
      : `Could not prepare the editable copy. Try again. ${logs}`
  }
  if (action === 'replace-source') {
    if (code && Object.hasOwn(sourceReplacementErrors, code)) return sourceReplacementErrors[code]
    return code === 'cancelled' ? 'Source replacement cancelled. The previous source is still in use.'
      : code === 'timeout' ? 'Source replacement took too long and was stopped. The previous source is still in use.'
      : code === 'render_failed' ? `Could not prepare a preview from the replacement video. The previous source is still in use. ${logs}`
      : code && common[code] ? common[code]!
      : 'Source replacement stopped or failed. Reopen the editor to check its current source, then try again.'
  }
  if (action === 'build-preview') {
    return code === 'cancelled' ? 'Preparing the full preview was cancelled. Your edits are saved.'
      : code === 'timeout' ? 'Preparing the full preview took too long and was stopped. Your edits are saved. Try again.'
      : code && common[code] ? `${common[code]} Your edits are saved.`
      : 'Preparing the full preview stopped or failed. Your edits are saved. Try again.'
  }
  if (action === 'scan-cameras') {
    return code === 'scan_too_long' ? 'This clip is too long to scan for camera changes. Try scanning a shorter clip. Your edits and previous markers are saved.'
      : code === 'cancelled' ? 'Camera scan cancelled. Your edits and previous markers are saved.'
      : code && common[code] ? `${common[code]} Your edits and previous markers are saved.`
      : 'Camera scan stopped or failed. Your edits and previous markers are saved. Try scanning a shorter clip.'
  }
  if (action === 'voice-voices' || action === 'voice-preview') {
    return code === 'cancelled' ? 'Voice preview cancelled.'
      : code === 'timeout' ? 'The voice preview took too long and was stopped. Try a shorter script.'
      : code === 'invalid' ? 'Voice preview needs Windows with at least one installed voice.'
      : code === 'render_failed' ? `Could not synthesize the voice preview. Try again. ${logs}`
      : `Could not run the voice preview. Try again. ${logs}`
  }
  if (action === 'motion-render') {
    return code === 'cancelled' ? 'Motion clip generation was cancelled.'
      : code === 'timeout' ? 'Rendering the motion clip took too long and was stopped. Try a shorter plan.'
      : code === 'invalid' ? 'The shot plan could not be rendered. Review the shots and try again.'
      : code === 'source_missing' ? 'A shot references a file that is no longer in this project. Re-add it and try again.'
      : code === 'render_failed' ? `Could not render the motion clip. Try fewer shots or shorter durations. ${logs}`
      : code && common[code] ? common[code]!
      : `Could not render the motion clip. Try again. ${logs}`
  }
  if (action === 'import-audio') {
    return code === 'cancelled' ? 'Audio import was cancelled.'
      : code === 'timeout' ? 'Audio import took too long and was stopped. Try again.'
      : code === 'source_missing' ? 'The link could not be downloaded as audio. Check the link, or pick the file instead.'
      : code === 'invalid' ? 'That file or link has no usable audio, or it is longer than an hour.'
      : code === 'render_failed' ? `Could not extract the audio from that file. Try a different file or link. ${logs}`
      : code && common[code] ? common[code]!
      : `Could not import the audio. Try again. ${logs}`
  }
  if (action === 'auto-frame') {
    return code === 'cancelled' ? 'Auto-frame was cancelled. Your cuts, captions and layouts are saved.'
      : code && common[code] ? `${common[code]} Your cuts, captions and layouts are saved.`
      : 'Auto-frame stopped or failed. Your cuts, captions and layouts are saved. Try again.'
  }
  if (action === 'review') {
    return code === 'review_unavailable' ? 'Jev could not review this edit. Check your OpenRouter key and connection, then try again. Your previous review is preserved.'
      : code === 'cancelled' ? 'Review cancelled. Your previous review is preserved.'
      : code && common[code] ? `${common[code]} Your previous review is preserved.`
      : 'Review stopped or failed. Your previous review is preserved. Try again.'
  }
  return code === 'render_failed' ? `Rendering failed. Your edits are saved. Try again, or simplify this clip's layouts. ${logs}`
    : code === 'invalid_edit' ? "This clip has an edit that can't be rendered. Check its cuts, layouts and captions, then try again."
    : code === 'not_ready' ? 'Mark this clip ready before baking it.'
    : code === 'timeout' ? 'Rendering took too long and was stopped. Your edits are saved.'
    : code === 'cancelled' ? 'Export cancelled.'
    : code && common[code] ? common[code]!
    : `Export stopped or failed. Your edits are saved. Try again. ${logs}`
}

export function editorProgress(candidates: Pick<CandidateEdit, 'status'>[]): { remaining: number; initialCandidate: number } {
  const unfinished = (c: Pick<CandidateEdit, 'status'>): boolean => c.status !== 'baked' && c.status !== 'discarded'
  const first = candidates.findIndex(unfinished)
  return { remaining: candidates.filter(unfinished).length,
    initialCandidate: Math.max(0, first >= 0 ? first : candidates.findIndex((c) => c.status === 'baked')) }
}

/** Candidate index the editor opens on: a focused clip's candidate, else the first unfinished one. */
export function startingCandidate(candidates: EditorCandidate[], focusCandidateId?: string | null): number {
  if (focusCandidateId != null) {
    const focused = candidates.findIndex((c) => c.id === focusCandidateId)
    if (focused >= 0) return focused
  }
  return editorProgress(candidates).initialCandidate
}

/** The preview's source-time window, or null when it covers the whole video. */
export function previewWindow(project: Pick<EditorProject, 'preview_start_ms' | 'preview_end_ms' | 'duration_ms'>): { startMs: number; endMs: number } | null {
  if (project.preview_start_ms === undefined || project.preview_end_ms === undefined) return null
  if (project.preview_start_ms <= 0 && project.preview_end_ms >= project.duration_ms) return null
  return { startMs: project.preview_start_ms, endMs: project.preview_end_ms }
}

/** True when a reel's whole cut can play from the preview (a fast import previews only a window). */
export function previewCoversReel(ranges: EditorRange[], window: { startMs: number; endMs: number } | null): boolean {
  if (!window || !ranges.length) return true
  return ranges[0][0] >= window.startMs - 1 && ranges[ranges.length - 1][1] <= window.endMs + 1
}

/** Speaker id active at a source time, when the transcript labels one. */
export function speakerAt(transcript: EditorProject['transcript'], time: number): string | undefined {
  return transcript.find((r) => time >= r.start_ms && time < r.end_ms)?.speaker
}

/**
 * Remove `[cutStart, cutEnd)` from a clip's kept ranges (the text-driven cut).
 * Leftover slivers under `minPiece` ms are absorbed into the cut — the project
 * parser rejects shorter sections. Throws when the clip would become empty or
 * exceed `maxPieces` sections; the caller shows the message and keeps the edit.
 */
export function cutRanges(ranges: EditorRange[], cutStart: number, cutEnd: number,
  opts?: { minPiece?: number; maxPieces?: number }): EditorRange[] {
  const min = opts?.minPiece ?? 100, max = opts?.maxPieces ?? 24
  if (!(cutEnd > cutStart)) return ranges
  const next: EditorRange[] = []
  for (const [a, b] of ranges) {
    if (b <= cutStart || a >= cutEnd) { next.push([a, b]); continue }
    if (a < cutStart && cutStart - a >= min) next.push([a, cutStart])
    if (b > cutEnd && b - cutEnd >= min) next.push([cutEnd, b])
  }
  if (!next.length) throw new Error('This clip cannot become empty. Keep at least one section.')
  if (next.length > max) throw new Error(`This clip can hold at most ${max} sections. Split the deletion into smaller steps.`)
  return next
}

/** Re-insert a cut `[start, end)` span, skipping any part already covered by the clip. */
export function restoreRange(ranges: EditorRange[], start: number, end: number, duration: number): EditorRange[] {
  const s = Math.max(0, Math.min(start, duration)), e = Math.max(0, Math.min(end, duration))
  if (e - s < 100) return ranges
  const pieces: EditorRange[] = []
  let cursor = s
  for (const [a, b] of ranges) {
    if (b <= cursor) continue
    if (a >= e) break
    if (a > cursor && Math.min(a, e) - cursor >= 100) pieces.push([cursor, Math.min(a, e)])
    cursor = Math.max(cursor, b)
    if (cursor >= e) break
  }
  if (cursor < e && e - cursor >= 100) pieces.push([cursor, e])
  if (!pieces.length) return ranges
  const merged: EditorRange[] = []
  for (const [a, b] of [...ranges, ...pieces].sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

/** Visual state of a transcript line against the clip's kept ranges. */
export function lineCutState(line: { start_ms: number; end_ms: number }, ranges: EditorRange[]): 'kept' | 'partial' | 'cut' {
  let overlap = 0
  for (const [a, b] of ranges) overlap += Math.max(0, Math.min(b, line.end_ms) - Math.max(a, line.start_ms))
  if (overlap <= 0) return 'cut'
  return overlap >= line.end_ms - line.start_ms ? 'kept' : 'partial'
}

/** A word no longer sits inside any kept section. */
export function wordIsCut(word: EditorWord, ranges: EditorRange[]): boolean {
  return !ranges.some(([a, b]) => a <= word.start_ms && word.end_ms <= b)
}

const wordsText = (words: EditorWord[], ranges: EditorRange[]): string =>
  words.filter((w) => !wordIsCut(w, ranges)).map((w) => w.text).join(' ')

/**
 * Cut the word span `from..to` (inclusive) from a transcript line: subtracts the
 * span from the kept ranges and, so burned captions stay correct, rewrites the
 * line's caption edit to the kept words. A fully cut line drops its caption edit
 * (its text can never render inside the clip); a custom edit survives a cut that
 * changed only timing.
 */
export function cutWords(ranges: EditorRange[], captionEdits: CandidateEdit['caption_edits'],
  segment: number, words: EditorWord[], from: number, to: number): { ranges: EditorRange[]; caption_edits: CandidateEdit['caption_edits'] } {
  const a = Math.max(0, words[from]?.start_ms ?? 0), b = Math.max(a, words[to]?.end_ms ?? a)
  const next = cutRanges(ranges, a, b)
  const text = wordsText(words, next)
  const original = words.map((w) => w.text).join(' ')
  const current = captionEdits.find((e) => e.segment === segment)
  let caption_edits = captionEdits.filter((e) => e.segment !== segment)
  if (text && text !== original) caption_edits = [...caption_edits, { segment, text }].sort((x, y) => x.segment - y.segment)
  else if (text && current) caption_edits = [...caption_edits, current]
  return { ranges: next, caption_edits }
}

/**
 * Undo a word cut: re-inserts the line's full word span and removes the caption
 * edit only when it is still the auto-generated kept text this feature wrote —
 * a manually corrected caption is left alone.
 */
export function restoreWords(ranges: EditorRange[], captionEdits: CandidateEdit['caption_edits'],
  segment: number, words: EditorWord[], duration: number): { ranges: EditorRange[]; caption_edits: CandidateEdit['caption_edits'] } {
  const first = words[0], last = words[words.length - 1]
  if (!first || !last) return { ranges, caption_edits: captionEdits }
  const next = restoreRange(ranges, first.start_ms, last.end_ms, duration)
  if (next === ranges) return { ranges, caption_edits: captionEdits }
  const before = wordsText(words, ranges)
  const original = words.map((w) => w.text).join(' ')
  const caption_edits = captionEdits.filter((e) => !(e.segment === segment && e.text === before && before !== original))
  return { ranges: next, caption_edits }
}


const byteText = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
/**
 * Waiting-screen copy for the editor import: real download bytes and rate while
 * re-attaching the source, then the preview transcode's percent. `percent` is
 * null when no numeric progress is known yet (indeterminate).
 */
export function editorImportStatus(progress?: EditorProgress | null): { label: string; percent: number | null } {
  if (!progress) return { label: 'Preparing an editable copy from the original video…', percent: null }
  if (progress.phase === 'preview') return { label: `Preparing the editable preview · ${progress.percent}%`, percent: progress.percent }
  const parts = [progress.local ? 'Restoring the original video from your Library' : 'Downloading the original video']
  let percent: number | null = progress.percent
  if (progress.downloadedBytes != null && progress.totalBytes) {
    parts.push(`${byteText(progress.downloadedBytes)} of ${byteText(progress.totalBytes)}`)
    percent = Math.max(0, Math.min(100, Math.floor(progress.downloadedBytes / progress.totalBytes * 100)))
  }
  if (progress.bytesPerSecond) parts.push(`${byteText(progress.bytesPerSecond)}/s`)
  return { label: parts.join(' · '), percent }
}

/**
 * Cancelling an import can land after minutes of downloading, so say how far the
 * original video actually got instead of leaving a bare "cancelled".
 */
export function importCancelledMessage(progress?: EditorProgress | null): string {
  const cancelled = editorFailureMessage('create-project', 'cancelled')
  const { downloadedBytes, totalBytes } = progress ?? {}
  if (downloadedBytes == null || !totalBytes) return cancelled
  return `${cancelled} ${byteText(downloadedBytes)} of ${byteText(totalBytes)} of the original video were downloaded before it stopped.`
}

const fail = (): never => { throw new Error('Invalid editor project') }
const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail()
const num = (x: unknown, lo: number, hi: number): number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : fail()
const str = (x: unknown, max: number): string => typeof x === 'string' && x.length <= max ? x : fail()
const hexColor = (x: unknown): string => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x) ? x : fail()
/** Strict caption style overrides; rejects anything the engine would not render. */
export function parseCaptionStyle(v: unknown): CaptionStyleOverrides {
  const o = record(v)
  const primaryColor = hexColor(o.primaryColor), highlightColor = hexColor(o.highlightColor)
  if (!(CAPTION_FONT_FACES as readonly string[]).includes(o.font as string)) fail()
  const sizeScale = num(o.sizeScale, .5, 2)
  const uppercase = o.uppercase === undefined ? undefined : typeof o.uppercase === 'boolean' ? o.uppercase : fail()
  return { primaryColor, highlightColor, font: o.font as string, sizeScale, ...(uppercase === undefined ? {} : { uppercase }) }
}
/** Display text: clamp to `max` UTF-16 units without splitting a surrogate pair, never reject for length. */
export function clampText(x: unknown, max: number): string {
  if (typeof x !== 'string') return fail()
  if (x.length <= max) return x
  const end = /[\uD800-\uDBFF]/.test(x[max - 1] ?? '') ? max - 1 : max
  return x.slice(0, end)
}
const arr = (x: unknown, max: number): unknown[] => Array.isArray(x) && x.length <= max ? x : fail()
const position = (x: unknown): OverlayPosition => { if (!overlayPositions.includes(x as OverlayPosition)) fail(); return x as OverlayPosition }
/** The catalog entry for a Lower Third preset id; anything else fails the parse (see `position`). */
const lowerThirdOf = (x: unknown): LowerThirdPreset => {
  const match = typeof x === 'string' ? lowerThirdPresets.find((p) => p.id === x) : undefined
  if (!match) fail()
  return match as LowerThirdPreset
}
const asset = (x: unknown): string => { if (!isAssetRef(x)) fail(); return x as string }
const timeRange = (value: unknown, duration: number): [number, number] => {
  const a = arr(value, 2); if (a.length !== 2) fail()
  const s = Math.round(num(a[0], 0, duration)), e = Math.round(num(a[1], 0, duration))
  if (e - s < 100) fail()
  return [s, e]
}
/** Display names for transcript speaker ids ("S1" → "Tanya"). */
export function parseSpeakerNames(value: unknown): Record<string, string> {
  const entries = Object.entries(record(value))
  if (entries.length > 16 || entries.some(([id, name]) => !id || id.length > 16 || typeof name !== 'string' || !name.trim() || name.length > 40)) fail()
  return Object.fromEntries(entries.filter(([, name]) => (name as string).trim()).map(([id, name]) => [id, (name as string).trim()]))
}
export function parseCandidateEdit(value: unknown, duration: number, transcriptCount = 100000): CandidateEdit {
  const v = record(value)
  const ranges = arr(v.ranges, 24).map((r) => {
    const a = arr(r, 2); if (a.length !== 2) fail()
    return [Math.round(num(a[0], 0, duration)), Math.round(num(a[1], 0, duration))] as EditorRange
  })
  if (!ranges.length || ranges.some(([a, b], i) => b - a < 100 || (i > 0 && a < ranges[i - 1][1]))) fail()
  const scenes = arr(v.scenes, 60).map((s): EditorScene => {
    const x = record(s)
    if (!['fill', 'split', 'fit'].includes(x.layout as string)) fail()
    const crops = arr(x.crops, 2).map((r): Crop => {
      const c = arr(r, 4).map((n) => num(n, 0, 1))
      if (c.length !== 4 || c[2] < .01 || c[3] < .01 || c[0] + c[2] > 1.000001 || c[1] + c[3] > 1.000001) fail()
      return c as Crop
    })
    if (crops.length !== (x.layout === 'split' ? 2 : 1)) fail()
    const transition = x.transition_ms === undefined ? 0 : num(x.transition_ms, 0, 5000)
    if (transition > 0 && (transition < 100 || !Number.isInteger(transition))) fail()
    let kind: EditorScene['transition_kind'] | undefined
    if (transition > 0 && x.transition_kind !== undefined) {
      if (!['motion', 'dissolve', 'wipe', 'crossfade', 'crosszoom', 'zoomin', 'zoomout', 'fadein', 'fadeout'].includes(x.transition_kind as string)) fail()
      kind = x.transition_kind === 'motion' ? undefined : x.transition_kind as EditorScene['transition_kind']
    }
    return { at_ms: num(x.at_ms, 0, duration), layout: x.layout as EditorScene['layout'], crops,
      ...(transition ? { transition_ms: transition } : {}), ...(kind ? { transition_kind: kind } : {}) }
  })
  if (!scenes.length || scenes[0].at_ms !== 0 || scenes.some((s, i) => i > 0 && s.at_ms <= scenes[i - 1].at_ms)) fail()
  if (scenes.some((s, i) => s.transition_ms && !canAnimateScene(scenes, i))) fail()
  const id = str(v.id, 64); if (!/^[a-zA-Z0-9_-]+$/.test(id)) fail()
  const title = clampText(v.title, 200); if (!title.trim()) fail()
  const caption_preset = str(v.caption_preset, 64); if (!/^[a-z0-9_-]+$/i.test(caption_preset)) fail()
  const caption_style = v.caption_style === undefined ? undefined : parseCaptionStyle(v.caption_style)
  if (typeof v.captions !== 'boolean') fail()
  const status = v.status === undefined ? 'refining' : v.status
  if (!['refining', 'ready', 'baked', 'discarded'].includes(status as string)) fail()
  const seen = new Set<number>()
  const caption_edits = arr(v.caption_edits === undefined ? [] : v.caption_edits, 2000).map((item) => {
    const edit = record(item), segment = num(edit.segment, 0, transcriptCount - 1), text = str(edit.text, 2000)
    if (!Number.isInteger(segment) || seen.has(segment) || [...text].some((char) => char.charCodeAt(0) < 32 && !'\t\n\r'.includes(char))) fail()
    seen.add(segment)
    return { segment, text }
  }).sort((a, b) => a.segment - b.segment)
  const caption_suppression_ranges = arr(v.caption_suppression_ranges === undefined ? [] : v.caption_suppression_ranges, 200).map((r) => {
    const a = arr(r, 2); if (a.length !== 2) fail()
    return [Math.round(num(a[0], 0, duration)), Math.round(num(a[1], 0, duration))] as EditorRange
  })
  if (caption_suppression_ranges.some(([a, b], i) => b - a < 100 || (i > 0 && a < caption_suppression_ranges[i - 1][1]))) fail()
  let logo: LogoOverlay | undefined
  if (v.logo !== undefined) {
    const o = record(v.logo)
    logo = { asset: asset(o.asset), position: position(o.position), scale: num(o.scale, .05, .5), opacity: num(o.opacity, .1, 1) }
  }
  let music: MusicOverlay | undefined
  if (v.music !== undefined) {
    const o = record(v.music)
    music = { asset: asset(o.asset), gain: num(o.gain, 0, 1) }
    if (o.fade_in_ms !== undefined) music.fade_in_ms = num(o.fade_in_ms, 0, 5000)
    if (o.fade_out_ms !== undefined) music.fade_out_ms = num(o.fade_out_ms, 0, 5000)
    if (o.start_ms !== undefined) music.start_ms = num(o.start_ms, 0, 600000)
  }
  let brolls: BRollOverlay[] | undefined
  if (v.brolls !== undefined) {
    const list = arr(v.brolls, 24).map((b) => {
      const o = record(b), [start_ms, end_ms] = timeRange([o.start_ms, o.end_ms], duration)
      const broll: BRollOverlay = { asset: asset(o.asset), start_ms, end_ms }
      if (o.layout !== undefined && o.layout !== 'fill' && o.layout !== 'pip' && o.layout !== 'split') fail()
      if (o.layout === 'pip' || o.layout === 'split') broll.layout = o.layout
      if (o.swap !== undefined && (o.layout !== 'split' || o.swap !== true)) fail()
      if (o.layout === 'split' && o.swap === true) broll.swap = true
      return broll
    }).sort((a, b) => a.start_ms - b.start_ms)
    if (list.some((b, i) => i > 0 && b.start_ms < list[i - 1].end_ms)) fail()
    brolls = list
  }
  let text_overlays: TextOverlay[] | undefined
  if (v.text_overlays !== undefined) {
    text_overlays = arr(v.text_overlays, 20).map((t) => {
      const o = record(t), [start_ms, end_ms] = timeRange([o.start_ms, o.end_ms], duration)
      const text = clampText(o.text, 120)
      if (!text.trim() || [...text].some((char) => char.charCodeAt(0) < 32 && !'\n'.includes(char))) fail()
      const overlay: TextOverlay = { text, start_ms, end_ms, position: position(o.position) }
      if (o.preset !== undefined) {
        const preset = lowerThirdOf(o.preset)
        overlay.preset = preset.id
        if (o.variant !== undefined && o.variant !== 'solid' && o.variant !== 'color' && o.variant !== 'image') fail()
        overlay.variant = (o.variant as LowerThirdVariant | undefined) ?? 'solid'
        if (o.sub !== undefined) {
          const sub = clampText(o.sub, 120)
          if (!sub.trim() || [...sub].some((char) => char.charCodeAt(0) < 32 && !'\n'.includes(char))) fail()
          overlay.sub = sub
        }
        if (o.color !== undefined) {
          const color = o.color
          if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) fail()
          else overlay.color = color
        }
        if (o.image !== undefined) overlay.image = asset(o.image)
      }
      if (o.style !== undefined) overlay.style = parseTextBoxStyle(o.style)
      return overlay
    }).sort((a, b) => a.start_ms - b.start_ms)
  }
  let motion_refs: { asset: string; kind: 'image' | 'video' | 'audio' }[] | undefined
  if (v.motion_refs !== undefined) {
    motion_refs = arr(v.motion_refs, 50).map((r) => {
      const o = record(r)
      const kind = o.kind === 'image' || o.kind === 'video' || o.kind === 'audio' ? o.kind : fail()
      return { asset: asset(o.asset), kind }
    })
  }
  let cta_badges: CtaBadge[] | undefined
  if (v.cta_badges !== undefined) {
    cta_badges = arr(v.cta_badges, 10).map((b): CtaBadge => {
      const o = record(b)
      const kind = o.kind === 'subscribe' || o.kind === 'follow' ? o.kind : fail()
      const badge: CtaBadge = { kind, position: position(o.position) }
      if (o.start_ms !== undefined || o.end_ms !== undefined) {
        const [start_ms, end_ms] = timeRange([o.start_ms, o.end_ms], duration)
        badge.start_ms = start_ms; badge.end_ms = end_ms
      }
      return badge
    })
  }
  return { id, title, ranges, scenes, captions: v.captions as boolean, caption_preset, video_speed: num(v.video_speed, 1, 2),
    ...(caption_style ? { caption_style } : {}),
    status: status as CandidateEdit['status'], caption_edits, caption_suppression_ranges,
    caption_y: v.caption_y == null ? null : num(v.caption_y, .1, .9),
    caption_x: v.caption_x == null ? null : num(v.caption_x, .1, .9),
    auto_reframe: v.auto_reframe === undefined ? undefined : v.auto_reframe === true ? true : v.auto_reframe === false ? false : fail(),
    ...(v.dismissed_camera_markers === undefined ? {} : { dismissed_camera_markers: [...new Set(arr(v.dismissed_camera_markers, 5000).map((t) => num(t, 0, duration)))].sort((a, b) => a - b) }),
    ...(logo ? { logo } : {}), ...(v.intro_asset === undefined ? {} : { intro_asset: asset(v.intro_asset) }),
    ...(v.outro_asset === undefined ? {} : { outro_asset: asset(v.outro_asset) }),
    ...(music ? { music } : {}), ...(brolls ? { brolls } : {}), ...(text_overlays ? { text_overlays } : {}),
    ...(motion_refs ? { motion_refs } : {}),
    ...(cta_badges?.length ? { cta_badges } : {}),
    ...(v.range_edits === undefined ? {} : { range_edits: parseRangeEdits(v.range_edits, duration) }),
    ...(v.voiceover === undefined ? {} : { voiceover: parseVoiceoverConfig(v.voiceover) }),
    ...(v.audio_gain === undefined ? {} : { audio_gain: num(v.audio_gain, 0, 2) }),
    ...(v.speech_denoise === undefined ? {} : { speech_denoise: num(v.speech_denoise, 0, 1) }),
    ...(v.speech_enhance === undefined ? {} : { speech_enhance: num(v.speech_enhance, 0, 1) }),
    ...(v.censor === undefined ? {} : { censor: parseCensor(v.censor) }) }
}
function parseCensor(value: unknown): CensorConfig {
  const v = record(value)
  const words = [...new Set(arr(v.words, 200).map((w) => str(w, 40).trim().toLowerCase()).filter((w) => w.length > 0))]
  if (!words.length) fail()
  const captions = v.captions === 'asterisk' || v.captions === 'first' || v.captions === 'off' ? v.captions : fail()
  const audio = v.audio === 'mute' || v.audio === 'bleep' || v.audio === 'off' ? v.audio : fail()
  if (captions === 'off' && audio === 'off') fail()
  return { words, captions, audio }
}
function question(value: unknown): EditorQuestion {
  const v = record(value)
  return { id: str(v.id, 64), prompt: clampText(v.prompt, 4000), yes: clampText(v.yes, 4000), no: clampText(v.no, 4000),
    probability: v.probability === null ? null : num(v.probability, 0, 1), threshold: num(v.threshold, 0, 1), status: str(v.status, 64) }
}
export function parseEditorProject(value: unknown): EditorProject {
  const v = record(value)
  if (v.source_id !== undefined && (typeof v.source_id !== 'string' || !/^[a-f0-9]{32}$/.test(v.source_id))) fail()
  if (v.preview_id !== undefined && (typeof v.preview_id !== 'string' || !/^[a-f0-9]{32}$/.test(v.preview_id))) fail()
  if (v.version !== 1 || !['9:16', '16:9', '1:1'].includes(v.aspect_ratio as string)) fail()
  const duration = num(v.duration_ms, 100, 24 * 3600000)
  // A fast per-reel import's window: both edges together, inside the source.
  let preview_start_ms: number | undefined, preview_end_ms: number | undefined
  if (v.preview_start_ms !== undefined || v.preview_end_ms !== undefined) {
    preview_start_ms = num(v.preview_start_ms, 0, duration)
    preview_end_ms = num(v.preview_end_ms, preview_start_ms, duration)
    if (preview_end_ms - preview_start_ms < 100) fail()
  }
  const transcript = arr(v.transcript, 100000).map((row) => {
    const t = record(row)
    return { start_ms: num(t.start_ms, 0, duration), end_ms: num(t.end_ms, 0, duration), text: clampText(t.text, 20000),
      ...(typeof t.speaker === 'string' && t.speaker ? { speaker: str(t.speaker, 16) } : {}),
      ...(t.words === undefined ? {} : { words: arr(t.words, 400).map((w) => {
        const x = record(w), s = num(x.start_ms, 0, duration), e = num(x.end_ms, 0, duration)
        if (e < s) fail()
        return { start_ms: s, end_ms: e, text: clampText(x.text, 64) }
      }) }) }
  })
  let speaker_names: Record<string, string> | undefined
  if (v.speaker_names !== undefined) speaker_names = parseSpeakerNames(v.speaker_names)
  let keywords: string[] | undefined
  if (v.keywords !== undefined) {
    keywords = arr(v.keywords, 60).map((k) => str(k, 40).trim().toLowerCase()).filter(Boolean)
  }
  const ids = new Set<string>()
  const candidates = arr(v.candidates, 100).map((item): EditorCandidate => {
    const c = record(item), edit = parseCandidateEdit(c, duration, transcript.length)
    if (ids.has(edit.id)) fail(); ids.add(edit.id)
    let review: EditorReview | null = null
    if (c.review) {
      const r = record(c.review)
      review = { signature: str(r.signature, 200000), reviewed_at: str(r.reviewed_at, 64), decision: str(r.decision, 64),
        questions: arr(r.questions, 32).map(question), cuts: arr(r.cuts, 24).map((cut) => {
          const x = record(cut), t = arr(x.interval, 2)
          if (t.length !== 2) fail()
          return { interval: [num(t[0], 0, duration), num(t[1], 0, duration)], questions: arr(x.questions, 16).map(question) }
        }) }
    }
    let camera_scan: CameraScan | undefined
    if (c.camera_scan !== undefined) {
      const scan = record(c.camera_scan), start_ms = num(scan.start_ms, 0, duration), end_ms = num(scan.end_ms, start_ms, duration)
      const frames = arr(scan.frames, 120000).map((t) => num(t, start_ms, end_ms))
      if (!frames.length || frames.some((t, i) => i > 0 && t <= frames[i - 1])) fail()
      const times = new Set(frames)
      const markers = arr(scan.markers, 5000).map((m) => { const x = record(m); return { at_ms: num(x.at_ms, start_ms, end_ms), score: num(x.score, 0, 1) } })
      if (markers.some((m, i) => !times.has(m.at_ms) || (i > 0 && m.at_ms <= markers[i - 1].at_ms))) fail()
      camera_scan = { start_ms, end_ms, frames, markers }
    }
    const baked_hash = typeof c.baked_hash === 'string' && /^[a-f0-9]{64}$/.test(c.baked_hash) ? c.baked_hash : undefined
    const framing = c.framing === 'tracked' || c.framing === 'centered' ? c.framing : undefined
    return { ...edit, ...(camera_scan ? { camera_scan } : {}), ...(baked_hash ? { baked_hash } : {}), ...(framing ? { framing } : {}), requires_visual_context: c.requires_visual_context === true, score: num(c.score, 0, 100), reason: clampText(c.reason, 4000), review,
      exports: arr(c.exports, 1000).map((n) => num(n, 0, 999)) }
  })
  if (!candidates.length) fail()
  return { version: 1, revision: num(v.revision, 0, Number.MAX_SAFE_INTEGER), title: clampText(v.title, 1024), duration_ms: duration,
    width: num(v.width, 2, 16384), height: num(v.height, 2, 16384), aspect_ratio: v.aspect_ratio as EditorProject['aspect_ratio'], candidates,
    transcript, ...(v.preview_id ? { preview_id: v.preview_id as string } : {}), ...(v.frame_preview === true ? { frame_preview: true } : {}), ...(v.media_freed === true ? { media_freed: true } : {}), ...(v.source_id ? { source_id: v.source_id as string } : {}),
    ...(preview_start_ms !== undefined && preview_end_ms !== undefined ? { preview_start_ms, preview_end_ms } : {}),
    ...(speaker_names ? { speaker_names } : {}), ...(keywords?.length ? { keywords } : {}) }
}
/** Every uploaded asset the project references; main keeps these files on sweep and resolves them for preview. */
export function assetRefs(project: EditorProject): string[] {
  const refs = new Set<string>()
  for (const c of project.candidates) {
    if (c.logo) refs.add(c.logo.asset)
    if (c.intro_asset) refs.add(c.intro_asset)
    if (c.outro_asset) refs.add(c.outro_asset)
    if (c.music) refs.add(c.music.asset)
    for (const b of c.brolls ?? []) refs.add(b.asset)
    for (const o of c.text_overlays ?? []) if (o.image) refs.add(o.image)
    for (const r of c.motion_refs ?? []) refs.add(r.asset)
    if (c.voiceover?.audio_asset) refs.add(c.voiceover.audio_asset)
  }
  return [...refs]
}
export function candidateEdit(c: CandidateEdit): CandidateEdit {
  const { id, title, ranges, scenes, captions, caption_preset, caption_style, video_speed, status, caption_edits, caption_suppression_ranges = [], dismissed_camera_markers,
    logo, intro_asset, outro_asset, music, brolls, text_overlays, motion_refs, range_edits, voiceover, cta_badges, audio_gain, speech_denoise, speech_enhance, censor } = c
  return { id, title, ranges, scenes, captions, caption_preset, ...(caption_style ? { caption_style } : {}), video_speed, status, caption_edits, caption_suppression_ranges, caption_y: c.caption_y ?? null, caption_x: c.caption_x ?? null, ...(c.auto_reframe === undefined ? {} : { auto_reframe: c.auto_reframe }), ...(dismissed_camera_markers ? { dismissed_camera_markers } : {}),
    ...(logo ? { logo } : {}), ...(intro_asset ? { intro_asset } : {}), ...(outro_asset ? { outro_asset } : {}), ...(music ? { music } : {}), ...(brolls ? { brolls } : {}),
    ...(text_overlays ? { text_overlays } : {}), ...(motion_refs ? { motion_refs } : {}), ...(cta_badges?.length ? { cta_badges } : {}), ...(audio_gain === undefined ? {} : { audio_gain }),
    ...(speech_denoise === undefined ? {} : { speech_denoise }), ...(speech_enhance === undefined ? {} : { speech_enhance }),
    ...(censor ? { censor } : {}),
    ...(range_edits?.length ? { range_edits } : {}), ...(voiceover ? { voiceover } : {}) }
}
export function renderEditKey(c: CandidateEdit): string {
  return JSON.stringify({ ...candidateEdit(c), status: undefined, dismissed_camera_markers: undefined })
}
export function refineEdit<T extends CandidateEdit>(c: T, patch: Partial<CandidateEdit>): T {
  const next = { ...c, ...patch }
  if (patch.status === undefined && renderEditKey(c) !== renderEditKey(next)) next.status = 'refining'
  return next
}
export function editSignature(c: CandidateEdit): string {
  // Preserve existing review signatures for projects without motion.
  return JSON.stringify([c.title, c.ranges, c.scenes.map((s) => [s.at_ms, s.layout, s.crops, ...(s.transition_ms ? [s.transition_ms] : [])])])
}
export function sceneAt(c: CandidateEdit, t: number): EditorScene {
  return [...c.scenes].reverse().find((s) => s.at_ms <= t) ?? c.scenes[0]
}
/** Move a layout boundary without reordering scenes or changing their framing. */
export function retimeScene(scenes: EditorScene[], index: number, time: number, duration: number, frames?: number[]): EditorScene[] {
  if (index <= 0 || index >= scenes.length || !Number.isFinite(time)) return scenes
  const lo = scenes[index - 1].at_ms + 1
  const hi = Math.min(scenes[index + 1]?.at_ms ?? duration, duration) - 1
  if (hi < lo) return scenes
  const bounded = Math.max(lo, Math.min(hi, time))
  const at_ms = frames?.length ? snapFrame(frames, bounded) : Math.round(bounded)
  if (at_ms < lo || at_ms > hi) return scenes
  return at_ms === scenes[index].at_ms ? scenes : scenes.map((s, i) => i === index ? { ...s, at_ms } : s)
}
export function canAnimateScene(scenes: EditorScene[], index: number): boolean {
  return index > 0 && scenes[index].layout !== 'fit' && scenes[index - 1].layout === scenes[index].layout
}
export function normalizeSceneTransitions(scenes: EditorScene[]): EditorScene[] {
  return scenes.map((s, i) => canAnimateScene(scenes, i) ? s : { ...s, transition_ms: undefined, transition_kind: undefined })
}
/** The same source-time smoothstep and interrupted-motion behavior as export. */
export function framingAt(c: CandidateEdit, t: number): EditorScene {
  let scene = c.scenes[0], from = scene.crops
  const cropsAt = (at: number): Crop[] => {
    const p = scene.transition_ms ? Math.max(0, Math.min(1, (at - scene.at_ms) / scene.transition_ms)) : 1
    const ease = p * p * (3 - 2 * p)
    return scene.crops.map((crop, j) => crop.map((n, k) => from[j][k] + (n - from[j][k]) * ease) as Crop)
  }
  for (let i = 1; i < c.scenes.length && c.scenes[i].at_ms <= t; i++) {
    const next = c.scenes[i]
    from = next.transition_ms && canAnimateScene(c.scenes, i) ? cropsAt(next.at_ms) : next.crops
    scene = next
  }
  return { ...scene, crops: cropsAt(t) }
}
export function trimRange(ranges: EditorRange[], index: number, edge: 0 | 1, time: number, duration: number): EditorRange[] {
  const next = ranges.map((r) => [...r] as EditorRange)
  const lo = edge === 0 ? (index ? ranges[index - 1][1] : 0) : ranges[index][0] + 100
  const hi = edge === 0 ? ranges[index][1] - 100 : (index + 1 < ranges.length ? ranges[index + 1][0] : duration)
  next[index][edge] = Math.max(lo, Math.min(hi, Math.round(time)))
  return next
}
/** Slide an element track block (b-roll, text, effect) sideways, keeping its length inside the source. */
export function moveOverlayRange(a: number, b: number, deltaMs: number, duration: number, min = 100): [number, number] {
  const length = Math.max(min, b - a)
  const start = Math.max(0, Math.min(duration - length, Math.round(a + deltaMs)))
  return [start, start + length]
}
/** Drag one block edge on an element track; the other edge stays pinned. */
export function resizeOverlayRange(a: number, b: number, edge: 'l' | 'r', time: number, duration: number, min = 100): [number, number] {
  if (edge === 'l') return [Math.max(0, Math.min(b - min, Math.round(time))), b]
  return [a, Math.min(duration, Math.max(a + min, Math.round(time)))]
}
/**
 * "Add a section": insert one more source interval into the clip's cuts.
 * Sorted insertion; returns null when the section is too short, would overlap
 * an existing cut, or the clip already carries the engine's 24-cut maximum.
 */
export function insertSection(ranges: EditorRange[], a: number, b: number, maxRanges = 24): EditorRange[] | null {
  if (!(b - a >= 100) || ranges.length >= maxRanges) return null
  const next = [...ranges.map((r) => [...r] as EditorRange), [Math.round(a), Math.round(b)] as EditorRange].sort((x, y) => x[0] - y[0])
  for (let i = 1; i < next.length; i++) if (next[i][0] < next[i - 1][1]) return null
  return next
}
export function defaultCrop(width: number, height: number, aspect: number, cx = .5, cy = .5, zoom = 1): Crop {
  const w = Math.min(1, height * aspect / width) / zoom, h = Math.min(1, width / aspect / height) / zoom
  return [Math.max(0, Math.min(1 - w, cx - w / 2)), Math.max(0, Math.min(1 - h, cy - h / 2)), w, h]
}
/** Resize in screen pixels, preserving proportions and the opposite corner. */
export function resizeCrop(crop: Crop, corner: CropCorner, dx: number, dy: number, frameWidth: number, frameHeight: number): Crop {
  const [x, y, w, h] = crop
  if (![dx, dy, frameWidth, frameHeight].every(Number.isFinite) || frameWidth <= 0 || frameHeight <= 0) return crop
  const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
  const ax = x + (sx < 0 ? w : 0), ay = y + (sy < 0 ? h : 0)
  const pixelW = w * frameWidth, pixelH = h * frameHeight
  // Project the pointer onto the corner's diagonal, so either axis can resize.
  const proposed = 1 + (sx * dx * pixelW + sy * dy * pixelH) / (pixelW * pixelW + pixelH * pixelH)
  const maximum = Math.min((sx > 0 ? 1 - ax : ax) / w, (sy > 0 ? 1 - ay : ay) / h)
  // Match the zoom slider's 4× limit, while retaining smaller legacy crops.
  const minimum = Math.max(.01 / w, .01 / h, Math.min(1, Math.min(1 / w, 1 / h) / 4))
  const scale = Math.max(minimum, Math.min(maximum, proposed))
  const nw = Math.max(.01, Math.min(1, w * scale)), nh = Math.max(.01, Math.min(1, h * scale))
  return [Math.max(0, Math.min(1 - nw, sx > 0 ? ax : ax - nw)), Math.max(0, Math.min(1 - nh, sy > 0 ? ay : ay - nh)), nw, nh]
}
export function editDuration(c: CandidateEdit): number { return c.ranges.reduce((n, [a, b]) => n + b - a, 0) / c.video_speed }

/** Lower bound with a small tolerance for browser media timestamps. */
function frameIndex(frames: number[], time: number): number {
  let lo = 0, hi = frames.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (frames[mid] < time - .01) lo = mid + 1; else hi = mid }
  return lo
}
export function snapFrame(frames: number[], time: number): number {
  if (!frames.length || time < frames[0] || time > frames[frames.length - 1]) return time
  const i = frameIndex(frames, time)
  return i && time - frames[i - 1] < frames[i] - time ? frames[i - 1] : frames[i]
}
export function stepFrame(frames: number[], time: number, direction: -1 | 1): number {
  // Scans cover only part of the source. Continue with the pre-scan 30 fps
  // estimate outside that window, stopping at a known frame when re-entering.
  const fallback = time + direction * 1000 / 30
  if (!frames.length) return fallback
  if (time < frames[0] - .01) return direction > 0 ? Math.min(frames[0], fallback) : fallback
  if (time > frames[frames.length - 1] + .01) return direction < 0 ? Math.max(frames[frames.length - 1], fallback) : fallback
  const i = frameIndex(frames, time)
  if (direction < 0) return frames[i - 1] ?? fallback
  return frames[i + (Math.abs((frames[i] ?? Infinity) - time) < .01 ? 1 : 0)] ?? fallback
}
export function cameraMarkers(c: EditorCandidate, threshold: number): CameraScan['markers'] {
  const dismissed = new Set(c.dismissed_camera_markers ?? [])
  return (c.camera_scan?.markers ?? []).filter((m) => m.score >= threshold && !dismissed.has(m.at_ms) && c.ranges.some(([a, b]) => m.at_ms > a && m.at_ms < b))
}

/** One saved track in the cross-project audio library (main owns the store and the files). */
export interface AudioTrack { id: string; title: string; duration_ms: number; origin: 'file' | 'link'; added_at: number; /** Main-owned stored file, empty when the file went missing (preview only). */ file?: string }
const AUDIO_LIBRARY_CAP = 300
/** Parse the stored audio-library array; one bad entry never hides the rest. */
export function parseAudioTracks(raw: unknown): AudioTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: AudioTrack[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    try {
      const v = record(entry)
      const id = str(v.id, 32)
      if (!/^[a-f0-9]{32}$/.test(id) || seen.has(id)) continue
      const title = clampText(v.title, 200).trim()
      if (!title) continue
      seen.add(id)
      tracks.push({ id, title, duration_ms: num(v.duration_ms, 0, 6 * 3600 * 1000), origin: v.origin === 'link' ? 'link' : 'file', added_at: num(v.added_at, 0, 8.64e15) })
    } catch { /* Skip it. */ }
  }
  return tracks.slice(0, AUDIO_LIBRARY_CAP)
}

// ---------------------------------------------------------------------------
// Motion Studio: an idea in plain language + reference assets → a reviewed shot
// plan → a rendered motion clip. `generator` records who renders the shots;
// 'ffmpeg-motion' is the fully local renderer (Ken Burns, titles, transitions).
// ---------------------------------------------------------------------------
export type MotionShotKind = 'still' | 'video' | 'title'
export type MotionShotMotion = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right'
export interface MotionShot {
  kind: MotionShotKind
  /** still/video shots: the reference asset ref inside the run. */
  asset?: string
  /** title shots: the on-screen text. */
  text?: string
  duration_ms: number
  motion: MotionShotMotion
}
export interface MotionPlan {
  title: string
  shots: MotionShot[]
  /** Use the project's audio reference as the music bed. */
  audio: boolean
  generator: 'ffmpeg-motion'
}
export const MOTION_SHOT_LIMITS = { maxShots: 8, minDurationMs: 500, maxDurationMs: 8000, totalMs: 20000, textMax: 120 }
/** Validate a model-produced shot plan against strict caps; `references` bounds which assets may appear. */
export function parseMotionPlan(raw: unknown, references: { asset: string; kind: 'image' | 'video' | 'audio' }[]): MotionPlan {
  const v = record(raw)
  const allowed = new Map(references.map((r) => [r.asset, r.kind]))
  const shots = (Array.isArray(v.shots) ? v.shots : []).slice(0, MOTION_SHOT_LIMITS.maxShots).map((s): MotionShot => {
    const o = record(s)
    const kind = o.kind === 'still' || o.kind === 'video' || o.kind === 'title' ? o.kind : fail()
    const motion = o.motion === 'none' || o.motion === 'zoom-in' || o.motion === 'zoom-out' || o.motion === 'pan-left' || o.motion === 'pan-right'
      ? o.motion : kind === 'title' ? 'none' : 'zoom-in'
    const shot: MotionShot = { kind, duration_ms: num(o.duration_ms, MOTION_SHOT_LIMITS.minDurationMs, MOTION_SHOT_LIMITS.maxDurationMs), motion }
    if (kind === 'title') {
      const text = clampText(o.text, MOTION_SHOT_LIMITS.textMax).trim()
      if (!text) fail()
      shot.text = text
    } else {
      const asset = typeof o.asset === 'string' ? o.asset : fail()
      if (!allowed.has(asset) || allowed.get(asset) !== (kind === 'still' ? 'image' : 'video')) fail()
      shot.asset = asset
    }
    return shot
  })
  if (!shots.length) fail()
  if (shots.reduce((total, s) => total + s.duration_ms, 0) > MOTION_SHOT_LIMITS.totalMs) fail()
  return { title: clampText(v.title, 120).trim() || 'Motion clip', shots, audio: v.audio === true, generator: 'ffmpeg-motion' }
}

// ---------------------------------------------------------------------------
// Range Effects: scoped visual edits applied to a time range of the footage —
// color grades, sharpen/soften and region blur (an InPaint-style privacy blur)
// — rendered by the local engine with timeline-enabled FFmpeg filters.
// ---------------------------------------------------------------------------
export type RangeEffectKind = 'warm' | 'cool' | 'cinematic' | 'bw' | 'sharpen' | 'soften' | 'blur'
export interface RangeEdit {
  id: string
  kind: RangeEffectKind
  /** 0.1–1; how strong the effect reads. */
  intensity: number
  start_ms: number
  end_ms: number
  /** blur only: the normalized [x, y, w, h] region to blur; absent = the top-third band. */
  region?: [number, number, number, number]
}
export const RANGE_EFFECTS: { id: RangeEffectKind; label: string }[] = [
  { id: 'warm', label: 'Warm grade' }, { id: 'cool', label: 'Cool grade' },
  { id: 'cinematic', label: 'Cinematic' }, { id: 'bw', label: 'Black & white' },
  { id: 'sharpen', label: 'Sharpen' }, { id: 'soften', label: 'Soften' },
  { id: 'blur', label: 'Blur region' }
]
const RANGE_EDIT_LIMITS = { max: 8, maxDurationMs: 5 * 60 * 1000 }
/** Validate renderer/model-supplied range edits against strict caps. */
export function parseRangeEdits(raw: unknown, duration: number): RangeEdit[] {
  if (raw === undefined) return []
  const edits = arr(raw, RANGE_EDIT_LIMITS.max).map((e): RangeEdit => {
    const o = record(e)
    const kind = RANGE_EFFECTS.some((r) => r.id === o.kind) ? o.kind as RangeEffectKind : fail()
    const [start_ms, end_ms] = timeRange([o.start_ms, o.end_ms], duration)
    if (end_ms - start_ms < 100 || end_ms - start_ms > RANGE_EDIT_LIMITS.maxDurationMs) fail()
    const edit: RangeEdit = { id: /^[a-f0-9]{32}$/.test(String(o.id)) ? String(o.id) : fail(), kind, intensity: num(o.intensity, .1, 1), start_ms, end_ms }
    if (kind === 'blur') {
      if (o.region === undefined) return edit
      const region = arr(o.region, 4).map((v) => num(v, 0, 1))
      if (region[2] < .05 || region[3] < .05 || region[0] + region[2] > 1.000001 || region[1] + region[3] > 1.000001) fail()
      edit.region = [region[0], region[1], region[2], region[3]]
    } else if (o.region !== undefined) {
      fail()
    }
    return edit
  }).sort((a, b) => a.start_ms - b.start_ms)
  if (new Set(edits.map((e) => e.id)).size !== edits.length) fail()
  return edits
}
/** The CSS filter approximating an effect for the live preview; '' when none applies at `time`. */
export function rangeEffectPreview(edits: RangeEdit[], time: number): string {
  for (const edit of edits) {
    if (time < edit.start_ms || time >= edit.end_ms) continue
    const i = edit.intensity
    switch (edit.kind) {
      case 'warm': return `saturate(${1 + i * .3}) sepia(${(i * .25).toFixed(3)})`
      case 'cool': return `saturate(${1 + i * .2}) hue-rotate(${Math.round(i * 12)}deg)`
      case 'cinematic': return `contrast(${1 + i * .3}) saturate(${1 - i * .15}) brightness(${1 - i * .05})`
      case 'bw': return `saturate(${Math.max(0, 1 - i)})`
      case 'sharpen': return 'contrast(1.08)'
      case 'soften': return `blur(${(i * 2.5).toFixed(1)}px)`
      case 'blur': return ''
    }
  }
  return ''
}

// ---------------------------------------------------------------------------
// Speech Cleanup proposals: filler words/stutters and long pauses, detected
// locally from the transcript's word timings. Proposals only — nothing is cut
// until the editor applies them, and every cut stays reversible.
// ---------------------------------------------------------------------------
export interface CleanupHit { start_ms: number; end_ms: number; text: string; segment: number; word_from: number; word_to: number }
const FILLER_WORDS = new Set(['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'mm', 'mhm', 'huh'])
const FILLER_PHRASES = new Set(['you know', 'i mean', 'sort of', 'kind of', 'like i said'])
const MAX_CLEANUP_HITS = 200

const wordsOf = (row: { text?: string; words?: EditorWord[] }): EditorWord[] =>
  Array.isArray(row.words) && row.words.length ? row.words : []

/**
 * Filler single words, filler phrases and stutter repeats ("the the", "I I I").
 * Requires word timings; rows without them are skipped (there is nothing precise to cut).
 */
export function detectFillers(transcript: { text: string; words?: EditorWord[] }[]): CleanupHit[] {
  const hits: CleanupHit[] = []
  transcript.forEach((row, segment) => {
    const words = wordsOf(row)
    if (!words.length || hits.length >= MAX_CLEANUP_HITS) return
    const lower = words.map((w) => w.text.toLowerCase().replace(/[^a-z' ]/g, '').trim())
    for (let i = 0; i < words.length && hits.length < MAX_CLEANUP_HITS; i++) {
      if (lower[i] && FILLER_WORDS.has(lower[i])) {
        hits.push({ start_ms: words[i].start_ms, end_ms: words[i].end_ms, text: words[i].text, segment, word_from: i, word_to: i })
        continue
      }
      // Stutter: the same short word repeated back to back ("the the", "I I I").
      if (lower[i] && lower[i].length <= 6 && (lower[i] === lower[i - 1] || lower[i + 1] === lower[i])) {
        const previous = hits[hits.length - 1]
        if (previous && previous.segment === segment && previous.word_to === i - 1 &&
            previous.text.split(' ').pop()?.toLowerCase() === lower[i]) {
          // A third (or fifth) repeat extends the running stutter.
          previous.end_ms = words[i].end_ms
          previous.word_to = i
          previous.text += ' ' + words[i].text
          continue
        }
        if (lower[i + 1] === lower[i]) {
          hits.push({ start_ms: words[i].start_ms, end_ms: words[i + 1].end_ms, text: `${words[i].text} ${words[i + 1].text}`, segment, word_from: i, word_to: i + 1 })
          i++
          continue
        }
      }
      const phrase = `${lower[i]} ${lower[i + 1] ?? ''}`.trim()
      if (lower[i] && FILLER_PHRASES.has(phrase)) {
        hits.push({ start_ms: words[i].start_ms, end_ms: words[i + 1].end_ms, text: `${words[i].text} ${words[i + 1].text}`, segment, word_from: i, word_to: i + 1 })
        i++
      }
    }
  })
  return hits
}

/** Silence gaps (inside lines between words, and between adjacent lines) at least `thresholdMs` long. */
export function detectPauses(transcript: { start_ms: number; end_ms: number; words?: EditorWord[] }[], thresholdMs: number): { start_ms: number; end_ms: number }[] {
  if (!(thresholdMs >= 100)) return []
  const pauses: { start_ms: number; end_ms: number }[] = []
  const push = (start: number, end: number): void => {
    if (end - start >= thresholdMs && pauses.length < MAX_CLEANUP_HITS) pauses.push({ start_ms: Math.round(start), end_ms: Math.round(end) })
  }
  transcript.forEach((row, index) => {
    const words = wordsOf(row)
    for (let i = 1; i < words.length; i++) if (words[i].start_ms > words[i - 1].end_ms) push(words[i - 1].end_ms, words[i].start_ms)
    const next = transcript[index + 1]
    if (next && next.start_ms > row.end_ms) push(row.end_ms, next.start_ms)
  })
  return pauses.sort((a, b) => a.start_ms - b.start_ms)
}

// ---------------------------------------------------------------------------
// Voiceover Studio: a scratch AI voiceover for the clip — script, installed
// Windows voice, pacing and custom pronunciations — previewed locally via the
// engine (Windows SAPI) before any commit. The generated audio is an editor
// asset so the sweep keeps it while the studio references it.
// ---------------------------------------------------------------------------
export interface VoiceoverPronunciation { word: string; say: string }
export interface VoiceoverConfig {
  script: string
  voice: string
  /** 0.5–2; 1 = natural pace. */
  rate: number
  pronunciations: VoiceoverPronunciation[]
  /** The generated preview audio (editor asset ref); absent until the first preview. */
  audio_asset?: string
  /** Where the narration starts on the clip's timeline, 0–600000 ms (absent = clip start). */
  start_ms?: number
  /** Probed narration length, persisted so the timeline block keeps its width. */
  duration_ms?: number
  /** Voiceover level under the mix, 0–2 (1 = untouched). */
  gain?: number
}
export function parseVoiceoverConfig(raw: unknown): VoiceoverConfig {
  const v = record(raw)
  const script = clampText(v.script, 5000)
  const config: VoiceoverConfig = {
    script: script.trim() ? script : fail(),
    voice: clampText(v.voice, 80),
    rate: num(v.rate, 0.5, 2),
    pronunciations: arr(v.pronunciations, 20).map((item) => {
      const o = record(item)
      const word = clampText(o.word, 40).trim()
      const say = clampText(o.say, 120).trim()
      if (!word || !say) fail()
      return { word, say }
    })
  }
  if (v.audio_asset !== undefined) config.audio_asset = asset(v.audio_asset)
  if (v.start_ms !== undefined) config.start_ms = num(v.start_ms, 0, 600000)
  if (v.duration_ms !== undefined) config.duration_ms = num(v.duration_ms, 100, 600000)
  if (v.gain !== undefined) config.gain = num(v.gain, 0, 2)
  return config
}

// ---------------------------------------------------------------------------
// Snap Editing: drags lock onto meaningful edges instead of raw pixels.
// ---------------------------------------------------------------------------
/** The nearest snap point within `windowMs`, or `time` unchanged. */
export function snapTo(points: number[], time: number, windowMs: number): number {
  let best = time, bestDist = windowMs
  for (const point of points) {
    const dist = Math.abs(point - time)
    if (dist <= bestDist) { best = point; bestDist = dist }
  }
  return best
}

/** Snap targets for a candidate: cut edges, transcript line edges, scene changes, clip ends. */
export function snapPoints(
  candidate: Pick<EditorCandidate, 'ranges' | 'scenes'>,
  transcript: { start_ms: number; end_ms: number }[],
  duration: number
): number[] {
  const set = new Set<number>([0, duration])
  for (const [a, b] of candidate.ranges) { set.add(a); set.add(b) }
  for (const row of transcript) {
    if (Number.isFinite(row.start_ms) && row.start_ms >= 0 && row.start_ms <= duration) { set.add(row.start_ms); set.add(row.end_ms) }
  }
  for (const scene of candidate.scenes) if (scene.at_ms >= 0 && scene.at_ms <= duration) set.add(scene.at_ms)
  return [...set].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Text box styling: independent per-overlay look for plain text boxes.
// Lower Third presets keep their own visual system; `style` applies to plain
// cards and is rendered by the engine as a generated card image.
// ---------------------------------------------------------------------------
export type TextBoxFont = 'montserrat' | 'poppins' | 'archivo' | 'instrument' | 'jakarta'
export const TEXT_BOX_FONTS: { id: TextBoxFont; label: string }[] = [
  { id: 'montserrat', label: 'Montserrat' }, { id: 'poppins', label: 'Poppins' },
  { id: 'archivo', label: 'Archivo Black' }, { id: 'instrument', label: 'Instrument Serif' },
  { id: 'jakarta', label: 'Plus Jakarta' }
]
export interface TextBoxStyle {
  font: TextBoxFont
  /** Fraction of the output height (0.02–0.12). */
  size: number
  /** Text color, #rrggbb. */
  color: string
  /** Card background, #rrggbb. */
  background: string
  /** Corner radius in px at 1080-wide output (0–24). */
  radius: number
  /** Card padding multiplier (0.4–2). */
  padding: number
  align: 'left' | 'center' | 'right'
}
export const DEFAULT_TEXT_STYLE: TextStyleSource = { font: 'montserrat', size: 0.032, color: '#ffffff', background: '#14161c', radius: 10, padding: 1, align: 'center' }
type TextStyleSource = TextBoxStyle
export function parseTextBoxStyle(raw: unknown): TextStyleSource {
  const v = record(raw)
  const font = TEXT_BOX_FONTS.some((f) => f.id === v.font) ? v.font as TextBoxFont : fail()
  const align = v.align === 'left' || v.align === 'right' ? v.align : 'center'
  return {
    font,
    size: num(v.size, 0.02, 0.12),
    color: typeof v.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.color) ? v.color : fail(),
    background: typeof v.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.background) ? v.background : fail(),
    radius: num(v.radius, 0, 24),
    padding: num(v.padding, 0.4, 2),
    align
  }
}
/** Max 5 text boxes visible at the same moment (broadcast-graphics layering). */
export function maxSimultaneousTextOverlays(overlays: { start_ms: number; end_ms: number }[]): number {
  const events = overlays.flatMap((o) => [[o.start_ms, 1], [o.end_ms, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let active = 0, max = 0
  for (const [, delta] of events) { active += delta; if (active > max) max = active }
  return max
}

/** Uploaded video appended to the baked clip (after the main content). */
