import { SavedStageTimings } from './StageBreakdown'
import { registerNavigationCommit } from '../lib/navigation'
import { nextCaptionRange } from '../lib/caption-ranges'
import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Archive, BookPlus, Check, PersonStanding, Plus, ChevronLeft, ChevronRight, ChevronDown, Crosshair, Download, Eraser, Eye, EyeOff, Film, Loader2, Magnet, Pause, Pencil, Play, Redo2, RotateCcw, Save, Scissors, SkipBack, Trash2, Undo2, Volume2, X , GripHorizontal } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatTimecode, localFileUrl, parseTimecode } from '../lib/utils'
import { uniqueTemplateId } from '../lib/template-id'
import { captionPresetIds, type BrandTemplate } from '../../shared/templates'
import { EDITOR_REVISION_CONFLICT, cameraMarkers, cutRanges, cutWords, detectFillers, detectPauses, lineCutState, rangeEffectPreview, snapPoints, snapTo, lowerThirdPreset, insertSection, previewCoversReel, previewWindow, restoreRange, restoreWords, speakerAt, snapFrame, stepFrame, candidateEdit, canAnimateScene, defaultCrop, editDuration, editSignature, editorProgress, startingCandidate, framingAt, moveOverlayRange, normalizeSceneTransitions, refineEdit, renderEditKey, resizeOverlayRange, resizeCrop, retimeScene, sceneAt, trimRange, wordIsCut, type CandidateEdit, type CtaBadge, type Crop, type CropCorner, type EditorCandidate, type EditorQuestion, type EditorRange, type EditorScene, type EditorSession, type EditorWord, type CleanupHit, type OverlayPosition } from '../../shared/clip-editor'
import { censorWordHit } from '../../shared/censor-words'
import { AddSectionDialog } from './AddSectionDialog'
import { CameraChanges, CameraScanButton } from './CameraChanges'
import { PhoneAppSkin, overlayRect, phoneSafeZoneWarnings, phoneSkins, type PhoneSkin } from './PhonePreview'
import { ActionMenu } from './ui/ActionMenu'
import { Button } from './ui/Button'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { CaptionPresetPicker } from './CaptionPresetPicker'
import { EditorCaptionPreview } from './EditorCaptionPreview'
import { EditorToolRail } from './EditorToolRail'
import { EditorWaveform } from './EditorWaveform'
import { keywordSegments } from '../lib/keywords'
import { captionAnchor } from '../lib/caption-preview'
import { Switch } from './ui/Switch'
import { Select } from './ui/Select'
import { Checkbox } from './ui/Checkbox'
import { EditInspector } from './EditInspector'
import { captureFilmstrip, filmstripStyle, type StripWindow } from '../lib/filmstrip'

const labels: Record<string, string> = { not_sponsored: 'Not sponsored', opening_context: 'Opening context', self_contained: 'Self contained', complete_ending: 'Complete ending', logical_flow: 'Logical flow', faithful_to_source: 'Faithful to source', title_supported: 'Title supported', evidence: 'Enough evidence', removal_safe: 'Safe to remove', join_logical: 'Natural join' }
const clock = (n: number): string => `${formatTimecode(n)}.${String(Math.floor(n % 1000)).padStart(3, '0')}`
const cropCorners: CropCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
const statusLabels = { refining: 'Refining', ready: 'Ready', baked: 'Baked', discarded: 'Discarded' }
const formatBytes = (n: number): string => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
const reviewCurrent = (c: EditorCandidate): boolean => {
  try { return JSON.stringify(JSON.parse(c.review?.signature ?? 'null')) === editSignature(c) } catch { return false }
}
function Question({ q }: { q: EditorQuestion }): React.JSX.Element {
  const passed = q.probability !== null && q.probability >= q.threshold
  const words = (text: string): string => text.replaceAll('`retained_dialogue`', 'this clip').replaceAll('`before`', 'the preceding context').replaceAll('`after`', 'the following context').replaceAll('`title`', 'the title').replaceAll('`visual_observations`', 'visual evidence')
  return <details className="editor-question">
    <summary><span className={cn('editor-dot', passed ? 'bg-success' : 'bg-warning')} /><span>{labels[q.id] ?? q.id}</span><span className={cn('ml-auto font-mono', passed ? 'text-success' : 'text-warning')}>{q.probability === null ? 'Not rated' : `${Math.round(q.probability * 100)}%`}</span><ChevronDown size={12} /></summary>
    <p>{words(q.prompt)}</p><p className="text-ink-subtle">{q.probability === null ? `Review ${q.status.replaceAll('_', ' ')}. ` : ''}Target: {Math.round(q.threshold * 100)}%</p>
    <p><span className="text-success">Pass: </span>{q.yes}</p><p><span className="text-warning">Consider: </span>{q.no}</p>
  </details>
}

export function ClipEditor({ outputDir, focusCandidateId, leading, onExports }: { outputDir: string; /** Open with this candidate selected ("Edit this clip" from a reel). */ focusCandidateId?: string | null; leading?: ReactNode; onExports: () => Promise<void> }): React.JSX.Element {
  const [session, setSession] = useState<EditorSession | null>(null)
  const [edits, setEdits] = useState<EditorCandidate[]>([])
  const editsRef = useRef(edits); editsRef.current = edits
  const sessionRef = useRef(session); sessionRef.current = session
  /** Source-time window covered by the preview file (0..duration when it is a full-source one). */
  const previewStartRef = useRef(0)
  const previewEndRef = useRef(0)
  /** True while the preview holds only part of the source (fast per-reel import). */
  const previewPartialRef = useRef(false)
  /** Guards the lazy full-preview build so one failure cannot retry in a loop. */
  const previewBuildRef = useRef(false)
  /** Map between source milliseconds and the preview file's own 0-based timeline. */
  const previewToSourceMs = (seconds: number): number => seconds * 1000 + previewStartRef.current
  const sourceToPreviewSeconds = (ms: number): number => {
    const span = (previewEndRef.current - previewStartRef.current - 1) / 1000
    return Math.max(0, Math.min(span, (ms - previewStartRef.current) / 1000))
  }
  /** A reel outside the preview's window would play clamped, wrong footage. */
  const reelPlayable = (c: EditorCandidate): boolean =>
    !previewPartialRef.current || previewCoversReel(c.ranges, { startMs: previewStartRef.current, endMs: previewEndRef.current })
  const savedKey = useRef('')
  const savePromise = useRef<Promise<void> | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A stale-revision save can never succeed; offer a reload instead of a retry loop.
  const [conflict, setConflict] = useState(false)
  const [confirmFree, setConfirmFree] = useState(false)
  const closeFree = useCallback(() => setConfirmFree(false), [])
  /** Render identity of each clip when it left Baked, so undo can restore Baked. */
  const bakedKeys = useRef(new Map<string, string>())
  const [busy, setBusy] = useState<EditorSession['operation']>(null)
  const [batch, setBatch] = useState<EditorSession['batch']>()
  const [progress, setProgress] = useState<EditorSession['progress']>()
  const [notice, setNotice] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<string | null>(null)
  const closeReplacement = useCallback(() => setReplacement(null), [])
  const [selected, setSelected] = useState(0)
  const [tab, setTab] = useState<'review' | 'framing' | 'captions' | 'brand' | 'transcript'>('review')
  const [time, setTime] = useState(0)
  const timeRef = useRef(time); timeRef.current = time
  const [playing, setPlaying] = useState(false)
  const [reviewSpeed, setReviewSpeed] = useState(1)
  const [previewCut, setPreviewCut] = useState(true)
  const [showSubtitlePreview, setShowSubtitlePreview] = useState(true)
  const [cameraThreshold, setCameraThreshold] = useState(.08)
  const [selectedCamera, setSelectedCamera] = useState<number | null>(null)
  const deselectCamera = useCallback(() => setSelectedCamera(null), [])
  const [timelineZoom, setTimelineZoom] = useState<'clip' | 'source' | [number, number]>('clip')
  const zoomWindow = Array.isArray(timelineZoom) ? timelineZoom : null
  const presentedTime = useRef<number | null>(null)
  const [cropDragging, setCropDragging] = useState(false)
  const dragging = useRef(false)
  const editorRoot = useRef<HTMLElement>(null)
  const [dragWindow, setDragWindow] = useState<[number, number] | null>(null)
  const previewCutRef = useRef(previewCut); previewCutRef.current = previewCut
  const [panel, setPanel] = useState(0)
  const [showAudit, setShowAudit] = useState(false)
  const [undo, setUndo] = useState<EditorCandidate[][]>([])
  const [redo, setRedo] = useState<EditorCandidate[][]>([])
  const [editingCaption, setEditingCaption] = useState<number | null>(null)
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})
  const [phoneView, setPhoneView] = useState(false)
  const [phoneSkin, setPhoneSkin] = useState<PhoneSkin>('tiktok')
  const [phoneScale, setPhoneScale] = useState(1)
  const outputFrame = useRef<HTMLDivElement>(null)
  const speakerNamesRef = useRef(speakerNames); speakerNamesRef.current = speakerNames
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null)
  const [showTimeline, setShowTimeline] = useState(true)
  /** Transcript lines picked for a text-driven cut (Delete applies it). */
  const [textSelection, setTextSelection] = useState<Set<number>>(new Set())
  /** Contiguous word selection inside one transcript line. */
  const [wordSelection, setWordSelection] = useState<{ segment: number; from: number; to: number } | null>(null)
  const wordDragging = useRef(false)
  const brollVideo = useRef<HTMLVideoElement>(null)
  const pipSpeaker = useRef<HTMLVideoElement>(null)
  const wordDragStart = useRef<{ x: number; y: number } | null>(null)
  const firstCaptionChange = useRef(true)
  const captionInput = useRef<HTMLTextAreaElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const transcriptPanel = useRef<HTMLDivElement>(null)
  const activeCaption = useRef<HTMLDivElement>(null)
  const activeTranscript = session?.project.transcript.find((r) => time >= r.start_ms && time < r.end_ms)
  const candidate = edits[selected]
  const candidateRef = useRef(candidate); candidateRef.current = candidate
  const frames = candidate?.camera_scan?.frames ?? []
  const currentScene = candidate ? sceneAt(candidate, time) : null
  const key = JSON.stringify([edits.map(candidateEdit), speakerNames])
  const keyRef = useRef(key); keyRef.current = key
  const load = useCallback(async () => {
    try {
      const s = await getApi().editor.open(outputDir)
      if (!sessionRef.current) setSelected(startingCandidate(s.project.candidates, focusCandidateId))
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); editsRef.current = s.project.candidates
      previewStartRef.current = s.project.preview_start_ms ?? 0
      previewEndRef.current = s.project.preview_end_ms ?? s.project.duration_ms
      previewPartialRef.current = previewWindow(s.project) !== null
      setSpeakerNames(s.project.speaker_names ?? {}); speakerNamesRef.current = s.project.speaker_names ?? {}
      savedKey.current = JSON.stringify([s.project.candidates.map(candidateEdit), s.project.speaker_names ?? {}])
      keyRef.current = savedKey.current
      setBusy(s.operation ?? null); setBatch(s.batch); setProgress(s.progress); setError(null); setConflict(false)
    } catch (e) { setError(errorMessage(e)) }
  }, [outputDir, focusCandidateId])
  useEffect(() => { void load() }, [load])
  // A reopened window can reconnect to an export/review still owned by main.
  // Poll only progress; reload the project once that operation ends.
  useEffect(() => {
    if (!session?.operation) return
    let pending = false
    const timer = window.setInterval(() => {
      if (pending) return
      pending = true
      void getApi().editor.progress(outputDir).then((p) => {
        if (!p.operation) return load()
        setBatch(p.batch); setProgress(p.progress)
      }).catch(() => {}).finally(() => { pending = false })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [session?.operation, load, outputDir])

  const save = useCallback(async (): Promise<void> => {
    if (savePromise.current) await savePromise.current
    if (!sessionRef.current || keyRef.current === savedKey.current) return
    const task = async (): Promise<void> => {
      setSaving(true)
      try {
        while (keyRef.current !== savedKey.current) {
          const sentKey = keyRef.current
          const s = await getApi().editor.save(outputDir, sessionRef.current!.project.revision, editsRef.current, speakerNamesRef.current)
          savedKey.current = sentKey; sessionRef.current = s; setSession(s)
        }
      } catch (e) {
        if (errorMessage(e).includes(EDITOR_REVISION_CONFLICT)) setConflict(true)
        throw e
      } finally { setSaving(false); savePromise.current = null }
    }
    savePromise.current = task()
    await savePromise.current
  }, [outputDir])
  useEffect(() => {
    if (!session || busy || dragWindow || cropDragging || key === savedKey.current) return
    const timer = window.setTimeout(() => { void save().catch((e) => setError(errorMessage(e))) }, 700)
    return () => window.clearTimeout(timer)
  }, [key, session, busy, dragWindow, cropDragging, save])
  useEffect(() => registerNavigationCommit(async () => {
    try { await save() } catch (e) { setError(errorMessage(e)); throw e }
  }), [save])
  // Flush in-memory edits on page navigation; main owns the durable write.
  useEffect(() => () => { void save().catch(() => {}) }, [save])
  // Unsaved edits block unload; main then asks Save / Discard / Cancel and,
  // for Save, asks this editor to save before it continues the close.
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => { if (keyRef.current !== savedKey.current) event.preventDefault() }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [])
  useEffect(() => getApi().editor.onSaveBeforeClose?.(() => {
    void save().then(() => getApi().editor.closeReady(true), (e) => {
      setError(errorMessage(e))
      return getApi().editor.closeReady(false)
    }).catch(() => {})
  }), [save])

  const change = (patch: Partial<CandidateEdit>, remember = true): void => {
    if (busy || !candidate || (candidate.status === 'discarded' && patch.status === undefined)) return
    if (patch.scenes) patch = { ...patch, scenes: normalizeSceneTransitions(patch.scenes) }
    if (candidate.status === 'baked') bakedKeys.current.set(candidate.id, renderEditKey(candidate))
    if (remember) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]) }
    setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, patch) : c))
  }
  const history = (direction: 'undo' | 'redo'): void => {
    const from = direction === 'undo' ? undo : redo
    if (busy || !from.length) return
    // Undo can restore an old edit, but only a completed render creates Baked:
    // the exact render a clip left (main checks the same identity on save).
    const next = from[from.length - 1].map((c, i) => c.status === 'baked' && edits[i].status !== 'baked' &&
      bakedKeys.current.get(c.id) !== renderEditKey(c) ? { ...c, status: 'refining' as const } : c)
    setEditingCaption(null)
    if (direction === 'undo') { setUndo(from.slice(0, -1)); setRedo((r) => [...r, edits]) }
    else { setRedo(from.slice(0, -1)); setUndo((u) => [...u, edits]) }
    setEdits(next)
  }
  const seek = (t: number): void => {
    if (!video.current || !session) return
    const value = Math.max(0, Math.min(session.project.duration_ms - 1, t))
    presentedTime.current = null
    timeRef.current = value
    // A fast per-reel preview covers only a window; the playhead still tracks
    // the requested source time even when the frame clamps into that window.
    video.current.currentTime = sourceToPreviewSeconds(value) + (frames.length ? .000001 : 0); setTime(value)
  }
  const frameStep = (direction: -1 | 1, count = 1): void => {
    video.current?.pause()
    let next = timeRef.current
    for (let i = 0; i < count; i++) next = stepFrame(frames, next, direction)
    seek(next)
  }
  const scrub = (direction: -1 | 1, coarse: boolean): void => {
    video.current?.pause()
    if (coarse) seek(timeRef.current + direction * 1000)
    else frameStep(direction, Math.round(reviewSpeed))
  }
  const toggle = (): void => {
    const v = video.current
    if (!v || !candidate) return
    if (!v.paused) {
      v.pause(); setPlaying(false)
      const panel = transcriptPanel.current
      if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
      return
    }
    // A fast per-reel preview holds only a window of the source. A reel outside
    // it cannot play (the frame clamps to the window edge and play-cuts pause
    // right away): prepare the full preview instead of playing wrong footage.
    if (!reelPlayable(candidate)) {
      if (!busy && !previewBuildRef.current) { previewBuildRef.current = true; void run('build-preview') }
      return
    }
    // With cuts disabled, a playhead parked outside the window would otherwise
    // play the wrong seconds; resume from the reel itself.
    if (previewPartialRef.current && !previewCut) {
      const at = previewToSourceMs(v.currentTime)
      if (at < previewStartRef.current - 1 || at > previewEndRef.current - 1) seek(candidate.ranges[0][0])
    }
    if (previewCut && !candidate.ranges.some(([a, b]) => a <= previewToSourceMs(v.currentTime) && b > previewToSourceMs(v.currentTime))) seek(candidate.ranges[0][0])
    void v.play().catch(() => setError('The source preview could not play. Try seeking or reopening the editor.'))
  }
  const trim = (edge: 'in' | 'out', raw: number): void => {
    const t = snap(raw)
    if (!candidate) return
    change({ ranges: trimRange(candidate.ranges, edge === 'in' ? 0 : candidate.ranges.length - 1, edge === 'in' ? 0 : 1, t, session!.project.duration_ms) })
  }
  const split = (): void => {
    if (!candidate) return
    const t = Math.round(time)
    const ranges = candidate.ranges.flatMap(([a, b]): [number, number][] => t > a + 100 && t < b - 100 ? [[a, t], [t, b]] : [[a, b]])
    if (ranges.length <= 24) change({ ranges })
  }
  // Text-driven cutting: transcript lines and words are views over the kept
  // ranges, so deleting text subtracts time and restoring re-inserts it.
  const cutTextLines = (indices: number[]): void => {
    if (!candidate || editingDisabled || !indices.length) return
    let ranges = candidate.ranges
    try {
      for (const i of indices) {
        const line = session?.project.transcript[i]
        if (line) ranges = cutRanges(ranges, line.start_ms, line.end_ms)
      }
    } catch (e) { setError(errorMessage(e)); return }
    change({ ranges })
    setTextSelection(new Set())
  }
  const restoreTextLine = (i: number): void => {
    if (!candidate || editingDisabled) return
    const line = session?.project.transcript[i]
    if (!line) return
    const ranges = restoreRange(candidate.ranges, line.start_ms, line.end_ms, session!.project.duration_ms)
    if (ranges === candidate.ranges) { setNotice('That text is already part of the clip.'); return }
    change({ ranges })
  }
  const cutSelectedWords = (): void => {
    const sel = wordSelection
    if (!sel || !candidate || editingDisabled) return
    const words = session?.project.transcript[sel.segment]?.words
    if (!words?.length) return
    try {
      const next = cutWords(candidate.ranges, candidate.caption_edits, sel.segment, words, Math.min(sel.from, sel.to), Math.max(sel.from, sel.to))
      change({ ranges: next.ranges, caption_edits: next.caption_edits })
    } catch (e) { setError(errorMessage(e)); return }
    setWordSelection(null)
  }
  // Opus-style entry 2: selected transcript words become a pre-filled text overlay,
  // and the Text panel opens on it with the Lower Third templates ready to apply.
  const [textFocus, setTextFocus] = useState<{ index: number; nonce: number } | null>(null)
  const [compareOriginal, setCompareOriginal] = useState(false)
  // Speech cleanup: flagged bad takes (transcript line spans) awaiting keep/cut.
  const [badTakes, setBadTakes] = useState<{ start: number; end: number; reason: string }[] | null>(null)
  const [badTakesBusy, setBadTakesBusy] = useState(false)
  // Speech cleanup proposals: fillers and pauses, detected locally, cut only on Apply.
  const [fillersOn, setFillersOn] = useState(true)
  const [pausesOn, setPausesOn] = useState(true)
  const [pauseThreshold, setPauseThreshold] = useState(500)
  const [cleanupSkipped, setCleanupSkipped] = useState<string[]>([])

  const [cleanupFocus, setCleanupFocus] = useState<{ nonce: number } | null>(null)
  // Word toolbar: a plain click (not a drag) on a word opens grouped actions.
  const [wordMenu, setWordMenu] = useState<{ segment: number; index: number; x: number; y: number } | null>(null)
  const [openTool, setOpenTool] = useState<string | null>(null)
  const [laneHeight, setLaneHeight] = useState(0)
  const [addSection, setAddSection] = useState(false)
  // Timeline multi-select: Shift+click pieces to relayout several cuts at once.
  const [selectedCuts, setSelectedCuts] = useState<number[]>([])
  const [bandSelect, setBandSelect] = useState<[number, number] | null>(null)
  // Manual subject tracking: armed = next click on the source frame picks the subject.
  const [subjectArm, setSubjectArm] = useState(false)
  const [wordCorrecting, setWordCorrecting] = useState(false)
  // Inline pause chips: click a gap chip to cut that pause or every pause at once.
  const [pauseMenu, setPauseMenu] = useState<{ start_ms: number; end_ms: number; x: number; y: number } | null>(null)
  // Scene context menu: right-click a timeline piece to change its layout.
  const [sceneMenu, setSceneMenu] = useState<{ cut: number; x: number; y: number } | null>(null)
  const [wordCorrectValue, setWordCorrectValue] = useState('')
  const wordText = (segment: number, index: number): string => session?.project.transcript[segment]?.words?.[index]?.text ?? ''
  const correctWord = async (everywhere: boolean): Promise<void> => {
    const menu = wordMenu
    if (!menu || !candidate || editingDisabled) return
    const input = document.getElementById('word-correct-input') as HTMLInputElement | null
    const update = (input?.value ?? '').replace(/\s+/g, ' ').trim()
    const old = wordText(menu.segment, menu.index).trim()
    if (!update || !old || update.toLowerCase() === old.toLowerCase()) { setWordMenu(null); return }
    const pattern = new RegExp(old.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'), 'gi')
    const targets = everywhere
      ? project.transcript.map((_, segment) => segment).filter((segment) => pattern.test(captionText(segment)))
      : [menu.segment]
    const caption_edits = [...(candidate.caption_edits ?? [])]
    for (const segment of targets) {
      const text = captionText(segment)
      const next = text.replace(pattern, update)
      if (next === text) continue
      const at = caption_edits.findIndex((e) => e.segment === segment)
      if (at >= 0) caption_edits[at] = { segment, text: next }
      else caption_edits.push({ segment, text: next })
    }
    change({ caption_edits: caption_edits.sort((a, b) => a.segment - b.segment) })
    setWordMenu(null)
    if (everywhere && targets.length > 1) {
      try {
        await getApi().settings.addVocabularyTerm(update)
        setNotice(`Corrected "${old}" to "${update}" in ${targets.length} lines, and added it to your Brand Vocabulary.`)
        return
      } catch { /* Vocabulary is optional; the corrections already applied. */ }
    }
    setNotice(`Corrected "${old}" to "${update}".`)
  }
  // Snap Editing: trim and marker drags lock onto cuts, speech lines and layout changes.
  const [snapping, setSnapping] = useState(true)
  const detectTakes = async (): Promise<void> => {
    if (badTakesBusy) return
    setBadTakesBusy(true); setError(null)
    try {
      const takes = await getApi().editor.aiBadTakes(outputDir, candidate.id)
      setBadTakes(takes)
      setNotice(takes.length ? `${takes.length} bad take${takes.length === 1 ? '' : 's'} found — review them in Speech cleanup.` : 'No bad takes found — the speech is clean.')
    } catch (e) { setError(errorMessage(e)) } finally { setBadTakesBusy(false) }
  }
  const keepTake = (index: number): void => setBadTakes((takes) => takes?.filter((_, i) => i !== index) ?? null)
  const removeTake = (index: number): void => {
    const take = badTakes?.[index]
    if (!take) return
    cutTextLines(Array.from({ length: take.end - take.start + 1 }, (_, i) => take.start + i))
    keepTake(index)
  }
  const removeAllTakes = (): void => {
    if (!candidate || editingDisabled || !badTakes?.length) return
    // One cumulative cut: cutting against candidate.ranges per take would let
    // each change overwrite the previous one (they all start from the same base).
    let ranges = candidate.ranges
    try {
      for (const take of badTakes) {
        for (let i = take.start; i <= take.end; i++) {
          const line = session?.project.transcript[i]
          if (line) ranges = cutRanges(ranges, line.start_ms, line.end_ms)
        }
      }
    } catch (e) { setError(errorMessage(e)) }
    if (ranges !== candidate.ranges) change({ ranges })
    setBadTakes(null)
  }
  const addWordsAsTextOverlay = (): void => {
    const sel = wordSelection
    if (!sel || !candidate || editingDisabled) return
    const words = session?.project.transcript[sel.segment]?.words
    if (!words?.length) return
    const picked = words.slice(Math.min(sel.from, sel.to), Math.max(sel.from, sel.to) + 1)
    const start_ms = Math.round(picked[0].start_ms), end_ms = Math.round(picked[picked.length - 1].end_ms)
    if (end_ms - start_ms < 100 || !picked.some((w) => w.text.trim())) return
    const overlay = { text: picked.map((w) => w.text).join(' '), start_ms, end_ms, position: 'bottom-left' as OverlayPosition }
    const next = [...(candidate.text_overlays ?? []), overlay].sort((a, b) => a.start_ms - b.start_ms)
    change({ text_overlays: next })
    setWordSelection(null)
    setTextFocus({ index: next.indexOf(overlay), nonce: Date.now() })
  }
  // Stop re-fixing the same wrong word: teach it to the Brand Vocabulary once.
  const addSelectionToVocabulary = async (): Promise<void> => {
    const sel = wordSelection
    if (!sel) return
    const words = session?.project.transcript[sel.segment]?.words
    if (!words?.length) return
    const term = words.slice(Math.min(sel.from, sel.to), Math.max(sel.from, sel.to) + 1).map((w) => w.text).join(' ').trim()
    if (!term) return
    try {
      await getApi().settings.addVocabularyTerm(term)
      setWordSelection(null)
      setNotice(`“${term}” added to your Brand Vocabulary. New transcriptions will recognize it.`)
    } catch (e) { setError(errorMessage(e)) }
  }
  const restoreLineWords = (i: number): void => {
    if (!candidate || editingDisabled) return
    const words = session?.project.transcript[i]?.words
    if (!words?.length) return restoreTextLine(i)
    const next = restoreWords(candidate.ranges, candidate.caption_edits, i, words, session!.project.duration_ms)
    if (next.ranges === candidate.ranges && next.caption_edits === candidate.caption_edits) { setNotice('That text is already part of the clip.'); return }
    change({ ranges: next.ranges, caption_edits: next.caption_edits })
  }
  useEffect(() => {
    const open = wordMenu || pauseMenu || sceneMenu
    if (!open) return
    const close = (event: PointerEvent): void => {
      const target = event.target as HTMLElement
      if (!target.closest('.editor-word-menu') && !target.closest('.editor-word') && !target.closest('.editor-pause-chip') && !target.closest('.editor-timeline-piece')) setWordMenu(null)
      if (!target.closest('.editor-word-menu')) { setPauseMenu(null); setSceneMenu(null) }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { setWordMenu(null); setPauseMenu(null); setSceneMenu(null) }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [wordMenu, pauseMenu, sceneMenu])
  useEffect(() => {
    const playbackKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement
      const speedKey = !e.shiftKey && /^[123]$/.test(e.key)
      const timelineArrow = (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target.matches('.editor-source-scrub,.editor-fine-scrub')
      // Range inputs otherwise use a browser-defined percentage of their span,
      // making arrow jumps depend on focus and timeline zoom.
      if (timelineArrow) e.preventDefault()
      // g/x are editing shortcuts, not text: never swallow them while typing.
      const typing = !!(e.target as HTMLElement).closest('input:not([type="range"]),textarea,select,[contenteditable="true"],[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup="menu"],[aria-haspopup="dialog"]')
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); setSnapping((value) => !value); return }
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); setTab('framing'); setPanel(0); return }
if ((e.code !== 'Space' && !speedKey && !timelineArrow) || e.metaKey || e.ctrlKey || e.altKey || e.isComposing || showAudit || replacement || busy) return
      if ((!editorRoot.current?.contains(target) && target !== document.body) ||
          target.closest('[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup="menu"],[aria-haspopup="dialog"],input:not([type="range"]),textarea,select,[contenteditable]:not([contenteditable="false"])')) return
      // Own Space before focused buttons/markers can activate or seek on it.
      // A held key must not repeatedly pause and restart playback.
      e.preventDefault(); e.stopPropagation()
      if (dragging.current) return
      if (timelineArrow) scrub(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
      else if (!e.repeat) {
        if (speedKey) setReviewSpeed(Number(e.key))
        else toggle()
      }
    }
    const handler = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).closest('[role="dialog"],[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup="menu"],input,textarea,select,[contenteditable]') || showAudit || replacement || dragging.current) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); return }
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return
      if (e.key.toLowerCase() === 'i') trim('in', time)
      if (e.key.toLowerCase() === 'o') trim('out', time)
      if (e.key.toLowerCase() === 's') split()
      if ((e.key === 'Delete' || e.key === 'Backspace') && !editingDisabled && (wordSelection || textSelection.size)) {
        e.preventDefault()
        if (wordSelection) cutSelectedWords()
        else cutTextLines([...textSelection])
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); scrub(e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey) }
    }
    window.addEventListener('keydown', playbackKey, true)
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', playbackKey, true)
      window.removeEventListener('keydown', handler)
    }
  })
  useEffect(() => {
    if (candidate && video.current) { video.current.pause(); seek(candidate.ranges[0][0]); setPanel(0); setEditingCaption(null); setSelectedCamera(null); setTimelineZoom((zoom) => zoom === 'source' ? 'source' : 'clip') }
    setTextSelection(new Set()); setWordSelection(null)
  // Only candidate selection resets the playhead, never an edit.
  }, [selected, session?.previewPath])
  // A word drag can end outside its line; release selection mode globally.
  useEffect(() => {
    const up = (): void => { wordDragging.current = false }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])
  useEffect(() => { if (video.current && candidate) video.current.playbackRate = candidate.video_speed * reviewSpeed }, [candidate?.video_speed, reviewSpeed])
  useEffect(() => {
    if (!phoneView) return
    const el = outputFrame.current
    if (!el) return
    // --pu scales the phone skin CSS: rendered shell width / 360 design width.
    const fit = () => setPhoneScale(Math.max(.3, Math.min(2, el.clientWidth / 360)))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [phoneView])
  useEffect(() => {
    if (tab !== 'transcript' || !playing || video.current?.paused || showAudit || editingCaption !== null || !activeTranscript) return
    const panel = transcriptPanel.current, caption = activeCaption.current
    if (!panel || !caption) return
    const bounds = panel.getBoundingClientRect(), row = caption.getBoundingClientRect()
    if (row.top >= bounds.top + 12 && row.bottom <= bounds.bottom - 12) return
    // Scroll only the inspector, leaving the video and timeline in place.
    const inset = Math.max(12, (panel.clientHeight - row.height) / 2)
    panel.scrollTo({ top: panel.scrollTop + row.top - bounds.top - inset,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    return () => { panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' }) }
  }, [activeTranscript, playing, tab, selected, showAudit, editingCaption])
  useEffect(() => {
    if (editingCaption === null || tab !== 'transcript' || !captionInput.current || !transcriptPanel.current) return
    const input = captionInput.current, panel = transcriptPanel.current
    input.focus({ preventScroll: true })
    panel.scrollTo({ top: panel.scrollTop + input.getBoundingClientRect().top - panel.getBoundingClientRect().top - 36, behavior: 'instant' })
  }, [editingCaption, tab])
  useEffect(() => {
    const v = video.current
    if (!v) return
    let callback = 0
    const presented: VideoFrameRequestCallback = (_, metadata) => {
      const sourceFrames = candidateRef.current?.camera_scan?.frames ?? []
      const t = snapFrame(sourceFrames, Math.round((metadata.mediaTime * 1000 + previewStartRef.current) * 1000) / 1000)
      presentedTime.current = t
      if (!v.seeking && !v.paused) setTime(t)
      callback = v.requestVideoFrameCallback(presented)
    }
    callback = v.requestVideoFrameCallback(presented)
    return () => v.cancelVideoFrameCallback(callback)
  }, [session?.previewPath])
  useEffect(() => {
    const el = brollVideo.current
    const c = candidateRef.current
    if (!el) return
    if (!c) { el.pause(); return }
    const t = timeRef.current
    const clip = c.brolls?.find((b) => /\.(mp4|m4v|mov|webm)$/i.test(b.asset) && t >= b.start_ms && t < b.end_ms)
    if (!clip) { el.pause(); return }
    const expected = (t - clip.start_ms) / 1000
    if (Math.abs(el.currentTime - expected) > .3) el.currentTime = expected
    el.playbackRate = c.video_speed * reviewSpeed
    if (playing && el.paused) void el.play().catch(() => {})
    if (!playing && !el.paused) el.pause()
    // Picture-in-Picture: the corner window mirrors the main preview exactly.
    const pip = pipSpeaker.current, main = video.current
    if (pip && main && clip && (c.brolls ?? []).some((b) => b.layout === 'pip' && t >= b.start_ms && t < b.end_ms)) {
      if (Math.abs(pip.currentTime - main.currentTime) > .3) pip.currentTime = main.currentTime
      pip.playbackRate = main.playbackRate
      if (playing && pip.paused) void pip.play().catch(() => {})
      if (!playing && !pip.paused) pip.pause()
    } else if (pip && !pip.paused) pip.pause()
  }, [time, playing, reviewSpeed])
  useEffect(() => {
    let frame = 0
    const draw = (): void => {
      const v = video.current, out = canvas.current, c = candidateRef.current
      if (v && out && c && v.readyState >= 2 && !v.seeking) {
        // A paused seek can decode the frame just before a layout boundary.
        // Keep the preview on the same selected time as the crop controls;
        // during playback, follow the actual presented frame for cut accuracy.
        let t = v.paused ? timeRef.current : presentedTime.current ?? previewToSourceMs(v.currentTime)
        if (!v.paused && previewCutRef.current) {
          const clockTime = previewToSourceMs(v.currentTime)
          const range = c.ranges.find(([, end]) => end > clockTime)
          if (!range) { v.pause(); t = c.ranges.at(-1)![1]; v.currentTime = sourceToPreviewSeconds(t); presentedTime.current = null; setTime(t) }
          else if (clockTime < range[0]) { t = range[0]; v.currentTime = sourceToPreviewSeconds(t); presentedTime.current = null }
        }
        const scene = framingAt(c, t), ctx = out.getContext('2d')!
        ctx.clearRect(0, 0, out.width, out.height)
        if (scene.layout === 'fit') {
          ctx.filter = 'blur(16px) brightness(.75)'; ctx.drawImage(v, 0, 0, out.width, out.height); ctx.filter = 'none'
          const scale = Math.min(out.width / v.videoWidth, out.height / v.videoHeight)
          const w = v.videoWidth * scale, h = v.videoHeight * scale
          ctx.drawImage(v, (out.width - w) / 2, (out.height - h) / 2, w, h)
        } else scene.crops.forEach(([x, y, w, h], i) => ctx.drawImage(v, x * v.videoWidth, y * v.videoHeight, w * v.videoWidth, h * v.videoHeight, 0, i * out.height / scene.crops.length, out.width, out.height / scene.crops.length))
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  const run = async (action: 'review' | 'export' | 'export-all' | 'scan-cameras' | 'auto-frame' | 'build-preview', subject?: { atMs: number; x: number; y: number }): Promise<void> => {
    if (!candidate || busy) return
    video.current?.pause(); setError(null); setNotice(null); setBatch(undefined); setBusy(action)
    setProgress(action === 'scan-cameras' || action === 'auto-frame' ? { phase: 'scan', percent: 0 } : action === 'build-preview' ? { phase: 'preview', percent: 0 } : undefined)
    let saved = false, active = true, pollPending = false, polling: number | undefined
    const count = edits.filter((c) => c.status === 'ready').length
    try {
      await save()
      saved = true
      if (action === 'export-all') setBatch({ completed: 0, total: count })
      if (action === 'export-all' || action === 'scan-cameras' || action === 'auto-frame' || action === 'build-preview') {
        polling = window.setInterval(() => {
          if (pollPending) return
          pollPending = true
          void getApi().editor.progress(outputDir).then((s) => {
            if (!active) return
            if (s.batch) setBatch(s.batch)
            if (s.progress) setProgress(s.progress)
          }).catch(() => {}).finally(() => { pollPending = false })
        }, 1000)
      }
      const s = await getApi().editor.run(outputDir, sessionRef.current!.project.revision, candidate.id, action)
      setSession(s); sessionRef.current = s; setEdits(s.project.candidates); setUndo([]); setRedo([])
      editsRef.current = s.project.candidates
      previewStartRef.current = s.project.preview_start_ms ?? 0
      previewEndRef.current = s.project.preview_end_ms ?? s.project.duration_ms
      previewPartialRef.current = previewWindow(s.project) !== null
      setSpeakerNames(s.project.speaker_names ?? {}); speakerNamesRef.current = s.project.speaker_names ?? {}
      savedKey.current = JSON.stringify([s.project.candidates.map(candidateEdit), s.project.speaker_names ?? {}])
      keyRef.current = savedKey.current
      if (action === 'scan-cameras') { setSelectedCamera(null); setTab('framing'); setNotice('Scan complete. Select a camera marker to inspect the cut, insert a layout, or dismiss it. Arrow keys step through source frames.') }
      if (action === 'auto-frame') setNotice('Auto-frame complete. Layouts now follow the detected speakers; your cuts, captions and review are kept. Bake the clip to apply them.')
      if (action === 'build-preview') setNotice('Full preview ready. You can scrub and trim anywhere in the video.')
      if (action === 'export-all') setNotice(`Baked ${count} ready clip${count === 1 ? '' : 's'}. Your exports are ready.`)
    } catch (e) {
      // Earlier exports in a batch are durable even if a later one fails.
      if (saved) { await load(); setUndo([]); setRedo([]) }
      const message = errorMessage(e)
      setError(action === 'scan-cameras' && message.includes('Invalid editor operation')
        ? 'Restart BridgeClip to load camera scanning. Your edits are saved.'
        : action === 'auto-frame' && message.includes('Invalid editor operation')
        ? 'Restart BridgeClip to enable auto-framing. Your edits are saved.'
        : action === 'build-preview' && message.includes('Invalid editor operation')
        ? 'Restart BridgeClip to prepare the full preview. Your edits are saved.'
        : message)
      if (message.includes(EDITOR_REVISION_CONFLICT)) setConflict(true)
    } finally { active = false; window.clearInterval(polling); setBusy(null); setBatch(undefined); setProgress(undefined) }
  }
  // A reel outside the fast preview's window cannot play from it. Build the
  // full preview lazily when the user jumps to one: "Edit this" on another
  // reel of the same run, the candidate rail, or an unfocused open. A failed
  // build never retries from here; the monitor's button remains the retry.
  useEffect(() => {
    previewBuildRef.current = false
    if (!candidate || busy || reelPlayable(candidate)) return
    previewBuildRef.current = true
    void run('build-preview')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, session?.previewPath])
  const chooseReplacement = async (): Promise<void> => {
    video.current?.pause(); setEditingCaption(null)
    try {
      if (typeof getApi().editor.replaceSource !== 'function') throw new Error('Restart BridgeClip to enable source replacement. Your edits will be saved when you leave the editor.')
      setReplacement(await getApi().dialog.selectVideo())
    } catch (e) { setError(errorMessage(e)) }
  }
  const replaceSource = async (path: string): Promise<void> => {
    setBusy('replace-source'); setError(null); setNotice(null)
    let saved = false
    try {
      await save(); saved = true
      await getApi().editor.replaceSource(outputDir, sessionRef.current!.project.revision, path)
      await load(); setUndo([]); setRedo([])
      setNotice('Source replaced. Your edits are preserved. Previously baked clips are ready to bake again; existing exports are unchanged.')
    } catch (e) {
      if (saved) await load()
      setError(errorMessage(e))
    } finally { setBusy(null) }
  }
  const freeMedia = async (): Promise<void> => {
    setBusy('save'); setError(null); setNotice(null)
    try {
      await save()
      const s = await getApi().editor.freeMedia(outputDir, sessionRef.current!.project.revision)
      setSession(s); sessionRef.current = s; setUndo([]); setRedo([])
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(null) }
  }
  // Every hook lives above the early returns below: a conditional hook count
  // makes React throw "Rendered more hooks" the moment the session loads in.
  const fillerHits = useMemo(() => (session && fillersOn ? detectFillers(session.project.transcript).filter((hit) => !cleanupSkipped.includes(`f:${hit.start_ms}`)) : []),
    [session?.project.transcript, fillersOn, cleanupSkipped])
  const pauseHits = useMemo(() => (session && pausesOn ? detectPauses(session.project.transcript, pauseThreshold).filter((pause) => !cleanupSkipped.includes(`p:${pause.start_ms}`)) : []),
    [session?.project.transcript, pausesOn, pauseThreshold, cleanupSkipped])
  const censorStems = useMemo(() => candidate?.censor?.words ?? [], [candidate?.censor?.words])
  const viewWindow = useMemo<[number, number] | null>(() => {
    if (!session || !candidate) return null
    const start = candidate.ranges[0][0], end = candidate.ranges[candidate.ranges.length - 1][1]
    return dragWindow ?? zoomWindow ?? (timelineZoom === 'source' ? [0, session.project.duration_ms] : [Math.max(0, start - 10000), Math.min(session.project.duration_ms, end + 10000)])
  }, [session, candidate, dragWindow, zoomWindow, timelineZoom])
  const snapTargets = useMemo(() => (session && candidate ? snapPoints(candidate, session.project.transcript, session.project.duration_ms) : []),
    [candidate?.ranges, candidate?.scenes, session?.project.transcript, session?.project.duration_ms])
  const snapWindow = useMemo(() => (viewWindow ? Math.max(40, (viewWindow[1] - viewWindow[0]) / 500) : 40), [viewWindow])
  const snap = useCallback((t: number): number => (snapping ? snapTo(snapTargets, t, snapWindow) : t),
    [snapping, snapTargets, snapWindow])
  if (session?.project.media_freed) return <div className="p-8 space-y-4">{leading}
    <p role="status" className="text-sm">Editor media for this project was freed to save disk space. Your exported clips are unchanged; the project is now read-only.</p>
    <Button onClick={() => { void onExports().catch((e) => setError(errorMessage(e))) }}>View exports</Button>{error && <p role="alert" className="text-danger">{error}</p>}</div>
  if (!session || !candidate || !currentScene) return <div className="p-8 space-y-4">{leading}<p role={error ? 'alert' : 'status'}>{error ?? 'Opening editor…'}</p><Button onClick={() => { void load() }}>Retry</Button></div>
  const safeLeading = isValidElement<{ onClick?: () => void }>(leading) && leading.props.onClick
    ? cloneElement(leading, { onClick: () => { void save().then(() => leading.props.onClick?.()).catch((e) => setError(errorMessage(e))) } }) : leading
  const project = session.project, aspect = project.aspect_ratio === '9:16' ? 9 / 16 : project.aspect_ratio === '1:1' ? 1 : 16 / 9

  const cleanupSavedMs = fillerHits.reduce((total, hit) => total + hit.end_ms - hit.start_ms, 0) +
    pauseHits.reduce((total, pause) => total + pause.end_ms - pause.start_ms, 0)
  const applyCleanup = (): void => {
    if (!candidate || editingDisabled || (!fillerHits.length && !pauseHits.length)) return
    let ranges = candidate.ranges
    let caption_edits = [...(candidate.caption_edits ?? [])]
    try {
      for (const pause of pauseHits) ranges = cutRanges(ranges, pause.start_ms, pause.end_ms)
      for (const hit of fillerHits) {
        const words = project.transcript[hit.segment]?.words ?? []
        if (!words.length) continue
        const next = cutWords(ranges, caption_edits, hit.segment, words, hit.word_from, hit.word_to)
        ranges = next.ranges; caption_edits = next.caption_edits
      }
    } catch (e) { setError(errorMessage(e)); return }
    change({ ranges, caption_edits })
    setCleanupSkipped([])
    setNotice(`Cleanup applied — about ${(cleanupSavedMs / 1000).toFixed(1)}s shorter. Every cut is reversible with Restore.`)
  }
  // A fast per-reel import's preview covers only this window of the source.
  const previewRange = previewWindow(project)
  // Renderer hot reload can precede a main-process restart in development.
  // Older editor sessions omit this field; treat them like legacy projects.
  const suppressedCaptions = candidate.caption_suppression_ranges ?? []
  const activeSpeakerId = speakerAt(project.transcript, time)
  const activeSpeaker = activeSpeakerId ? project.speaker_names?.[activeSpeakerId] ?? activeSpeakerId : null
  /** Keyword highlight for word-token transcript lines (same vocabulary as line mode). */
  const keywordSet = new Set((project.keywords ?? []).map((k) => k.toLowerCase()))
  const keywordWord = (text: string): boolean => keywordSet.has(text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, ''))
  const captionPosition = candidate.caption_y ?? captionAnchor(project, candidate, time).y
  const captionXPosition = candidate.caption_x ?? 0.5
  const moveCaption = (x: number, y: number, remember = true): void => { video.current?.pause(); change({ caption_x: Math.round(x * 1000) / 1000, caption_y: Math.round(y * 1000) / 1000 }, remember) }
  const status = candidate.status ?? 'refining'
  const readyCount = edits.filter((c) => c.status === 'ready').length
  const finished = editorProgress(edits).remaining === 0
  const editingDisabled = !!busy || status === 'discarded'
  const captionText = (index: number): string => candidate.caption_edits?.find((e) => e.segment === index)?.text ?? project.transcript[index].text
  const canEditCaption = (index: number): boolean => !editingDisabled && (candidate.caption_edits.length < 2000 || candidate.caption_edits.some((e) => e.segment === index))
  const editCaption = (index: number): void => {
    if (!canEditCaption(index)) return
    video.current?.pause(); firstCaptionChange.current = true; setTab('transcript'); setEditingCaption(index)
  }
  const updateCaption = (index: number, text: string, remember = true): void => {
    const caption_edits = (candidate.caption_edits ?? []).filter((e) => e.segment !== index)
    if (text !== project.transcript[index].text) caption_edits.push({ segment: index, text })
    change({ caption_edits: caption_edits.sort((a, b) => a.segment - b.segment) }, remember)
  }
  const current = reviewCurrent(candidate)
  const assetPaths = session.assetPaths ?? {}
  const logoSrc = candidate.logo?.asset ? assetPaths[candidate.logo.asset] : undefined
  const activeBrolls = (candidate.brolls ?? []).filter((b) => time >= b.start_ms && time < b.end_ms)
  const activeTextOverlays = (candidate.text_overlays ?? []).filter((o) => time >= o.start_ms && time < o.end_ms)
  const activeBadges = (candidate.cta_badges ?? []).filter((b) => b.start_ms === undefined || (time >= b.start_ms && time < (b.end_ms ?? Infinity)))
  // Phone view: approximate where the platform's own UI would cover our baked overlays.
  const phoneWarnings = phoneView && aspect < 1 ? phoneSafeZoneWarnings(phoneSkin, [
    ...(logoSrc && candidate.logo ? [{ label: 'Logo', rect: overlayRect(candidate.logo.position, candidate.logo.scale, candidate.logo.scale * .5625) }] : []),
    ...activeBadges.map((b) => ({ label: b.kind === 'subscribe' ? 'Subscribe badge' : 'Follow badge', rect: overlayRect(b.position, .22, .06) })),
    ...activeTextOverlays.map((o) => ({ label: 'Text overlay', rect: overlayRect(o.position, .6, .08) })),
    ...(candidate.captions && !suppressedCaptions.some(([a, b]) => a <= time && time < b)
      ? [{ label: 'Captions', rect: { x: .05, y: Math.min(.86, Math.max(.02, captionPosition - .06)), w: .9, h: .12 } }] : [])
  ]) : []
  const uploadLogo = async (): Promise<void> => {
    try { const picked = await getApi().editor.addAsset(outputDir, 'image'); if (picked) change({ logo: { asset: picked.asset, position: 'top-right', scale: .18, opacity: 1 } }) }
    catch (e) { setError(errorMessage(e)) }
  }
  const toggleBadge = (kind: CtaBadge['kind']): void => {
    const badges = candidate.cta_badges ?? []
    const cta_badges: CtaBadge[] = badges.some((b) => b.kind === kind)
      ? badges.filter((b) => b.kind !== kind)
      : [...badges, { kind, position: 'bottom-right' }]
    change({ cta_badges })
  }
  const badgePosition = (kind: CtaBadge['kind'], position: OverlayPosition): void =>
    change({ cta_badges: (candidate.cta_badges ?? []).map((b) => b.kind === kind ? { ...b, position } : b) })
  /** Capture this clip's brand look (logo + badge + caption style + format) as a reusable pack. */
  const saveBrandPack = async (): Promise<void> => {
    try {
      // window.prompt is unsupported under Electron; auto-name the pack and
      // rename it from the Templates page.
      const name = `Brand pack ${new Date().toLocaleDateString()}`
      if (!name) return
      const api = getApi()
      const taken = await api.templates.list()
      const badge = (candidate.cta_badges ?? [])[0]
      // The editor's per-scene layouts map back to the job framing where they can:
      // split is editor-only, so a split clip keeps the pack framing-neutral.
      const sceneLayout = candidate.scenes[0]?.layout
      // The logo asset lives in this run's folder; main copies it into the pack's own folder.
      const logoPath = candidate.logo ? assetPaths[candidate.logo.asset] ?? null : null
      // Uploaded intro/outro ride along, so the pack can brand every new project.
      const introPath = candidate.intro_asset ? assetPaths[candidate.intro_asset] ?? null : null
      const outroPath = candidate.outro_asset ? assetPaths[candidate.outro_asset] ?? null : null
      const packName = (path: string): string => path.split(/[\\/]/).pop() ?? path
      const template: BrandTemplate = {
        id: uniqueTemplateId(name, taken.map((t) => t.id)),
        name: name.slice(0, 80),
        captionPresetId: (captionPresetIds as readonly string[]).includes(candidate.caption_preset) ? candidate.caption_preset : 'pop',
        formats: [project.aspect_ratio],
        ...(candidate.logo ? { logo: { position: candidate.logo.position, scale: candidate.logo.scale, opacity: candidate.logo.opacity } } : {}),
        ...(introPath ? { intro: packName(introPath) } : {}),
        ...(outroPath ? { outro: packName(outroPath) } : {}),
        ...(badge ? { badge: { kind: badge.kind, position: badge.position } } : {}),
        ...(sceneLayout === 'fill' || sceneLayout === 'fit' ? { layoutStyle: sceneLayout } : {})
      }
      const saved = await api.templates.save(template, logoPath, introPath, outroPath)
      setNotice(`Brand pack “${saved.name}” saved. Pick it at the top of Create — rename it anytime in Templates.`)
    } catch (e) { setError(errorMessage(e)) }
  }
  const layoutName = (l: EditorScene['layout']): string => l[0].toUpperCase() + l.slice(1)
  const start = candidate.ranges[0][0], end = candidate.ranges[candidate.ranges.length - 1][1]
  const [viewStart, viewEnd] = viewWindow ?? [0, project.duration_ms]
  const zoomSlider = Math.max(0, Math.min(100, Math.round(14.5 * Math.log2(project.duration_ms / Math.max(1, viewEnd - viewStart)))))
  const sceneIndex = candidate.scenes.indexOf(currentScene)
  const canAnimate = canAnimateScene(candidate.scenes, sceneIndex)
  const crop = currentScene.crops[Math.min(panel, currentScene.crops.length - 1)]
  const sceneChange = (patch: Partial<EditorScene>, remember = true): void => change({ scenes: candidate.scenes.map((s, i) => i === sceneIndex ? { ...s, ...patch } : s) }, remember)
  const cropChange = (c: Crop, remember = true): void => sceneChange({ crops: currentScene.crops.map((r, i) => i === Math.min(panel, currentScene.crops.length - 1) ? c : r) }, remember)
  const setLayout = (layout: EditorScene['layout']): void => {
    setPanel(0)
    sceneChange({ layout, crops: layout === 'split' ? [defaultCrop(project.width, project.height, aspect * 2, .25), defaultCrop(project.width, project.height, aspect * 2, .75)] : [defaultCrop(project.width, project.height, aspect)] })
  }

  /** Editor upgrade: apply one layout to every selected timeline cut in a single undo step. */
  const applyLayoutToCuts = (layout: EditorScene['layout'], cuts: number[]): void => {
    if (!cuts.length || editingDisabled) return
    const touched = new Set<number>()
    const scenes = candidate.scenes.map((scene, si) => {
      const covers = cuts.some((cut) => {
        const [a, b] = candidate.ranges[cut] ?? [NaN, NaN]
        return scene.at_ms < b && (si + 1 >= candidate.scenes.length || candidate.scenes[si + 1].at_ms > a)
      })
      if (!covers || touched.has(scene.at_ms)) return scene
      touched.add(scene.at_ms)
      return { ...scene, layout, crops: layout === 'split' ? [defaultCrop(project.width, project.height, aspect * 2, .25), defaultCrop(project.width, project.height, aspect * 2, .75)] : [defaultCrop(project.width, project.height, aspect)] }
    })
    change({ scenes })
    setNotice(`Layout set to ${layoutName(layout)} on ${touched.size} scene${touched.size === 1 ? '' : 's'} across ${cuts.length} section${cuts.length === 1 ? '' : 's'}.`)
  }

  /** Shift+click on a timeline piece toggles its batch selection. */
  const toggleCutSelection = (index: number, shift: boolean): void => {
    setSelectedCuts((cuts) => cuts.includes(index) ? cuts.filter((c) => c !== index) : shift ? [...cuts, index] : [index])
  }

  /** Editor upgrade: quick layout cycle directly on a timeline piece. */
  const cyclePieceLayout = (cutIndex: number): void => {
    if (editingDisabled) return
    const a = candidate.ranges[cutIndex]?.[0]
    if (a === undefined) return
    const sceneIndexAtCut = candidate.scenes.findIndex((scene, si) => scene.at_ms <= a && (si + 1 >= candidate.scenes.length || candidate.scenes[si + 1].at_ms > a))
    if (sceneIndexAtCut < 0) return
    const order: EditorScene['layout'][] = ['fill', 'split', 'fit']
    const current = candidate.scenes[sceneIndexAtCut].layout
    const next = order[(order.indexOf(current) + 1) % order.length]
    const scenes = candidate.scenes.map((scene, si) => si === sceneIndexAtCut
      ? { ...scene, layout: next, crops: next === 'split' ? [defaultCrop(project.width, project.height, aspect * 2, .25), defaultCrop(project.width, project.height, aspect * 2, .75)] : [defaultCrop(project.width, project.height, aspect)] }
      : scene)
    change({ scenes })
  }
  const newLayout = (position?: number): void => {
    const v = video.current
    if (!v || editingDisabled) return
    v.pause()
    const at = snapFrame(frames, position ?? presentedTime.current ?? previewToSourceMs(v.currentTime))
    if (candidate.scenes.length >= 60 || at <= start || at >= end || candidate.scenes.some((s) => Math.abs(s.at_ms - at) < .01)) return
    change({ scenes: [...candidate.scenes, { ...structuredClone(framingAt(candidate, at)), at_ms: at, transition_ms: undefined }].sort((a, b) => a.at_ms - b.at_ms) })
    // Keep the exact frame boundary selected while adjusting its crops.
    seek(at); setTab('framing')
  }
  const moveScene = (index: number, at: number): void => {
    if (editingDisabled) return
    const scenes = retimeScene(candidate.scenes, index, at, project.duration_ms, frames)
    if (scenes === candidate.scenes) return
    video.current?.pause(); change({ scenes }); seek(scenes[index].at_ms); setTab('framing')
    if (scenes[index].at_ms < viewStart || scenes[index].at_ms > viewEnd) setTimelineZoom('source')
  }
  const startSceneDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); video.current?.pause()
    const target = e.currentTarget, bounds = target.parentElement!.getBoundingClientRect(), x = e.clientX
    const original = candidate.scenes[index].at_ms
    let previous = original, changed = false
    seek(original); setTab('framing'); setDragWindow([viewStart, viewEnd])
    dragging.current = true; target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId)
    const move = (event: PointerEvent): void => {
      if (!changed && Math.abs(event.clientX - x) < 3) return
      const t = original + (event.clientX - x) / bounds.width * (viewEnd - viewStart)
      const marker = cameraMarkers(candidate, cameraThreshold).reduce<number | null>((best, m) => Math.abs(m.at_ms - t) <= (viewEnd - viewStart) * 8 / bounds.width && (best === null || Math.abs(m.at_ms - t) < Math.abs(best - t)) ? m.at_ms : best, null)
      const scenes = retimeScene(candidate.scenes, index, Math.max(viewStart, Math.min(viewEnd, marker ?? snap(t))), project.duration_ms, frames)
      const next = scenes[index].at_ms
      if (next === previous) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      setEdits((items) => items.map((c, i) => i === selected ? refineEdit(c, { scenes }) : c))
      seek(next)
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      dragging.current = false; setDragWindow(null)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  const startCropDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number, corner?: CropCorner): void => {
    if (editingDisabled || e.button !== 0) return
    e.preventDefault(); e.stopPropagation(); setPanel(index); video.current?.pause()
    const target = e.currentTarget, bounds = target.closest('.editor-source-frame')!.getBoundingClientRect()
    const x = e.clientX, y = e.clientY, original = [...currentScene.crops[index]] as Crop
    let previous = original, changed = false
    dragging.current = true; target.focus({ preventScroll: true }); target.setPointerCapture(e.pointerId); setCropDragging(true)
    const move = (event: PointerEvent): void => {
      const dx = event.clientX - x, dy = event.clientY - y
      const next: Crop = corner ? resizeCrop(original, corner, dx, dy, bounds.width, bounds.height)
        : [Math.max(0, Math.min(1 - original[2], original[0] + dx / bounds.width)), Math.max(0, Math.min(1 - original[3], original[1] + dy / bounds.height)), original[2], original[3]]
      if (next.every((n, i) => Math.abs(n - previous[i]) < 1e-10)) return
      if (!changed) { setUndo((u) => [...u.slice(-49), edits]); setRedo([]); changed = true }
      previous = next
      // Multi-select editing: a plain move with several cuts selected slides
      // every selected cut's crop by the same delta (resizes stay per-scene).
      const batch = !corner && selectedCuts.length > 1
        ? { dx: next[0] - original[0], dy: next[1] - original[1] } : null
      const covers = (si: number): boolean => selectedCuts.some((cut) => {
        const [a, b] = candidate.ranges[cut] ?? [NaN, NaN]
        return candidate.scenes[si].at_ms < b && (si + 1 >= candidate.scenes.length || candidate.scenes[si + 1].at_ms > a)
      })
      setEdits((items) => items.map((c, ci) => ci !== selected ? c : refineEdit(c, {
        scenes: c.scenes.map((s, si) => {
          if (si !== sceneIndex && !(batch && covers(si))) return s
          const crops = s.crops.map((crop, i) => {
            if (i !== index) return crop
            if (si === sceneIndex) return next
            const moved: Crop = [Math.max(0, Math.min(1 - crop[2], crop[0] + batch!.dx)), Math.max(0, Math.min(1 - crop[3], crop[1] + batch!.dy)), crop[2], crop[3]]
            return moved
          })
          return { ...s, crops }
        })
      })))
    }
    const done = (): void => {
      target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done)
      dragging.current = false; setCropDragging(false)
    }
    target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
  }
  return <section ref={editorRoot} className="clip-editor" aria-label="Clip editor">
    <header className="editor-header"><Button size="sm" variant="ghost" icon={<Eraser size={14} />} tooltip="Speech cleanup — find and cut retakes, restarts and repeated phrases."
    onClick={() => { setCleanupFocus({ nonce: Date.now() }) }}>Speech cleanup</Button><div className="min-w-0 flex-1"><div className="flex items-center gap-3">{safeLeading}<span className="truncate text-sm font-medium">{project.title}</span></div><span className="text-2xs text-ink-subtle">{saving ? 'Saving…' : key !== savedKey.current ? 'Unsaved changes' : 'All changes saved'}</span></div>
      <Button variant="ghost" size="sm" onClick={() => setShowAudit(true)}>Transcript & edits</Button>
      {finished && <Button variant="ghost" size="sm" disabled={!!busy} tooltip="Every clip is baked or discarded. Delete this project's source copy and preview; exports stay in the Library." onClick={() => setConfirmFree(true)}>Free editor media{session.mediaBytes ? ` (${formatBytes(session.mediaBytes)})` : ''}</Button>}
      <Button size="sm" disabled={!!busy} onClick={() => { void save().then(onExports).catch((e) => setError(errorMessage(e))) }}>Exports</Button>
      <div className="editor-bake-actions" role="group" aria-label="Bake clips">
      <Button variant="primary" size="sm" disabled={!!busy || status !== 'ready'} title={status !== 'ready' ? 'Mark this clip ready after refining it' : 'Render the final clip with your changes'} icon={<Download size={14} />} onClick={() => { void run('export') }}>{candidate.captions ? 'Bake captions' : 'Render clip'}</Button>
      <ActionMenu label="More bake options" disabled={!!busy || readyCount === 0} icon={<ChevronDown aria-hidden size={14} />} triggerClassName="btn-primary editor-bake-toggle disabled:opacity-100" actions={[{ label: `Bake all ready clips (${readyCount})`, disabled: readyCount === 0, icon: <Download size={14} />, onSelect: () => { void run('export-all') } }]} />
      </div>
    </header>
    <div className="px-[18px]"><SavedStageTimings outputDir={outputDir} /></div>
    <div className="editor-stagebar">
      <span className={cn('editor-status', status)}>{status === 'baked' || status === 'ready' ? <Check size={12} /> : status === 'discarded' ? <Archive size={12} /> : <Pencil size={12} />}{statusLabels[status]}</span>
      <span className="editor-stage-hint">{status === 'refining' ? 'Review the cut, framing and captions.' : status === 'ready' ? 'Ready for the final render.' : status === 'baked' ? 'Your finished clip is in Exports.' : 'Set aside. Restore it whenever you need.'}</span>
      <span className="editor-chip" title="Output aspect ratio">{project.aspect_ratio}</span>
      <span className="editor-chip" title="Layout at the playhead">Layout: {layoutName(currentScene.layout)}</span>
      <button className={cn('editor-chip', candidate.captions && 'on')} disabled={editingDisabled} title="Turn the burned-in caption track on or off" onClick={() => change({ captions: !candidate.captions })}>Track: {candidate.captions ? 'ON' : 'OFF'}</button>
      <div className="ml-auto flex gap-2">
        {status !== 'discarded' && <Button variant="ghost" size="sm" disabled={!!busy} icon={<Archive size={13} />} onClick={() => { video.current?.pause(); setEditingCaption(null); change({ status: 'discarded' }) }}>Discard</Button>}
        {status === 'refining' ? <Button size="sm" variant="primary" disabled={!!busy} icon={<Check size={13} />} onClick={() => { setEditingCaption(null); change({ status: 'ready' }) }}>Mark ready</Button>
          : <Button size="sm" disabled={!!busy} icon={<RotateCcw size={13} />} onClick={() => change({ status: 'refining' })}>{status === 'discarded' ? 'Restore clip' : status === 'baked' ? 'Refine again' : 'Keep refining'}</Button>}
      </div>
    </div>
    {error && <div role="alert" className="editor-notice text-danger">{conflict ? 'This project changed since the editor opened it, so your latest edits cannot be saved. Reload the project to continue from its saved state.' : error}{conflict
      ? <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => { setUndo([]); setRedo([]); bakedKeys.current.clear(); void load() }}>Reload project</Button>
      : key !== savedKey.current && <Button size="sm" variant="ghost" onClick={() => { setError(null); void save().catch((e) => setError(errorMessage(e))) }}>Retry save</Button>}</div>}
    {notice && !busy && <div role="status" className="editor-notice"><Check size={14} />{notice}<Button size="sm" variant="ghost" tooltip="Hide this completion message." aria-label="Dismiss bake notice" iconOnly icon={<X size={14} />} onClick={() => setNotice(null)} /></div>}
    {confirmFree && <ConfirmDialog onClose={closeFree} request={{
      title: 'Free editor media?', confirmLabel: 'Free media',
      body: <>Delete this project's copy of the source video and its editor preview{session.mediaBytes ? ` (${formatBytes(session.mediaBytes)})` : ''}?<br /><br />Your exported clips stay in the Library. The project becomes read-only: you won't be able to refine, re-bake or restore its clips again.</>,
      onConfirm: () => { void freeMedia() }
    }} />}
    {replacement && <ConfirmDialog onClose={closeReplacement} request={{
      title: 'Replace source video?', confirmLabel: 'Replace source', tone: 'primary',
      body: <>Use <strong>{replacement.split(/[\\/]/).pop()}</strong> for every clip in this project?<br /><br />Only recommended for the exact same video at higher quality: identical content, timing, audio and framing. Matching duration alone does not guarantee a match.<br /><br />Your cuts, layouts and caption edits will be kept. Previously baked clips will be ready to bake again. Existing exports will stay in the library.</>,
      onConfirm: () => { void replaceSource(replacement) }
    }} />}
    {busy && <div role="status" className="editor-notice"><Loader2 size={14} className="animate-spin" />{busy === 'scan-cameras' ? <div className="editor-scan-progress"><span>{progress?.phase === 'preview' ? 'Preparing frame-accurate preview (one-time)' : 'Scanning frames for camera changes'}… {progress?.percent ?? 0}%</span><progress aria-label={progress?.phase === 'preview' ? 'Preview preparation progress' : 'Camera scan progress'} max={100} value={progress?.percent ?? 0} /></div> : busy === 'auto-frame' ? <div className="editor-scan-progress"><span>Re-analyzing this clip to follow the active speaker… {progress?.percent ?? 0}%</span><progress aria-label="Auto-frame progress" max={100} value={progress?.percent ?? 0} /></div> : busy === 'build-preview' ? <div className="editor-scan-progress"><span>Preparing the full video preview… {progress?.percent ?? 0}%</span><progress aria-label="Full preview progress" max={100} value={progress?.percent ?? 0} /></div> : busy === 'replace-source' ? 'Replacing source and preparing preview…' : busy === 'export-all' ? `Baking ready clips… ${batch?.completed ?? 0} of ${batch?.total ?? readyCount} complete${batch?.failed ? `, ${batch.failed} failed` : ''}` : busy === 'review' ? 'Jev is reviewing your edit…' : busy === 'export' ? 'Baking your final clip…' : 'Saving…'}<Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(outputDir) }}>Cancel</Button></div>}
    <div className="editor-workspace">
      <aside className="editor-candidates"><div className="editor-pane-heading">Refine clips <span>{edits.length}</span></div>
        {(['refining', 'ready', 'baked', 'discarded'] as const).map((group) => {
          const items = edits.map((c, i) => ({ c, i })).filter(({ c }) => (c.status ?? 'refining') === group)
          if (!items.length) return null
          const cards = items.map(({ c, i }) => <button key={c.id} className={cn('editor-candidate', group, i === selected && 'selected')} onClick={() => setSelected(i)}>
            <span className="flex items-center justify-between text-2xs text-ink-subtle"><span>{String(i + 1).padStart(2, '0')}</span>{c.exports.length > 0 && <span title={`${c.exports.length} saved exports`} className="flex items-center gap-1"><Download size={11} />{c.exports.length}</span>}</span>
            <span className="block text-xs leading-relaxed mt-1">{c.title}</span><span className="flex items-center justify-between mt-2 text-2xs text-ink-subtle"><span>{formatTimecode(c.ranges[0][0])} · {(editDuration(c) / 1000).toFixed(1)}s</span><span title={!reviewCurrent(c) ? 'Jev review out of date' : c.review?.decision === 'passes' ? 'Jev checks passed' : 'Jev: consider before baking'} className={cn('editor-dot', !reviewCurrent(c) ? 'bg-ink-subtle' : c.review?.decision === 'passes' ? 'bg-success' : 'bg-warning')} /></span>
          </button>)
          return group === 'discarded'
            ? <details key={group} className="editor-discarded" open={status === 'discarded' ? true : undefined}><summary>Discarded <span>{items.length}</span><ChevronDown size={12} /></summary>{cards}</details>
            : <div key={group} className="editor-candidate-group"><div className={cn('editor-group-heading', group)}>{statusLabels[group]} <span>{items.length}</span></div>{cards}</div>
        })}
      </aside>
      <div className="editor-center">
        <div className="editor-monitors">
          <div className="editor-source-monitor"><div className="editor-pane-heading">Source <span>{project.width} × {project.height}</span><Button size="sm" variant="ghost" disabled={!!busy || saving} onClick={() => { void chooseReplacement() }}>Replace source video</Button></div>
            <div className={cn('editor-source-frame', subjectArm && 'editor-subject-arm')} style={{ aspectRatio: project.width / project.height }}
              onClick={(e) => {
                if (!subjectArm || busy || editingDisabled) return
                const rect = e.currentTarget.getBoundingClientRect()
                const x = (e.clientX - rect.left) / rect.width, y = (e.clientY - rect.top) / rect.height
                if (x < 0 || x > 1 || y < 0 || y > 1) return
                setSubjectArm(false)
                const atMs = Math.round(time)
                void run('auto-frame', { atMs, x: Number(x.toFixed(4)), y: Number(y.toFixed(4)) }).then(() => {
                  setNotice(`Subject tracked from ${formatTimecode(atMs)} — framing now follows it across the clip.`)
                })
              }}>
              <video ref={video} src={localFileUrl(session.previewPath)} preload="auto" playsInline
                onLoadedMetadata={() => { seek(start); if (video.current) video.current.playbackRate = candidate.video_speed * reviewSpeed }}
                onPlay={() => setPlaying(true)} onPause={() => {
                  setPlaying(false)
                  const panel = transcriptPanel.current
                  if (panel) panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' })
                }} onEnded={() => setPlaying(false)}
                onError={() => setError('Source preview is unavailable. Reopen the project or check that its files still exist.')}
                onTimeUpdate={() => {
                  const v = video.current!; let t = previewToSourceMs(v.currentTime)
                  if (previewCut && !v.paused) {
                    const range = candidateRef.current!.ranges.find(([, b]) => t < b)
                    if (!range) { v.pause(); t = candidateRef.current!.ranges.at(-1)![1]; v.currentTime = sourceToPreviewSeconds(t) }
                    else if (t < range[0]) { t = range[0]; v.currentTime = sourceToPreviewSeconds(t) }
                  }
                  if (v.paused && presentedTime.current === null) setTime(t)
                }} />
              {activeSpeaker && <span className="editor-source-speaker">{activeSpeaker}</span>}
              {tab === 'framing' && currentScene.layout !== 'fit' && currentScene.crops.map((r, i) => {
                const name = currentScene.layout === 'split' ? (i === 0 ? 'top' : 'bottom') : 'output'
                return <div key={i} className={cn('editor-crop', i === panel && 'active')} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}>
                  <button className="editor-crop-move" aria-label={`Move ${name} crop`} disabled={editingDisabled} onPointerDown={(e) => startCropDrag(e, i)}>
                    <span>{currentScene.layout === 'split' ? i === 0 ? '1' : '2' : ''}</span>
                  </button>
                  {cropCorners.map((corner) => <button key={corner} className={cn('editor-crop-corner', corner)} aria-label={`Resize ${name} crop from ${corner}`} title="Drag to resize · Arrow keys adjust · Shift for larger steps" disabled={editingDisabled}
                    onPointerDown={(e) => startCropDrag(e, i, corner)} onKeyDown={(e) => {
                      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
                      e.preventDefault(); e.stopPropagation(); setPanel(i); video.current?.pause()
                      const bounds = e.currentTarget.closest('.editor-source-frame')!.getBoundingClientRect(), step = e.shiftKey ? 10 : 1
                      const next = resizeCrop(r, corner, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0, bounds.width, bounds.height)
                      if (next.some((n, index) => Math.abs(n - r[index]) > 1e-10)) sceneChange({ crops: currentScene.crops.map((c, ci) => ci === i ? next : c) })
                    }} />)}
                </div>
              })}
            </div>
            <p className="editor-monitor-hint">{tab === 'framing' ? 'Drag inside to move · Drag a corner to resize' : 'Space to play · I / O to trim · S to split'} · 1 / 2 / 3 for speed</p>
            {previewRange && <div className="editor-monitor-hint flex flex-wrap items-center gap-2" role="status">
              <span>Fast preview covers {clock(previewRange.startMs)} – {clock(previewRange.endMs)}{time < previewRange.startMs || time > previewRange.endMs ? ' · the playhead is outside it' : ''}.</span>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { void run('build-preview') }}>Prepare full preview</Button>
            </div>}
          </div>
          <div className="editor-output-monitor">
            <div className="editor-pane-heading">Output <span>{candidate.captions && suppressedCaptions.some(([a, b]) => a <= time && time < b) ? 'Captions suppressed' : project.aspect_ratio}</span>{aspect < 1 && <span className="editor-phone-controls"><Button size="sm" variant={phoneView ? 'primary' : 'ghost'} aria-pressed={phoneView} tooltip="Preview the clip inside a phone screen with the social app's interface, and get warned when your overlays fall into its blocked areas." onClick={() => setPhoneView((v) => !v)}>Phone</Button>{phoneView && <Select aria-label="Phone preview app" size="sm" className="w-24" value={phoneSkin} options={phoneSkins} onChange={(value) => setPhoneSkin(value as PhoneSkin)} />}</span>}</div>
            <div ref={outputFrame} className={cn('editor-output-frame', phoneView && aspect < 1 && 'editor-output-phone')} style={{ containerType: 'size', ...(phoneView && aspect < 1 ? { '--pu': phoneScale } as CSSProperties : {}) }}>
            <canvas ref={canvas} width={aspect < 1 ? 360 : 640} height={aspect < 1 ? 640 : 360}
              style={{ aspectRatio: aspect, filter: compareOriginal ? undefined : rangeEffectPreview(candidate.range_edits ?? [], time) || undefined }} />
            {showSubtitlePreview && <EditorCaptionPreview canvas={canvas} project={project} candidate={candidate} time={time} disabled={editingDisabled} onMove={moveCaption} onDrag={active => { dragging.current = active; if (active) video.current?.pause() }} />}
            <div className="editor-output-overlays" aria-hidden="true">
              {logoSrc && candidate.logo && <img className={cn('editor-overlay-logo', `editor-pos-${candidate.logo.position}`)} style={{ width: `${candidate.logo.scale * 100}%`, opacity: candidate.logo.opacity }} src={localFileUrl(logoSrc)} alt="" />}
              {activeBadges.map((b) => <span key={b.kind} className={cn('editor-overlay-badge', `editor-badge-${b.kind}`, `editor-pos-${b.position}`)}>{b.kind === 'subscribe' ? 'SUBSCRIBE' : 'FOLLOW'}</span>)}
              {activeBrolls.map((b, i) => /\.(mp4|m4v|mov|webm|mkv|avi|ts)$/i.test(b.asset)
                ? <video key={i} ref={brollVideo} className={cn('editor-overlay-broll', b.layout === 'split' && (b.swap ? 'editor-broll-split-top' : 'editor-broll-split-bottom'))} muted playsInline preload="auto" src={assetPaths[b.asset] ? localFileUrl(assetPaths[b.asset]) : undefined} />
                : <img key={i} className={cn('editor-overlay-broll', b.layout === 'split' && (b.swap ? 'editor-broll-split-top' : 'editor-broll-split-bottom'))} src={assetPaths[b.asset] ? localFileUrl(assetPaths[b.asset]) : undefined} alt="" />)}
              {activeBrolls.some((b) => b.layout === 'pip') &&
                <video ref={pipSpeaker} className="editor-pip-speaker" muted playsInline src={session?.previewPath ? localFileUrl(session.previewPath) : undefined} />}
              {activeTextOverlays.map((o, i) => {
                const preset = o.preset ? lowerThirdPreset(o.preset) : undefined
                if (o.style) {
                  const sameAnchor = activeTextOverlays.filter((other) => other.position === o.position)
                  const stack = sameAnchor.indexOf(o)
                  return <div key={i} className={cn('editor-overlay-textbox', `editor-pos-${o.position}`)}
                    style={{
                      background: o.style.background, color: o.style.color,
                      borderRadius: o.style.radius, padding: `${o.style.padding}em`,
                      fontFamily: { montserrat: 'Montserrat', poppins: 'Poppins', archivo: '"Archivo Black"', instrument: '"Instrument Serif"', jakarta: '"Plus Jakarta Sans"' }[o.style.font],
                      fontSize: `${o.style.size * 100 * 2.4}cqh`, lineHeight: 1.25,
                      textAlign: o.style.align, marginTop: stack > 0 ? `${stack * 1}em` : undefined
                    }}>{o.text}</div>
                }
                if (!preset) return <div key={i} className={cn('editor-overlay-text', `editor-pos-${o.position}`)}>{o.text}</div>
                return <div key={i} className={cn('editor-overlay-lt', `editor-pos-${o.position}`, preset.kind === 'location' && 'editor-lt-wide')}
                  style={{ '--lt': o.variant === 'color' && o.color ? o.color : preset.tone } as CSSProperties}>
                  {o.variant === 'image' && o.image && assetPaths[o.image] && <img src={localFileUrl(assetPaths[o.image])} alt="" />}
                  <span className="editor-lt-main">{o.text}</span>
                  {preset.sub && o.sub && <span className="editor-lt-sub">{o.sub}</span>}
                </div>
              })}
            </div>
            {phoneView && aspect < 1 && <><div className="phone-notch" aria-hidden="true" /><PhoneAppSkin skin={phoneSkin} title={candidate.title} /></>}
            </div>
            {phoneView && aspect < 1 && phoneWarnings.length > 0 && <div className="editor-phone-warnings" role="status">{phoneWarnings.map((w) => <p key={w}>{w}</p>)}</div>}
          </div>
        </div>
        <div className="editor-transport">
          <Button size="sm" variant="ghost" iconOnly icon={<ChevronLeft size={14} />} aria-label="Previous frame" tooltip="Move back one source frame. Exact after scanning; approximate outside scanned footage." disabled={!!busy || time <= .01} onClick={() => frameStep(-1)} />
          <Button size="sm" variant="ghost" iconOnly icon={<ChevronRight size={14} />} aria-label="Next frame" tooltip="Move forward one source frame. Exact after scanning; approximate outside scanned footage." disabled={!!busy || time >= project.duration_ms - 1 - .01} onClick={() => frameStep(1)} /><Button tooltip="Move the playhead to the beginning of this clip." aria-label="Back to start" iconOnly variant="ghost" icon={<SkipBack size={15} />} onClick={() => seek(start)} /><Button tooltip="Play or pause the preview. Shortcut: Space." aria-label="Play / pause" iconOnly icon={playing ? <Pause size={16} /> : <Play size={16} />} onClick={toggle} /><span className="font-mono text-xs">{clock(time)}</span><span className="text-ink-subtle text-2xs">/ {(editDuration(candidate) / 1000).toFixed(1)}s selected</span><label className="editor-review-speed" title="Preview only. Press 1/2/3 for speed; arrow keys step 1/2/3 source frames (1.5× rounds to two). Shift+arrows jump one second. Multiplies the clip’s export speed without changing the export.">Review speed<select aria-label="Review speed" value={reviewSpeed} onChange={(e) => {
            setReviewSpeed(Number(e.target.value))
            // Return Space to playback after choosing a speed.
            e.currentTarget.blur()
          }}>{[1, 1.5, 2, 3].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></label><label className="ml-auto flex gap-2 items-center text-2xs text-ink-muted"><input type="checkbox" checked={previewCut} onChange={(e) => setPreviewCut(e.target.checked)} />Play cuts only</label></div>
        <div className="editor-timeline">
          <div className="editor-timeline-tools">
            <CameraScanButton key={candidate.id} candidate={candidate} threshold={cameraThreshold} setThreshold={setCameraThreshold}
              restore={() => change({ dismissed_camera_markers: [] })} disabled={editingDisabled} onOpen={() => video.current?.pause()} scan={() => { void run('scan-cameras') }} />
            <Button variant="ghost" size="sm" tooltip="Undo the last editor change (⌘/Ctrl+Z)." aria-label="Undo" iconOnly icon={<Undo2 size={14} />} disabled={!undo.length || !!busy} onClick={() => history('undo')} /><Button variant="ghost" size="sm" tooltip="Redo the change you just undid (⌘/Ctrl+Shift+Z)." aria-label="Redo" iconOnly icon={<Redo2 size={14} />} disabled={!redo.length || !!busy} onClick={() => history('redo')} /><Button variant="ghost" size="sm" icon={<Scissors size={14} />} tooltip="Split the cut at the playhead into two editable sections. No footage is removed. Shortcut: S." onClick={split} disabled={editingDisabled || candidate.ranges.length >= 24}>Split</Button><Button variant="ghost" size="sm" disabled={editingDisabled || (time >= start && time <= end)} tooltip="Extend the clip’s beginning or ending to the playhead. Turn off Play cuts only to move beyond the current cut." onClick={() => { const t = video.current ? previewToSourceMs(video.current.currentTime) : time; if (t < start) trim('in', t); else if (t > end) trim('out', t) }}>Extend to playhead</Button>
            <Button variant="ghost" size="sm" iconOnly icon={<Trash2 size={14} />} tooltip="Remove the cut under the playhead. The source video is kept; Undo restores it." aria-label="Delete cut at playhead" disabled={editingDisabled || candidate.ranges.length <= 1 || !candidate.ranges.some(([a, b]) => time >= a && time < b)} onClick={() => { const i = candidate.ranges.findIndex(([a, b]) => time >= a && time < b); if (i >= 0 && candidate.ranges.length > 1) change({ ranges: candidate.ranges.filter((_, j) => j !== i) }) }} /><Button variant={snapping ? 'primary' : 'ghost'} size="sm" iconOnly icon={<Magnet size={14} />} tooltip="Snap Editing: drags lock onto cuts, speech lines and layout changes. Toggle with G." aria-label="Toggle Snap Editing" aria-pressed={snapping} onClick={() => setSnapping((value) => !value)} />
            <Button variant={candidate.auto_reframe === false ? 'ghost' : 'primary'} size="sm" iconOnly icon={<PersonStanding size={14} />} aria-pressed={candidate.auto_reframe !== false} tooltip="Auto Reframe: speaker tracking moves the crops. Toggle off to pin your crops." aria-label="Toggle Auto Reframe" disabled={editingDisabled} onClick={() => change({ auto_reframe: candidate.auto_reframe === false })} />
            <label className="editor-volume" title="Clip output volume, baked into the export"><Volume2 size={13} aria-hidden /><input type="range" aria-label="Clip volume" min={0} max={200} value={Math.round((candidate.audio_gain ?? 1) * 100)} onChange={(e) => change({ audio_gain: Number(e.target.value) / 100 })} /></label>
            <Button variant="ghost" size="sm" icon={showTimeline ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setShowTimeline((v) => !v)}>{showTimeline ? 'Hide timeline' : 'Show timeline'}</Button>
            <span className="ml-auto text-2xs text-ink-subtle">{clock(viewStart)} — {clock(viewEnd)}</span></div>
          <input aria-label="Source timeline" className="editor-source-scrub" type="range" min={0} max={project.duration_ms} step="any" value={time} onChange={(e) => seek(snapFrame(frames, Number(e.target.value)))} />
          {showTimeline && <>
          <CameraChanges candidate={candidate} threshold={cameraThreshold} selected={selectedCamera} deselect={deselectCamera}
            select={(t) => { video.current?.pause(); setSelectedCamera(t); seek(t); setTab('framing'); if (zoomWindow) setTimelineZoom([Math.max(0, t - 1000), Math.min(project.duration_ms, t + 1000)]) }}
            insert={newLayout} align={moveScene}
            remove={(t) => { change({ dismissed_camera_markers: [...(candidate.dismissed_camera_markers ?? []), t] }); setSelectedCamera(null) }}
            disabled={editingDisabled} viewStart={viewStart} viewEnd={viewEnd} clock={clock} />
          <div className="editor-overview" aria-label="All candidate moments">{edits.map((c, i) => <button key={c.id} title={c.title} aria-label={`Jump to candidate ${i + 1}: ${c.title}`} className={cn(i === selected && 'selected')} style={{ left: `${c.ranges[0][0] / project.duration_ms * 100}%`, width: `${(c.ranges.at(-1)![1] - c.ranges[0][0]) / project.duration_ms * 100}%`, top: (i % 3) * 4 }} onClick={() => { setSelected(i); seek(c.ranges[0][0]) }} />)}</div>
          <div className="editor-lane-handle" role="separator" aria-label="Element tracks height" aria-orientation="horizontal" aria-valuenow={laneHeight}
            title={laneHeight ? 'Drag up to collapse the element tracks' : 'Drag down to expand the element tracks'}
            onPointerDown={(e) => {
              e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId)
              const startY = e.clientY, startHeight = laneHeight
              const move = (ev: PointerEvent): void => setLaneHeight(Math.max(0, Math.min(240, startHeight + (ev.clientY - startY))))
              const done = (): void => { e.currentTarget.removeEventListener('pointermove', move); e.currentTarget.removeEventListener('lostpointercapture', done) }
              e.currentTarget.addEventListener('pointermove', move); e.currentTarget.addEventListener('lostpointercapture', done)
            }}>
            <GripHorizontal size={12} aria-hidden />
            <span className="text-2xs text-ink-subtle">{laneHeight > 20 ? 'Drag up to collapse element tracks' : 'Drag down to show element tracks'}</span>
          </div>
          {(() => {
            const brolls = candidate.brolls ?? [], texts = candidate.text_overlays ?? [], effects = candidate.range_edits ?? []
            if (laneHeight <= 20) return null
            const laneDragProps = (kind: LaneKind, index: number, edge: 'move' | 'l' | 'r', a: number, b: number) => ({
              onPointerDown: (e: React.PointerEvent<HTMLElement>) => { video.current?.pause(); dragging.current = true; setDragWindow([viewStart, viewEnd]); laneBlockDrag(e, kind, index, edge, a, b, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined) },
              // pointercancel skips pointerup entirely; without this the drag
              // flags stay stuck and Space stays swallowed.
              onPointerUp: () => { dragging.current = false; setDragWindow(null) },
              onPointerCancel: () => { dragging.current = false; setDragWindow(null) }
            })
            const percentLeft = (a: number): string => `${(Math.max(a, viewStart) - viewStart) / (viewEnd - viewStart) * 100}%`
            const percentWidth = (a: number, b: number): string => `${(Math.min(b, viewEnd) - Math.max(a, viewStart)) / (viewEnd - viewStart) * 100}%`
            const visible = (a: number, b: number): boolean => b > viewStart && a < viewEnd
            return <div className="editor-lanes" style={{ height: laneHeight }} aria-label="Element tracks">
              {!brolls.length && !texts.length && !effects.length && !candidate.voiceover?.audio_asset && <p className="editor-lanes-empty">B-roll, text, effects and voiceovers appear here as draggable tracks — add them from the tools on the right.</p>}
              {brolls.length > 0 && <div className="editor-lane">
                <span className="editor-lane-label">B-roll</span>
                <div className="editor-lane-track">
                  {brolls.map((r, i) => visible(r.start_ms, r.end_ms) && <div key={i} role="button" tabIndex={-1} aria-label={`B-roll ${i + 1}, ${clock(r.start_ms)} to ${clock(r.end_ms)}`}
                    className={cn('editor-lane-block', `editor-lane-${r.layout === 'split' ? 'split' : 'broll'}`)}
                    style={{ left: percentLeft(r.start_ms), width: percentWidth(r.start_ms, r.end_ms) }}
                    title={`B-roll ${i + 1} · ${clock(r.start_ms)}–${clock(r.end_ms)} · drag to move, edges to trim`}
                    onClick={() => { video.current?.pause(); seek(r.start_ms); setOpenTool('broll') }}
                    {...laneDragProps('broll', i, 'move', r.start_ms, r.end_ms)}>
                    <span className="editor-lane-edge" aria-label={`Trim start of B-roll ${i + 1}`} onPointerDown={(e) => laneBlockDrag(e, 'broll', i, 'l', r.start_ms, r.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                    B-roll {i + 1}{r.layout === 'split' ? ' · split' : ''}
                    <span className="editor-lane-edge" aria-label={`Trim end of B-roll ${i + 1}`} onPointerDown={(e) => laneBlockDrag(e, 'broll', i, 'r', r.start_ms, r.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                  </div>)}
                </div>
              </div>}
              {texts.length > 0 && <div className="editor-lane">
                <span className="editor-lane-label">Text</span>
                <div className="editor-lane-track">
                  {texts.map((o, i) => visible(o.start_ms, o.end_ms) && <div key={i} role="button" tabIndex={-1} aria-label={`Text ${i + 1}, ${clock(o.start_ms)} to ${clock(o.end_ms)}`}
                    className="editor-lane-block editor-lane-text"
                    style={{ left: percentLeft(o.start_ms), width: percentWidth(o.start_ms, o.end_ms) }}
                    title={`${o.text} · ${clock(o.start_ms)}–${clock(o.end_ms)} · drag to move, edges to trim`}
                    onClick={() => { video.current?.pause(); seek(o.start_ms); setOpenTool('text') }}
                    {...laneDragProps('text', i, 'move', o.start_ms, o.end_ms)}>
                    <span className="editor-lane-edge" aria-label={`Trim start of text ${i + 1}`} onPointerDown={(e) => laneBlockDrag(e, 'text', i, 'l', o.start_ms, o.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                    {o.text}
                    <span className="editor-lane-edge" aria-label={`Trim end of text ${i + 1}`} onPointerDown={(e) => laneBlockDrag(e, 'text', i, 'r', o.start_ms, o.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                  </div>)}
                </div>
              </div>}
              {effects.length > 0 && <div className="editor-lane">
                <span className="editor-lane-label">Effects</span>
                <div className="editor-lane-track">
                  {effects.map((r, i) => visible(r.start_ms, r.end_ms) && <div key={r.id} role="button" tabIndex={-1} aria-label={`${r.kind} effect ${i + 1}, ${clock(r.start_ms)} to ${clock(r.end_ms)}`}
                    className="editor-lane-block editor-lane-effect"
                    style={{ left: percentLeft(r.start_ms), width: percentWidth(r.start_ms, r.end_ms) }}
                    title={`${r.kind} · ${clock(r.start_ms)}–${clock(r.end_ms)} · drag to move, edges to trim`}
                    onClick={() => { video.current?.pause(); seek(r.start_ms); setOpenTool('effects') }}
                    {...laneDragProps('effect', i, 'move', r.start_ms, r.end_ms)}>
                    <span className="editor-lane-edge" aria-label={`Trim start of ${r.kind} effect`} onPointerDown={(e) => laneBlockDrag(e, 'effect', i, 'l', r.start_ms, r.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                    {r.kind}
                    <span className="editor-lane-edge" aria-label={`Trim end of ${r.kind} effect`} onPointerDown={(e) => laneBlockDrag(e, 'effect', i, 'r', r.start_ms, r.end_ms, viewStart, viewEnd, project.duration_ms, edits, selected, setEdits, setUndo, setRedo, snapping ? snap : undefined)} />
                  </div>)}
                </div>
              </div>}
              {(() => {
                const vo = candidate.voiceover
                if (!vo?.audio_asset || !vo.duration_ms) return null
                const a = vo.start_ms ?? 0, b = a + vo.duration_ms
                if (!visible(a, b)) return null
                return <div className="editor-lane">
                  <span className="editor-lane-label">Voice</span>
                  <div className="editor-lane-track">
                    <div role="button" tabIndex={-1} aria-label={`Voiceover, ${clock(a)} to ${clock(b)}`}
                      className="editor-lane-block editor-lane-voice"
                      style={{ left: percentLeft(a), width: percentWidth(a, b) }}
                      title={`Voiceover · ${clock(a)}–${clock(b)} · drag to move`}
                      onClick={() => { video.current?.pause(); seek(a); setOpenTool('voice') }}
                      {...laneDragProps('voice', 0, 'move', a, b)}>
                      Voice · {formatTimecode(b - a)}
                    </div>
                  </div>
                </div>
              })()}
            </div>
          })()}
          <div className="editor-track" onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            const track = e.currentTarget
            const msAt = (clientX: number): number => viewStart + (clientX - track.getBoundingClientRect().left) / Math.max(1, track.clientWidth) * (viewEnd - viewStart)
            const startX = e.clientX
            let banded = false
            const origin = selectedCuts
            e.currentTarget.setPointerCapture(e.pointerId)
            const move = (ev: PointerEvent): void => {
              if (!banded && Math.abs(ev.clientX - startX) < 6) return
              banded = true
              const lo = Math.max(viewStart, Math.min(viewEnd, msAt(Math.min(startX, ev.clientX))))
              const hi = Math.max(viewStart, Math.min(viewEnd, msAt(Math.max(startX, ev.clientX))))
              setBandSelect([lo, hi])
            }
            const done = (ev: PointerEvent): void => {
              track.removeEventListener('pointermove', move)
              track.removeEventListener('lostpointercapture', done)
              if (!banded) { seek(msAt(ev.clientX)); return }
              const [lo, hi] = bandSelect ?? [msAt(Math.min(startX, ev.clientX)), msAt(Math.max(startX, ev.clientX))]
              setBandSelect(null)
              const hits = candidate.ranges.map(([a, b], i) => a < hi && b > lo ? i : -1).filter((i) => i >= 0)
              if (!hits.length) return
              const union = new Set([...origin, ...hits])
              setSelectedCuts([...union].sort((x, y) => x - y))
            }
            track.addEventListener('pointermove', move)
            track.addEventListener('lostpointercapture', done)
          }}>
            <EditorFilmstrip previewPath={session.previewPath} previewStartMs={project.preview_start_ms ?? 0} strip={previewRange ?? { startMs: 0, endMs: project.duration_ms }} viewStart={viewStart} viewEnd={viewEnd} />
            {selectedCuts.length > 0 && (
              <div className="editor-batch-layout" role="group" aria-label="Batch layout for selected sections">
                <span className="text-2xs text-ink-subtle">{selectedCuts.length} selected — set layout:</span>
                {(['fill', 'split', 'fit'] as const).map((layout) => (
                  <button key={layout} disabled={editingDisabled}
                    onClick={() => { applyLayoutToCuts(layout, selectedCuts); setSelectedCuts([]) }}>
                    {layoutName(layout)}
                  </button>
                ))}
                <button className="editor-batch-clear" disabled={editingDisabled} onClick={() => setSelectedCuts([])}>Clear</button>
              </div>
            )}
            {candidate.ranges.map(([a, b], i) => <div key={`${candidate.id}-${i}`} className={cn('editor-timeline-piece', selectedCuts.includes(i) && 'editor-batch-selected')} style={{ left: `${(a - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(b - a) / (viewEnd - viewStart) * 100}%` }}><button className="editor-trim-handle" aria-label={`Trim start of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 0, a + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); dragging.current = true; setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 0, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => { dragging.current = false; setDragWindow(null) }, snap) }} /><button className="editor-piece-body" aria-label={`Seek within cut ${i + 1}. Shift+click selects it for batch layout`} onClick={(e) => {
              if ((e.shiftKey || e.metaKey || e.ctrlKey) && !editingDisabled) { e.stopPropagation(); toggleCutSelection(i, e.shiftKey || e.metaKey || e.ctrlKey); return }
              // Measure the whole cut, including its handles, so the click lines
              // up with the playhead even when the timeline is zoomed or clipped.
              const rect = e.currentTarget.parentElement!.getBoundingClientRect()
              const target = e.detail === 0 ? a : a + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (b - a)
              seek(Math.max(a, Math.min(b - .001, snapFrame(frames, target))))
            }} onContextMenu={(e) => { e.preventDefault(); if (!editingDisabled) setSceneMenu({ cut: i, x: e.clientX, y: e.clientY }) }}><Film size={12} /><span>{i + 1}</span><button className="editor-piece-layout" title="Layout of this section — click to cycle Fill / Split / Fit" aria-label={`Change layout of section ${i + 1}, currently ${layoutName(sceneAt(candidate, a).layout)}`} disabled={editingDisabled} onClick={(event) => { event.stopPropagation(); cyclePieceLayout(i) }}>{layoutName(sceneAt(candidate, a).layout)}</button></button><button className="editor-trim-handle" aria-label={`Trim end of cut ${i + 1}`} disabled={editingDisabled} title="Drag to trim or extend; arrow keys adjust by 0.1s (Shift: 1s)" onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); change({ ranges: trimRange(candidate.ranges, i, 1, b + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1000 : 100), project.duration_ms) }) } }} onPointerDown={(e) => { video.current?.pause(); dragging.current = true; setDragWindow([viewStart, viewEnd]); trimDrag(e, i, 1, viewStart, viewEnd, project.duration_ms, candidate, edits, selected, setEdits, setUndo, setRedo, () => { dragging.current = false; setDragWindow(null) }, snap) }} /></div>)}
            {candidate.scenes.map((s, i) => i > 0 && s.at_ms >= viewStart && s.at_ms <= viewEnd && <button key={i}
              title={`Layout change at ${clock(s.at_ms)}${editingDisabled ? '' : ` · Drag to move · Arrow keys: ${frames.length ? 'one frame' : '0.1s (scan for frame stepping)'} · Shift: 1s`}`}
              aria-label={`Layout change at ${clock(s.at_ms)}`} className={cn('editor-scene-marker', i === sceneIndex && 'selected', editingDisabled && 'read-only')}
              style={{ left: `${(s.at_ms - viewStart) / (viewEnd - viewStart) * 100}%` }}
              onPointerDown={(e) => startSceneDrag(e, i)} onClick={() => { video.current?.pause(); seek(s.at_ms); setTab('framing') }}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') e.stopPropagation()
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
                e.preventDefault(); e.stopPropagation()
                moveScene(i, e.shiftKey ? s.at_ms + (e.key === 'ArrowLeft' ? -1000 : 1000) : frames.length ? stepFrame(frames, s.at_ms, e.key === 'ArrowLeft' ? -1 : 1) : s.at_ms + (e.key === 'ArrowLeft' ? -100 : 100))
              }} />)}
            {bandSelect && <div className="editor-band" aria-hidden="true" style={{ left: `${(bandSelect[0] - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(bandSelect[1] - bandSelect[0]) / (viewEnd - viewStart) * 100}%` }} />}
            {time >= viewStart && time <= viewEnd && <div className="editor-playhead" style={{ left: `${(time - viewStart) / (viewEnd - viewStart) * 100}%` }} />}
          </div>
          <EditorWaveform outputDir={outputDir} duration={project.duration_ms} viewStart={viewStart} viewEnd={viewEnd} ranges={candidate.ranges} />
          {suppressedCaptions.length > 0 && <div className={cn('editor-caption-track', !candidate.captions && 'opacity-40')} aria-label="Caption-free sections">
            {suppressedCaptions.map(([a, b], i) => b > viewStart && a < viewEnd && <button key={i}
              aria-label={`Caption-free section ${i + 1}: ${clock(a)} to ${clock(b)}`} title={`Captions suppressed ${clock(a)} – ${clock(b)}`}
              style={{ left: `${(Math.max(a, viewStart) - viewStart) / (viewEnd - viewStart) * 100}%`, width: `${(Math.min(b, viewEnd) - Math.max(a, viewStart)) / (viewEnd - viewStart) * 100}%` }}
              onClick={() => { seek(a); setTab('captions') }} />)}
          </div>}
          <input aria-label="Fine timeline position" type="range" min={viewStart} max={viewEnd} step="any" value={Math.max(viewStart, Math.min(viewEnd, time))} onChange={(e) => seek(snapFrame(frames, Number(e.target.value)))} className="editor-fine-scrub" />
          </>}
          <div className="editor-timeline-footer">
            <div className="editor-cut-list">{candidate.ranges.map(([a, b], i) => <div key={i} className="flex items-center gap-2"><span className="text-2xs text-ink-subtle">{i + 1}</span><TimeInput label={`Cut ${i + 1} start`} value={a} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][0] = Math.max(i ? ranges[i - 1][1] : 0, Math.min(b - 100, t)); change({ ranges }) }} /><span className="text-ink-subtle">–</span><TimeInput label={`Cut ${i + 1} end`} value={b} disabled={editingDisabled} onChange={(t) => { const ranges = candidate.ranges.map((r) => [...r] as [number, number]); ranges[i][1] = Math.min(i + 1 < ranges.length ? ranges[i + 1][0] : project.duration_ms, Math.max(a + 100, t)); change({ ranges }) }} /><Button variant="ghost" size="sm" aria-label={`Remove cut ${i + 1}`} tooltip="Remove this cut from the clip. The source video is kept; Undo restores the cut." iconOnly icon={<X size={12} />} disabled={candidate.ranges.length === 1 || editingDisabled} onClick={() => change({ ranges: candidate.ranges.filter((_, j) => j !== i) })} /></div>)}</div>
            <div className="editor-timeline-zoom">
              <span className="text-2xs text-ink-subtle">Timeline zoom</span>
              <input type="range" aria-label="Timeline zoom slider" min={0} max={100} step={1} value={zoomSlider} onChange={(e) => {
                const span = Math.max(2000, Math.min(project.duration_ms, project.duration_ms / Math.pow(2, Number(e.target.value) / 14.5)))
                const a = Math.max(0, Math.min(project.duration_ms - span, time - span / 2))
                setTimelineZoom(span >= project.duration_ms ? 'source' : [a, Math.min(project.duration_ms, a + span)])
              }} />
              <Select aria-label="Timeline zoom" size="sm" className="w-32" value={Array.isArray(timelineZoom) ? 'playhead' : timelineZoom}
                options={[{ value: 'source', label: 'Full source' }, { value: 'clip', label: 'Clip' }, { value: 'playhead', label: 'Playhead', detail: '±1 second' }]}
                onChange={(value) => setTimelineZoom(value === 'playhead'
                  ? [Math.max(0, time - 1000), Math.min(project.duration_ms, time + 1000)]
                  : value === 'source' ? 'source' : 'clip')} />
            </div>
          </div>
        </div>
      </div>
      <aside className="editor-inspector"><div className="editor-tabs">{(['review', 'framing', 'captions', 'brand', 'transcript'] as const).map((t) => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={cn(tab === t && 'selected')}>{t === 'review' ? 'Jev' : t[0].toUpperCase() + t.slice(1)}</button>)}</div>
        <div ref={transcriptPanel} className="editor-inspector-body"><label className="editor-label" htmlFor="editor-title">Title</label><textarea id="editor-title" value={candidate.title} maxLength={200} disabled={editingDisabled} rows={2} onChange={(e) => { if (e.target.value.trim()) change({ title: e.target.value }) }} />
          {tab === 'review' && <div className="space-y-3 mt-4"><div className="flex items-center justify-between"><span className={cn('text-xs', current ? candidate.review?.decision === 'passes' ? 'text-success' : 'text-warning' : 'text-ink-muted')}>{!current ? 'Review out of date' : candidate.review?.decision === 'passes' ? 'Checks passed' : 'Consider before baking'}</span><Button size="sm" disabled={editingDisabled} onClick={() => { void run('review') }}>Review again</Button></div><p className="text-2xs text-ink-subtle">{current ? 'Review the questions, then adjust the cut and framing. You decide when the clip is ready.' : 'These results describe an earlier edit. Run Jev again to check your changes.'}</p>{candidate.review?.questions.map((q) => <Question key={q.id} q={q} />)}{!candidate.review && <p>No review is available yet. Run Jev to evaluate this candidate.</p>}{candidate.review?.cuts.map((cut, i) => <div key={i}><p className="editor-label">Removed {clock(cut.interval[0])} – {clock(cut.interval[1])}</p>{cut.questions.map((q) => <Question key={q.id} q={q} />)}</div>)}</div>}
          {tab === 'framing' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4">{candidate.framing === 'centered' && <p className="text-2xs text-warning">Speaker tracking was not available when this clip was imported, so framing starts centered. Run Auto-frame or adjust the crop below.</p>}{project.aspect_ratio === '9:16' && <div className="flex items-center justify-between gap-2"><p className="text-2xs text-ink-subtle">Auto-frame re-scans this clip and rebuilds the layouts around the active speaker. Your cuts, captions and review are kept.</p><Button size="sm" tooltip="Analyze this clip again and replace its layouts with speaker-tracking ones. The clip must be baked again." onClick={() => { void run('auto-frame') }}>Auto-frame</Button><Button size="sm" variant={subjectArm ? 'primary' : 'ghost'} icon={<Crosshair size={13} />} disabled={!!busy || editingDisabled}
              tooltip="Manual subject tracking: arm, then click the person or object to follow on the source frame. Rebuilds layouts around it."
              aria-pressed={subjectArm} onClick={() => setSubjectArm((armed) => !armed)}>Track subject</Button></div>}{subjectArm && <p className="text-2xs text-warning" role="status">Click a person or object on the source frame — layouts will follow it across this clip.</p>}<div className="editor-layouts">{(['fill', 'split', 'fit'] as const).map((l) => <button key={l} className={cn(currentScene.layout === l && 'selected')} onClick={() => setLayout(l)}>{l === 'fill' ? 'Full frame' : l === 'split' ? 'Split' : 'Fit'}</button>)}</div>{currentScene.layout === 'split' && <div className="flex gap-2">{['Top', 'Bottom'].map((name, i) => <Button key={i} size="sm" variant={panel === i ? 'primary' : 'secondary'} onClick={() => setPanel(i)}>{name}</Button>)}</div>}{currentScene.layout !== 'fit' && <><label className="editor-label">Zoom<input aria-label="Crop zoom" type="range" min={1} max={4} step={.02} value={Math.min(4, defaultCrop(project.width, project.height, aspect * currentScene.crops.length)[2] / crop[2])} onChange={(e) => cropChange(defaultCrop(project.width, project.height, aspect * currentScene.crops.length, crop[0] + crop[2] / 2, crop[1] + crop[3] / 2, Number(e.target.value)))} /></label>{([0, 1] as const).map((axis) => <label key={axis} className="editor-label">{axis === 0 ? 'Horizontal' : 'Vertical'}<input type="range" aria-label={axis === 0 ? 'Horizontal crop position' : 'Vertical crop position'} min={0} max={Math.max(0, 1 - crop[axis + 2])} step={.001} value={crop[axis]} onChange={(e) => { const c = [...crop] as Crop; c[axis] = Number(e.target.value); cropChange(c) }} /></label>)}</>}{sceneIndex > 0 && <div className="editor-motion"><label className="flex items-center justify-between gap-2 text-xs"><span>Smooth movement</span><input type="checkbox" aria-label="Smooth movement" checked={!!currentScene.transition_ms} disabled={!canAnimate || editingDisabled} onChange={(e) => sceneChange({ transition_ms: e.target.checked ? 600 : undefined })} /></label>{canAnimate && currentScene.transition_ms ? <label className="editor-label mt-3">Duration <span className="float-right">{(currentScene.transition_ms / 1000).toFixed(1)}s</span><input aria-label="Movement duration" type="range" min={100} max={5000} step={100} value={currentScene.transition_ms} onChange={(e) => sceneChange({ transition_ms: Number(e.target.value) })} /></label> : !canAnimate ? <p className="text-2xs text-ink-subtle mt-2">Use the same layout as the previous section to animate its crops.</p> : null}{!!currentScene.transition_ms && <Button size="sm" variant="ghost" onClick={() => { seek(Math.max(start, currentScene.at_ms)); void video.current?.play() }}>Preview movement</Button>}</div>}<div className="space-y-2 border-t border-white/10 pt-3"><div className="editor-layout-time">
            {sceneIndex > 0 ? <label className="flex items-center justify-between gap-3 text-xs"><span>Layout starts</span><TimeInput key={sceneIndex} label="Layout start" value={currentScene.at_ms} disabled={editingDisabled} onChange={(t) => moveScene(sceneIndex, t)} /></label>
              : <p className="text-2xs text-ink-muted">Initial layout</p>}
            {sceneIndex > 0 && frames.length > 0 && <div className="flex gap-2 mt-2"><Button size="sm" variant="ghost" disabled={editingDisabled} onClick={() => moveScene(sceneIndex, stepFrame(frames, currentScene.at_ms, -1))}>One frame earlier</Button><Button size="sm" variant="ghost" disabled={editingDisabled} onClick={() => moveScene(sceneIndex, stepFrame(frames, currentScene.at_ms, 1))}>One frame later</Button></div>}
            {sceneIndex + 1 < candidate.scenes.length && <p className="text-2xs text-ink-subtle mt-2">Until {clock(candidate.scenes[sceneIndex + 1].at_ms)}</p>}
          </div><Button size="sm" icon={<Scissors size={13} />} disabled={candidate.scenes.length >= 60 || time <= start || time >= end || candidate.scenes.some((s) => Math.abs(s.at_ms - time) < .01)} onClick={() => newLayout()}>New layout here</Button>{sceneIndex > 0 && <Button size="sm" variant="ghost" onClick={() => change({ scenes: candidate.scenes.filter((_, i) => i !== sceneIndex) })}>Remove layout change</Button>}<Button size="sm" variant="ghost" disabled={editingDisabled} tooltip="Put this section's crop back at the default center for its layout." onClick={() => setLayout(currentScene.layout)}>Reset crop</Button><Button size="sm" variant="ghost" onClick={() => change({ scenes: [{ ...currentScene, at_ms: 0 }] })}>Use layout for whole clip</Button></div></fieldset>}
          {tab === 'captions' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4"><div className="flex items-center justify-between text-xs"><span>Burn in captions</span><Switch label="Burn in captions" checked={candidate.captions} onChange={(captions) => change({ captions })} /></div><p className="text-2xs text-ink-subtle">Captions follow your final cuts. Use the placement guide in Transcript to position them before baking.</p><CaptionSuppression key={candidate.id} ranges={suppressedCaptions} cuts={candidate.ranges} time={time} duration={project.duration_ms} disabled={editingDisabled || !candidate.captions} onChange={(caption_suppression_ranges) => { video.current?.pause(); change({ caption_suppression_ranges }) }} seek={seek} />{candidate.captions && <CaptionPresetPicker value={candidate.caption_preset} onChange={(caption_preset) => change({ caption_preset })} />}<label className="editor-label">Export speed<select value={candidate.video_speed} onChange={(e) => change({ video_speed: Number(e.target.value) })}>{[1, 1.1, 1.25, 1.5, 1.75, 2].map((n) => <option key={n} value={n}>{n}×</option>)}</select></label></fieldset>}
          {tab === 'brand' && <fieldset disabled={editingDisabled} className="space-y-4 mt-4">
            <p className="text-2xs text-ink-subtle">Logo and badges bake into the exported clip, above captions, title and banner. The preview is approximate; the export is exact.</p>
            <div className="editor-upload-card">
              <div className="editor-upload-thumb">{logoSrc && candidate.logo
                ? <img src={localFileUrl(logoSrc)} alt="Logo preview" />
                : <span className="text-2xs text-ink-subtle">PNG / JPG</span>}<span className="text-2xs">{candidate.logo ? 'Logo watermark' : 'No logo'}</span></div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => { void uploadLogo() }}>Upload logo</Button>
                {candidate.logo && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label="Remove logo" onClick={() => change({ logo: undefined })} />}
              </div>
              {candidate.logo && <div className="space-y-2">
                <span className="editor-label">Position</span>
                <BrandPositionGrid label="Logo position" value={candidate.logo.position} onChange={(position) => change({ logo: { ...candidate.logo!, position } })} />
                <label className="editor-label">Size<span className="float-right">{Math.round(candidate.logo.scale * 100)}%</span><input aria-label="Logo size" type="range" min={5} max={50} value={Math.round(candidate.logo.scale * 100)} onChange={(e) => change({ logo: { ...candidate.logo!, scale: Number(e.target.value) / 100 } })} /></label>
                <label className="editor-label">Opacity<span className="float-right">{Math.round(candidate.logo.opacity * 100)}%</span><input aria-label="Logo opacity" type="range" min={10} max={100} value={Math.round(candidate.logo.opacity * 100)} onChange={(e) => change({ logo: { ...candidate.logo!, opacity: Number(e.target.value) / 100 } })} /></label>
              </div>}
            </div>
            <div className="space-y-2">
              <span className="editor-label">Call-to-action badges</span>
              <div className="flex gap-2">{(['subscribe', 'follow'] as const).map((kind) => <button key={kind} type="button" aria-pressed={(candidate.cta_badges ?? []).some((b) => b.kind === kind)} className={cn('editor-badge-chip', `editor-badge-${kind}`, (candidate.cta_badges ?? []).some((b) => b.kind === kind) && 'on')} onClick={() => toggleBadge(kind)}>{kind === 'subscribe' ? 'SUBSCRIBE' : 'FOLLOW'}</button>)}</div>
              <p className="text-2xs text-ink-subtle">Shown for the whole clip in the export.</p>
              {(candidate.cta_badges ?? []).map((b) => <div key={b.kind} className="editor-badge-row">
                <span className="text-2xs">{b.kind === 'subscribe' ? 'Subscribe' : 'Follow'} position</span>
                <BrandPositionGrid label={`${b.kind === 'subscribe' ? 'Subscribe' : 'Follow'} badge position`} value={b.position} onChange={(position) => badgePosition(b.kind, position)} />
              </div>)}
            </div>
            <div className="space-y-2 border-t border-white/10 pt-3">
              <p className="text-2xs text-ink-subtle">Apply a brand template: the pack's caption style and CTA badge land on this clip. Logo watermarks from packs apply at export via Create.</p>
              <ApplyBrandTemplate onSelect={(pack) => {
                const badge = pack.badge
                change({ caption_preset: pack.captionPresetId,
                  cta_badges: badge ? [{ kind: badge.kind, position: badge.position }] : undefined })
                setNotice(`Brand template “${pack.name}” applied to this clip.`)
              }} />
              <p className="text-2xs text-ink-subtle">Reuse this look on future jobs: saves the logo, badge, caption style and format as a brand pack you can pick in Create or the Templates page.</p>
              <Button size="sm" icon={<Save size={13} />} onClick={() => { void saveBrandPack() }}>Save as brand pack</Button>
            </div>
          </fieldset>}
          {tab === 'transcript' && <section className="editor-subtitle-controls" aria-label="Subtitle placement">
            <div className="flex items-center justify-between gap-2 text-xs"><span>Subtitle placement guide</span><Switch label="Show subtitle guide" checked={showSubtitlePreview} onChange={setShowSubtitlePreview} /></div>
            {!candidate.captions ? <p className="text-2xs text-ink-muted">Subtitles are off for this clip. <button className="underline" disabled={editingDisabled} onClick={() => change({ captions: true })}>Enable subtitles</button></p>
              : <p className="text-2xs text-ink-subtle">Drag “Captions go here” anywhere on the video to choose where your subtitles sit. This position applies throughout the clip.</p>}
            <fieldset disabled={editingDisabled || !candidate.captions}>
              <label className="editor-label">Vertical position <span className="float-right">{candidate.caption_y == null ? 'Automatic' : `${Math.round(captionPosition * 100)}% from top`}</span>
                <input aria-label="Subtitle vertical position" type="range" min={10} max={90} step={1} value={Math.max(10, Math.min(90, captionPosition * 100))} onChange={e => moveCaption(captionXPosition, Number(e.target.value) / 100)} />
              </label>
              <label className="editor-label">Horizontal position <span className="float-right">{Math.round(captionXPosition * 100)}% from left</span>
                <input aria-label="Subtitle horizontal position" type="range" min={10} max={90} step={1} value={Math.round(captionXPosition * 100)} onChange={e => moveCaption(Number(e.target.value) / 100, captionPosition)} />
              </label>
              <div className="flex gap-1 flex-wrap">{([['Top', .2], ['Middle', .5], ['Bottom', .8]] as const).map(([label, y]) => <Button key={label} variant="ghost" size="sm" onClick={() => moveCaption(captionXPosition, y)}>{label}</Button>)}
                <Button variant="ghost" size="sm" disabled={candidate.caption_y == null} onClick={() => change({ caption_y: null })}>Automatic</Button></div>
            </fieldset>
          </section>}
          {addSection && session?.previewPath && <AddSectionDialog src={session.previewPath} durationMs={project.duration_ms}
            defaultStart={candidate.ranges.at(-1)![1]}
            onAdd={(a, b) => {
              const ranges = insertSection(candidate.ranges, a, b)
              if (!ranges) { setError('Cannot add that section — it overlaps a cut or the clip already has 24 sections.'); return }
              change({ ranges }); setAddSection(false); setNotice('Section added to this clip.')
            }}
            onClose={() => setAddSection(false)} />}
          {tab === 'transcript' && <div className="editor-transcript">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-2xs text-ink-subtle">Looking for a better hook, or want to extend this clip?</span>
              <Button size="sm" variant="ghost" icon={<Plus size={13} />} disabled={editingDisabled} onClick={() => { video.current?.pause(); setAddSection(true) }}>Add a section</Button>
            </div>
            {fillerHits.length > 0 && !editingDisabled && <button type="button" className="editor-filler-onetap" role="button"
              aria-label={`Remove filler words, ${fillerHits.length} found`}
              title="Removes every detected filler (ums, uhs and more) — the footage and its captions are cut together. Undo restores it."
              onClick={() => {
                let ranges = candidate.ranges
                let caption_edits = [...(candidate.caption_edits ?? [])]
                try {
                  for (const hit of fillerHits) {
                    const words = project.transcript[hit.segment]?.words ?? []
                    if (!words.length) continue
                    const next = cutWords(ranges, caption_edits, hit.segment, words, hit.word_from, hit.word_to)
                    ranges = next.ranges; caption_edits = next.caption_edits
                  }
                } catch (e) { setError(errorMessage(e)); return }
                change({ ranges, caption_edits })
                setCleanupSkipped([])
                setNotice(`Removed ${fillerHits.length} filler word${fillerHits.length === 1 ? '' : 's'} — Undo restores it.`)
              }}>
              <span className="editor-filler-count">{fillerHits.length}</span>
              Remove filler words ({fillerHits.length} found)
            </button>}
            <p className="text-2xs text-ink-subtle">Caption edits apply to this clip. Select lines — or drag across words — and press Delete to cut that time from the video; Restore puts it back.</p>
            {wordSelection && <div className="editor-word-pick" role="status">
              <span className="text-2xs text-ink-subtle">{Math.abs(wordSelection.to - wordSelection.from) + 1} word{wordSelection.to === wordSelection.from ? '' : 's'} selected</span>
              <span className="flex gap-2">
                <Button size="sm" icon={<Pencil size={12} />} disabled={editingDisabled} onClick={addWordsAsTextOverlay}>Add as text overlay</Button>
                <Button size="sm" variant="ghost" icon={<BookPlus size={12} />} disabled={editingDisabled}
                  title="Teach this term to your Brand Vocabulary so every new transcription spells it right." onClick={() => { void addSelectionToVocabulary() }}>Add to Brand Vocabulary</Button>
              </span>
            </div>}
            {wordMenu && (() => {
              const menuWord = wordText(wordMenu.segment, wordMenu.index).trim()
              return (
                <div className="editor-word-menu" style={{ left: wordMenu.x, top: wordMenu.y - 52 }} onPointerDown={(e) => e.stopPropagation()}>
                  <span className="editor-word-menu-group">
                    <span className="editor-word-menu-label">Add</span>
                    <button onClick={() => { setWordMenu(null)
                      const wStart = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]?.start_ms
                      if (wStart !== undefined) seek(wStart)
                      setOpenTool('broll') }}
                      title="Add B-roll starting here">B-roll</button>
                    <button onClick={() => {
                      const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                      if (!w) return
                      setWordMenu(null)
                      const overlay = { text: menuWord, start_ms: Math.round(w.start_ms), end_ms: Math.min(project.duration_ms, Math.round(w.start_ms) + 3000), position: 'bottom-right' as OverlayPosition }
                      const next = [...(candidate.text_overlays ?? []), overlay].sort((a, b) => a.start_ms - b.start_ms)
                      change({ text_overlays: next }); setOpenTool('text')
                    }} title="Add a text box at this word">Text</button>
                    <button onClick={() => { setWordMenu(null); setOpenTool('hook') }} title="Generate a hook">Hook</button>
                  </span>
                  <span className="editor-word-menu-sep" aria-hidden />
                  <span className="editor-word-menu-group">
                    <span className="editor-word-menu-label">Correct</span>
                    {wordCorrecting ? <>
                      <input id="word-correct-input" className="editor-word-correct-input" defaultValue={menuWord} maxLength={120} autoFocus
                        aria-label="Corrected word"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); void correctWord(false) }
                          if (e.key === 'Escape') setWordMenu(null)
                        }} />
                      <button onClick={() => { void correctWord(false) }} title="Correct on this line">Here</button>
                      <button onClick={() => { void correctWord(true) }} title="Correct every line that contains this word">Everywhere</button>
                    </> : <>
                      <button onClick={() => { setWordCorrecting(true); setWordCorrectValue(menuWord) }} title="Correct this word">“{menuWord}”</button>
                    </>}
                  </span>
                  <span className="editor-word-menu-sep" aria-hidden />
                  <span className="editor-word-menu-group">
                    <span className="editor-word-menu-label">Timing</span>
                    <button title="Cut everything before this word" onClick={() => {
                      const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                      if (!w || !candidate || editingDisabled) return
                      try {
                        const ranges = cutRanges(candidate.ranges, 0, w.start_ms)
                        change({ ranges }); setWordMenu(null)
                      } catch (e) { setError(errorMessage(e)) }
                    }}>From start</button>
                    <button title="Cut everything after this word" onClick={() => {
                      const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                      if (!w || !candidate || editingDisabled) return
                      try {
                        const ranges = cutRanges(candidate.ranges, w.end_ms, project.duration_ms)
                        change({ ranges }); setWordMenu(null)
                      } catch (e) { setError(errorMessage(e)) }
                    }}>To end</button>
                  </span>
                  <span className="editor-word-menu-sep" aria-hidden />
                  <span className="editor-word-menu-group">
                    <span className="editor-word-menu-label">More</span>
                    <button title="Cut this word (captions update too)" disabled={editingDisabled}
                      onClick={() => {
                        const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                        const words = project.transcript[wordMenu.segment]?.words ?? []
                        if (!w || !words.length || !candidate || editingDisabled) return
                        try {
                          const next = cutWords(candidate.ranges, candidate.caption_edits, wordMenu.segment, words, wordMenu.index, wordMenu.index)
                          change({ ranges: next.ranges, caption_edits: next.caption_edits })
                        } catch (e) { setError(errorMessage(e)) }
                        setWordMenu(null)
                      }}>Cut word</button>
                    <button title="Blur the frame while this word is spoken" disabled={editingDisabled}
                      onClick={() => {
                        const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                        if (!w || !candidate || editingDisabled) return
                        const edit = { id: crypto.randomUUID().replaceAll('-', ''), kind: 'blur' as const, intensity: 0.9, start_ms: Math.round(w.start_ms), end_ms: Math.max(Math.round(w.start_ms) + 100, Math.round(w.end_ms)) }
                        change({ range_edits: [...(candidate.range_edits ?? []), edit].sort((a, b) => a.start_ms - b.start_ms) })
                        setWordMenu(null); setNotice('Blur added over this word — adjust it in Effects.')
                      }}>Blur</button>
                    <button title="Mask this word in captions and bleep it in the audio" disabled={editingDisabled}
                      onClick={() => {
                        const w = project.transcript[wordMenu.segment]?.words?.[wordMenu.index]
                        if (!w || !candidate || editingDisabled) return
                        const core = w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()
                        if (!core) { setWordMenu(null); return }
                        const censor = candidate.censor
                        change({ censor: { words: [...new Set([...(censor?.words ?? []), core])], captions: censor?.captions ?? 'asterisk', audio: censor?.audio ?? 'mute' } })
                        setWordMenu(null); setNotice(`“${core}” is censored — captions masked, audio muted. Open Censor for options.`)
                      }}>Censor word</button>
                  </span>
                  <button className="editor-word-menu-close" aria-label="Close word menu" onClick={() => setWordMenu(null)}><X size={12} /></button>
                </div>
              )
            })()}
            {pauseMenu && candidate && !editingDisabled && (
              <div className="editor-word-menu" style={{ position: 'fixed', left: pauseMenu.x, top: pauseMenu.y - 44 }}
                onPointerDown={(e) => e.stopPropagation()}>
                <button onClick={() => {
                  try { change({ ranges: cutRanges(candidate.ranges, pauseMenu.start_ms, pauseMenu.end_ms) }) }
                  catch (e) { setError(errorMessage(e)) }
                  setPauseMenu(null)
                }}>Remove this pause</button>
                <button onClick={() => {
                  let ranges = candidate.ranges
                  try {
                    for (const pause of [...pauseHits].reverse()) ranges = cutRanges(ranges, pause.start_ms, pause.end_ms)
                    change({ ranges })
                    setNotice(`All pauses of ${(pauseThreshold / 1000).toFixed(1)}s+ removed — every cut is reversible with Restore.`)
                  } catch (e) { setError(errorMessage(e)) }
                  setPauseMenu(null)
                }}>Remove all pauses</button>
                <button className="editor-word-menu-close" aria-label="Close pause menu" onClick={() => setPauseMenu(null)}><X size={12} /></button>
              </div>
            )}
            {sceneMenu && candidate && (
              <div className="editor-word-menu" style={{ position: 'fixed', left: sceneMenu.x, top: sceneMenu.y - 12 }}
                onPointerDown={(e) => e.stopPropagation()}>
                <span className="editor-word-menu-label">Layout</span>
                {(['fill', 'split', 'fit'] as const).map((layout) => (
                  <button key={layout} disabled={editingDisabled}
                    onClick={() => { cyclePieceLayout(sceneMenu.cut); setSceneMenu(null) }}>{layoutName(layout)}</button>
                ))}
                <span className="editor-word-menu-sep" aria-hidden />
                <button disabled={editingDisabled}
                  onClick={() => { toggleCutSelection(sceneMenu.cut, true); setSceneMenu(null) }}>Select</button>
              </div>
            )}
            {project.transcript.map((r, i) => {
            const nearClip = r.end_ms >= start - 15000 && r.start_ms <= end + 15000
            const nearPlayhead = r.end_ms >= time - 15000 && r.start_ms <= time + 15000
            if (!nearClip && !nearPlayhead && editingCaption !== i) return null
            const edited = candidate.caption_edits?.some((e) => e.segment === i)
            const cut = lineCutState(r, candidate.ranges)
            const picked = textSelection.has(i)
            return <div key={i} ref={r === activeTranscript ? activeCaption : undefined} aria-current={r === activeTranscript ? 'true' : undefined}
              className={cn('editor-transcript-row', r === activeTranscript && 'selected', cut === 'cut' && 'text-cut',
                badTakes?.some((take) => i >= take.start && i <= take.end) && 'editor-take-flagged')}
              title={badTakes?.find((take) => i >= take.start && i <= take.end)?.reason ? `Bad take: ${badTakes.find((take) => i >= take.start && i <= take.end)!.reason}` : undefined}>
              <div className="editor-transcript-time">
                <Checkbox checked={picked} className="editor-line-pick" onChange={() => setTextSelection((prev) => { const next = new Set(prev); if (next.has(i)) next.delete(i); else next.add(i); return next })} label={`Select transcript line at ${clock(r.start_ms)}`} />
                <button onClick={() => seek(r.start_ms)} title="Playhead to this line">{formatTimecode(r.start_ms)}</button>{edited && <span>Edited</span>}
                <Button variant="ghost" size="sm" iconOnly icon={<Pencil size={12} />} aria-label={`Edit caption at ${clock(r.start_ms)}`} tooltip="Correct this caption’s text for the selected clip." disabled={!canEditCaption(i)} onClick={() => editCaption(i)} />
                {cut === 'cut'
                  ? <Button variant="ghost" size="sm" iconOnly icon={<RotateCcw size={12} />} aria-label={`Restore text at ${clock(r.start_ms)}`} tooltip="Put this text's time back into the clip." onClick={() => { r.words?.length ? restoreLineWords(i) : restoreTextLine(i) }} />
                  : <Button variant="ghost" size="sm" iconOnly icon={<Scissors size={12} />} aria-label={`Cut text at ${clock(r.start_ms)}`} tooltip="Remove this text's time from the clip." disabled={editingDisabled} onClick={() => cutTextLines([i])} />}
              </div>
              {r.speaker && (renamingSpeaker === r.speaker
                ? <input className="editor-speaker-rename" aria-label={`Rename speaker ${r.speaker}`} autoFocus defaultValue={speakerNames[r.speaker] ?? ''} placeholder={r.speaker} maxLength={40}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setRenamingSpeaker(null); return }
                      if (e.key !== 'Enter') return
                      const value = e.currentTarget.value.trim()
                      if (value) setSpeakerNames((n) => ({ ...n, [r.speaker!]: value }))
                      setRenamingSpeaker(null)
                    }} onBlur={(e) => { const value = e.currentTarget.value.trim(); if (value) setSpeakerNames((n) => ({ ...n, [r.speaker!]: value })); setRenamingSpeaker(null) }} />
                : <button className="editor-speaker" title={`Speaker ${r.speaker} · click to rename`} onClick={() => { video.current?.pause(); setRenamingSpeaker(r.speaker!) }}>{speakerNames[r.speaker] ?? r.speaker}</button>)}
              {editingCaption === i ? <><textarea ref={captionInput} aria-label={`Caption at ${clock(r.start_ms)}`} maxLength={2000} rows={3} value={captionText(i)} disabled={editingDisabled}
                onChange={(e) => { updateCaption(i, e.target.value, firstCaptionChange.current); firstCaptionChange.current = false }}
                onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); setEditingCaption(null) } }} />
                <div className="flex items-center justify-between mt-2"><Button size="sm" variant="ghost" disabled={editingDisabled || !edited} onClick={() => updateCaption(i, r.text)}>Reset text</Button><Button size="sm" onClick={() => setEditingCaption(null)}>Done</Button></div></>
                : r.words?.length
                  ? <span className="editor-transcript-text" onPointerUp={() => { wordDragging.current = false }}>{r.words.map((w, j) => {
                      const inSel = wordSelection?.segment === i && j >= Math.min(wordSelection.from, wordSelection.to) && j <= Math.max(wordSelection.from, wordSelection.to)
                      const filler = fillerHits.find((hit) => hit.segment === i && j >= hit.word_from && j <= hit.word_to)
                      const censored = censorStems.length > 0 && censorWordHit(w.text, censorStems)
                      return <span key={j} role="button" aria-pressed={inSel}
                        title={censored ? 'Censored — masked in captions and muted in the audio (Censor tool).' : filler ? 'Flagged as a filler — uncheck it in Speech cleanup to keep it.' : undefined}
                        className={cn('editor-word', wordIsCut(w, candidate.ranges) && 'editor-word-cut', inSel && 'editor-word-picked', keywordWord(w.text) && 'editor-keyword-word', filler && 'editor-word-filler', censored && 'editor-word-censored')}
                        onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); wordDragging.current = true; wordDragStart.current = { x: e.clientX, y: e.clientY }; setWordSelection({ segment: i, from: j, to: j }) }}
                        onPointerEnter={() => { if (wordDragging.current) setWordSelection((sel) => sel && sel.segment === i ? { ...sel, to: j } : sel) }}
                        onPointerUp={(e) => {
                          const startedAt = wordDragStart.current
                          if (startedAt && Math.hypot(e.clientX - startedAt.x, e.clientY - startedAt.y) < 5) {
                            setWordSelection(null)
                            setWordMenu({ segment: i, index: j, x: e.clientX, y: e.clientY })
                          }
                          wordDragStart.current = null
                        }}
                        onDoubleClick={() => seek(w.start_ms)}>{w.text}{' '}</span>
                    })}
                    {(r.words ?? []).slice(1).map((w, j) => {
                      const prev = (r.words ?? [])[j]
                      const gap = w.start_ms - prev.end_ms
                      if (gap < 400) return null
                      const key = `p:${prev.end_ms}`
                      const skipped = cleanupSkipped.includes(key)
                      return (
                        <button key={key} type="button"
                          className={cn('editor-pause-chip', cleanupSkipped.includes('kept:' + key) && 'editor-pause-kept')}
                          title={`Pause ${((w.start_ms - prev.end_ms) / 1000).toFixed(1)}s — click for options`}
                          aria-label={`Pause ${(gap / 1000).toFixed(1)} seconds`}
                          onClick={(e) => {
                            e.stopPropagation()
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            setPauseMenu({ start_ms: prev.end_ms, end_ms: w.start_ms, x: rect.left + rect.width / 2, y: rect.top - 8 })
                          }}
                        >{'·· ' + (gap / 1000).toFixed(1) + 's'}</button>
                      )
                    })}</span>
                  : <button className="editor-transcript-text" onClick={() => seek(r.start_ms)}>{captionText(i).trim() ? keywordSegments(captionText(i), project.keywords).map((s, j) => s.keyword ? <mark key={j} className="editor-keyword">{s.text}</mark> : <span key={j}>{s.text}</span>) : <em>Caption hidden</em>}</button>}
            </div>
          })}{!project.transcript.length && <p>No spoken transcript is available for this source.</p>}</div>}

        </div>
      </aside>
      <EditorToolRail outputDir={outputDir} project={project} candidate={candidate} sceneIndex={sceneIndex} time={time}
        disabled={editingDisabled} assetPaths={assetPaths} change={change} seek={seek} setTab={setTab} setError={setError} setNotice={setNotice}
        textFocus={textFocus} compareOriginal={compareOriginal} setCompareOriginal={setCompareOriginal}
        badTakes={badTakes} badTakesBusy={badTakesBusy} cleanupFocus={cleanupFocus}
        onDetectTakes={() => { void detectTakes() }} onKeepTake={keepTake} onRemoveTake={removeTake} onRemoveAllTakes={removeAllTakes}
        openTool={openTool}
        cleanup={{ fillers: fillerHits.length, pauses: pauseHits.length, savedMs: cleanupSavedMs,
          fillersOn, pausesOn, thresholdMs: pauseThreshold,
          chips: [...fillerHits.map((hit) => ({ key: `f:${hit.start_ms}`, label: `“${hit.text}”` })),
            ...pauseHits.map((pause) => ({ key: `p:${pause.start_ms}`, label: `pause ${((pause.end_ms - pause.start_ms) / 1000).toFixed(1)}s` }))] }}
        onCleanupToggle={(kind, on) => (kind === 'fillers' ? setFillersOn(on) : setPausesOn(on))}
        onCleanupThreshold={(ms) => setPauseThreshold(ms)}
        onCleanupSkip={(key) => setCleanupSkipped((skips) => skips.includes(key) ? skips.filter((k) => k !== key) : [...skips, key])}
        onApplyCleanup={applyCleanup} />
    </div>
    {showAudit && <EditInspector outputDir={outputDir} onClose={() => setShowAudit(false)} />}
  </section>
}
/** Timeline backdrop: evenly spaced frames of the preview, captured off-DOM so the
 *  visible player is never seeked. Silent no-op when capture fails or is mid-flight. */
function EditorFilmstrip({ previewPath, previewStartMs, strip, viewStart, viewEnd }: {
  previewPath: string; previewStartMs: number; strip: StripWindow; viewStart: number; viewEnd: number
}): React.JSX.Element | null {
  const [thumbs, setThumbs] = useState<string[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setThumbs(null)
    const span = strip.endMs - strip.startMs
    void captureFilmstrip(previewPath, 28, (f) => (strip.startMs + span * f - previewStartMs) / 1000, () => cancelled)
      .then((t) => { if (!cancelled && t.length) setThumbs(t) })
    return () => { cancelled = true }
  }, [previewPath, previewStartMs, strip.startMs, strip.endMs])
  const style = filmstripStyle(strip, viewStart, viewEnd)
  if (!style || !thumbs?.length) return null
  return <div className="editor-filmstrip" style={style} aria-hidden="true">{thumbs.map((t, i) => <img key={i} src={t} alt="" loading="lazy" />)}</div>
}

function CaptionSuppression({ ranges, cuts, time, duration, disabled, onChange, seek }: {
  ranges: EditorRange[]; cuts: EditorRange[]; time: number; duration: number; disabled: boolean
  onChange: (ranges: EditorRange[]) => void; seek: (t: number) => void
}): React.JSX.Element {
  const at = Math.round(time)
  const nextRange = nextCaptionRange(ranges, cuts, at)
  const canAdd = !disabled && nextRange !== null
  const update = (i: number, edge: 0 | 1, value: number): void => onChange(trimRange(ranges, i, edge, value, duration))
  return <section className="space-y-3 border-t border-white/10 pt-3" aria-label="Caption suppression">
    <h3 className="text-xs font-medium">Caption-free sections{ranges.length > 0 && <span className="ml-2 text-ink-subtle">{ranges.length}</span>}</h3>
    <p className="text-2xs text-ink-subtle">Already captioned in the source? Suppress our captions during those sections. Video, audio and source captions stay intact. Times refer to the source video.</p>
    <Button size="sm" disabled={!canAdd} onClick={() => {
      if (!nextRange) return
      onChange([...ranges, nextRange].sort((a, b) => a[0] - b[0])); seek(nextRange[0])
    }}>{ranges.length ? 'Add another section' : 'Suppress captions here'}</Button>
    {ranges.length > 0 && <p className="text-2xs text-ink-subtle">{!nextRange ? ranges.length >= 200 ? 'Section limit reached. Remove a section to add another.' : 'Captions are suppressed throughout the selected footage. Shorten or remove a section to make room.' : 'Add as many sections as you need. Each has its own start and end. New sections start at the playhead or the next available spot in this clip.'}</p>}
    {!ranges.length && <p className="text-2xs text-ink-subtle">Seek to a section, add a range, then adjust its start and end.</p>}
    {ranges.map(([a, b], i) => <div key={i} className="editor-caption-range">
      <div className="flex items-center justify-between gap-2"><button className="text-2xs text-ink-muted" onClick={() => seek(a)}>Section {i + 1}</button><Button size="sm" variant="ghost" iconOnly icon={<X size={12} />} tooltip="Restore captions in this section by removing its suppression range." aria-label={`Remove caption-free section ${i + 1}`} disabled={disabled} onClick={() => onChange(ranges.filter((_, j) => j !== i))} /></div>
      <div className="flex flex-wrap items-end gap-2">{([0, 1] as const).map((edge) => <label key={edge} className="text-2xs text-ink-subtle">{edge === 0 ? 'Start' : 'End'}<TimeInput label={`Caption-free section ${i + 1} ${edge === 0 ? 'start' : 'end'}`} value={edge === 0 ? a : b} disabled={disabled} onChange={(t) => update(i, edge, t)} /></label>)}</div>
      <div className="flex flex-wrap gap-2 mt-2"><Button size="sm" variant="ghost" disabled={disabled || at < (ranges[i - 1]?.[1] ?? 0) || at > b - 100} onClick={() => update(i, 0, at)}>Start at playhead</Button><Button size="sm" variant="ghost" disabled={disabled || at < a + 100 || at > (ranges[i + 1]?.[0] ?? duration)} onClick={() => update(i, 1, at)}>End at playhead</Button></div>
    </div>)}
  </section>
}
function TimeInput({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(clock(value))
  useEffect(() => setText(clock(value)), [value])
  const commit = (): void => {
    if (text === clock(value)) return
    const n = parseTimecode(text)
    setText(clock(value))
    if (n !== null && Number.isFinite(n)) onChange(n * 1000)
  }
  return <input className="editor-time-input" aria-label={label} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
}
function trimDrag(e: React.PointerEvent<HTMLButtonElement>, index: number, edge: 0 | 1, viewStart: number, viewEnd: number, duration: number, c: EditorCandidate, edits: EditorCandidate[], selected: number, setEdits: React.Dispatch<React.SetStateAction<EditorCandidate[]>>, setUndo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, setRedo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, onDone: () => void, snap?: (t: number) => number): void {
  e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId)
  const target = e.currentTarget, bounds = target.parentElement!.parentElement!.getBoundingClientRect(), pointerStart = e.clientX
  setUndo((u) => [...u.slice(-49), edits]); setRedo([])
  const move = (event: PointerEvent): void => {
    const raw = c.ranges[index][edge] + (event.clientX - pointerStart) / bounds.width * (viewEnd - viewStart)
    const t = snap ? snap(raw) : raw
    const ranges = trimRange(c.ranges, index, edge, t, duration)
    setEdits((items) => items.map((item, i) => i === selected ? refineEdit(item, { ranges }) : item))
  }
  const done = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done); onDone() }
  target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done)
}

type LaneKind = 'broll' | 'text' | 'effect' | 'voice'

/** Drag an element-track block: `move` slides it, `l`/`r` trim one edge. Same
 *  live-preview + single undo-entry contract as trimDrag. */
function laneBlockDrag(e: React.PointerEvent<HTMLElement>, kind: LaneKind, index: number, edge: 'move' | 'l' | 'r',
  a: number, b: number, viewStart: number, viewEnd: number, duration: number,
  edits: EditorCandidate[], selected: number, setEdits: React.Dispatch<React.SetStateAction<EditorCandidate[]>>,
  setUndo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>, setRedo: React.Dispatch<React.SetStateAction<EditorCandidate[][]>>,
  snap?: (t: number) => number): void {
  e.preventDefault(); e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId)
  const target = e.currentTarget
  const track = target.closest('.editor-lane-track') as HTMLElement | null
  if (!track) return
  const bounds = track.getBoundingClientRect(), pointerStart = e.clientX
  setUndo((u) => [...u.slice(-49), edits]); setRedo([])
  const move = (event: PointerEvent): void => {
    const delta = (event.clientX - pointerStart) / Math.max(1, bounds.width) * (viewEnd - viewStart)
    let next: [number, number]
    if (edge === 'move') {
      next = moveOverlayRange(a, b, delta, duration)
      if (snap) { const start = snap(next[0]); next = [start, start + (next[1] - next[0])] }
    } else {
      const raw = (edge === 'l' ? a : b) + delta
      next = resizeOverlayRange(a, b, edge, snap ? snap(raw) : raw, duration)
    }
    setEdits((items) => items.map((item, i) => {
      if (i !== selected) return item
      if (kind === 'broll') return refineEdit(item, { brolls: item.brolls!.map((r, j) => j === index ? { ...r, start_ms: next[0], end_ms: next[1] } : r) })
      if (kind === 'text') return refineEdit(item, { text_overlays: item.text_overlays!.map((r, j) => j === index ? { ...r, start_ms: next[0], end_ms: next[1] } : r) })
      if (kind === 'voice' && item.voiceover) return refineEdit(item, { voiceover: { ...item.voiceover, start_ms: next[0] } })
      return refineEdit(item, { range_edits: item.range_edits!.map((r, j) => j === index ? { ...r, start_ms: next[0], end_ms: next[1] } : r) })
    }))
  }
  const done = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done) }
  const cancel = (): void => { target.removeEventListener('pointermove', move); target.removeEventListener('lostpointercapture', done) }
  target.addEventListener('pointermove', move); target.addEventListener('lostpointercapture', done); target.addEventListener('pointercancel', cancel)
}
/** Editor "apply brand template": picks a saved pack and lands its caption
 *  style and CTA badge on the current clip (logo stays per-clip/upload). */
function ApplyBrandTemplate({ onSelect }: { onSelect: (pack: BrandTemplate) => void }): React.JSX.Element {
  const [templates, setTemplates] = useState<BrandTemplate[] | null>(null)
  useEffect(() => {
    let active = true
    void getApi().templates.list().then((list) => { if (active) setTemplates(list) }).catch(() => {})
    return () => { active = false }
  }, [])
  const saved = (templates ?? []).filter((tpl) => !tpl.builtIn)
  if (!saved.length) return <p className="text-2xs text-ink-subtle">No brand templates saved yet — create one below or in Templates.</p>
  return <Select size="sm" aria-label="Apply brand template" value=""
    placeholder="Apply brand template…"
    options={[{ value: '', label: 'Apply brand template…', disabled: true },
      ...saved.map((tpl) => ({ value: tpl.id, label: tpl.name }))]}
    onChange={(id) => { const pack = saved.find((tpl) => tpl.id === id); if (pack) onSelect(pack) }} />
}

const badgeGridCells: (OverlayPosition | null)[] = ['top-left', null, 'top-right', null, 'center', null, 'bottom-left', null, 'bottom-right']
function BrandPositionGrid({ label, value, onChange }: { label: string; value: OverlayPosition; onChange: (p: OverlayPosition) => void }): React.JSX.Element {
  return <div className="editor-pos-grid" role="radiogroup" aria-label={label}>
    {badgeGridCells.map((p, i) => p === null
      ? <span key={i} className="editor-pos-gap" aria-hidden="true" />
      : <button key={i} type="button" role="radio" aria-checked={value === p} aria-label={p.replaceAll('-', ' ')} className={cn('editor-pos-cell', value === p && 'selected')} onClick={() => onChange(p)} />)}
  </div>
}
