import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpDown, ArrowUpRight, AudioLines, Clapperboard, Contrast, Eraser, FileUp, Film, Loader2, Music, Play, Plus, Replace, Search, ShieldOff, Sparkles, Square, Subtitles, Trash2, Type, Upload, Wand2, X } from 'lucide-react'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatTimecode, localFileUrl } from '../lib/utils'
import { RANGE_EFFECTS, lowerThirdPreset, lowerThirdPresets, overlayPositions, type AudioTrack, type CandidateEdit, type EditorCandidate, type EditorProject, type EditorScene, type LowerThirdPreset, type MotionPlan, type MotionShotMotion, type BRollOverlay, type OverlayPosition, type RangeEffectKind, type TextBoxFont, type TextBoxStyle, type TextOverlay, type VoiceoverPronunciation } from '../../shared/clip-editor'
import { builtinCensorWords, censorWordHit } from '../../shared/censor-words'
import { Button } from './ui/Button'
import { Select } from './ui/Select'

type Tab = 'review' | 'framing' | 'captions' | 'brand' | 'transcript'
type Tool = 'enhance' | 'caption' | 'text' | 'upload' | 'transitions' | 'hook' | 'broll' | 'music' | 'effects' | 'cleanup' | 'censor' | 'media' | 'voice'

const tools: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: 'enhance', label: 'AI enhance', icon: <Sparkles size={16} /> },
  { id: 'caption', label: 'Caption', icon: <Subtitles size={16} /> },
  { id: 'text', label: 'Text', icon: <Type size={16} /> },
  { id: 'upload', label: 'Upload', icon: <Upload size={16} /> },
  { id: 'media', label: 'Import', icon: <FileUp size={16} /> },
  { id: 'transitions', label: 'Transitions', icon: <Replace size={16} /> },
  { id: 'hook', label: 'AI hook', icon: <Wand2 size={16} /> },
  { id: 'broll', label: 'B-Roll', icon: <Clapperboard size={16} /> },
  { id: 'music', label: 'Music', icon: <Music size={16} /> },
  { id: 'effects', label: 'Effects', icon: <Contrast size={16} /> },
  { id: 'cleanup', label: 'Cleanup', icon: <Eraser size={16} /> },
  { id: 'censor', label: 'Censor', icon: <ShieldOff size={16} /> },
  { id: 'voice', label: 'Voice', icon: <AudioLines size={16} /> }
]

const positionLabels: Record<OverlayPosition, string> = { 'top-left': 'Top left', 'top-right': 'Top right', center: 'Center', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right' }
const positionOptions = overlayPositions.map((value) => ({ value, label: positionLabels[value] }))

const censorCore = (token: string): string => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase()

function transcriptTokens(project: EditorProject): string[] {
  const out: string[] = []
  for (const line of project.transcript) for (const w of line.words ?? []) {
    const core = censorCore(w.text)
    if (core) out.push(core)
  }
  return out
}

/** Unique transcript words the current censor list catches. */
function censorTokens(project: EditorProject, stems: readonly string[]): string[] {
  return [...new Set(transcriptTokens(project).filter((t) => censorWordHit(t, stems)))]
}

type MediaKind = 'image' | 'video' | 'audio'
const MEDIA_KIND_EXTS: Record<MediaKind, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'webp'],
  video: ['mp4', 'm4v', 'mov', 'mkv', 'webm'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']
}
const mediaKindOf = (ref: string): MediaKind | null => {
  const ext = ref.split('.').pop()?.toLowerCase() ?? ''
  return (Object.keys(MEDIA_KIND_EXTS) as MediaKind[]).find((kind) => MEDIA_KIND_EXTS[kind].includes(ext)) ?? null
}

interface MediaItem { ref: string; path?: string; kind: MediaKind; name: string; usedAs: string[] }

/** Every media asset this clip references, deduplicated with where it's used. */
function collectMedia(candidate: EditorCandidate, assetPaths: Record<string, string>, names: Record<string, string>, bin: { ref: string; kind: MediaKind; name: string }[]): MediaItem[] {
  const map = new Map<string, MediaItem>()
  const add = (ref: string | undefined, usedAs: string): void => {
    if (!ref) return
    const kind = mediaKindOf(ref)
    if (!kind) return
    const item = map.get(ref) ?? { ref, path: assetPaths[ref], kind, name: names[ref] ?? ref, usedAs: [] }
    item.usedAs.push(usedAs)
    map.set(ref, item)
  }
  for (const entry of bin) add(entry.ref, 'New import')
  add(candidate.logo?.asset, 'Logo')
  add(candidate.intro_asset, 'Intro')
  add(candidate.outro_asset, 'Outro')
  add(candidate.music?.asset, 'Music')
  candidate.brolls?.forEach((b, i) => add(b.asset, `B-roll ${i + 1}`))
  candidate.text_overlays?.forEach((o) => add(o.image, 'Text image'))
  candidate.motion_refs?.forEach((r) => add(r.asset, 'Motion ref'))
  return [...map.values()]
}

export function EditorToolRail({ outputDir, project, candidate, sceneIndex, time, disabled, assetPaths, change, seek, setTab, setError, setNotice, textFocus, compareOriginal, setCompareOriginal, badTakes, badTakesBusy, cleanupFocus, onDetectTakes, onKeepTake, onRemoveTake, onRemoveAllTakes, cleanup, onCleanupToggle, onCleanupThreshold, onCleanupSkip, onApplyCleanup, openTool }: {
  outputDir: string; project: EditorProject; candidate: EditorCandidate; sceneIndex: number; time: number; disabled: boolean
  assetPaths: Record<string, string>
  change: (patch: Partial<CandidateEdit>, remember?: boolean) => void
  seek: (t: number) => void; setTab: (tab: Tab) => void
  setError: (error: string | null) => void; setNotice: (notice: string | null) => void
  /** Set when a transcript selection became a pre-filled overlay: the Text panel opens on it. */
  textFocus?: { index: number; nonce: number } | null
  /** Compare mode: hide Range Effects from the live preview, never from the bake. */
  compareOriginal?: boolean
  setCompareOriginal?: (value: boolean) => void
  /** Speech cleanup: flagged bad takes and their actions (state lives in ClipEditor). */
  badTakes?: { start: number; end: number; reason: string }[] | null
  badTakesBusy?: boolean
  cleanupFocus?: { nonce: number } | null
  /** Opens a tool from the word toolbar (broll | text | hook | …). */
  openTool?: string | null
  onDetectTakes?: () => void
  onKeepTake?: (index: number) => void
  onRemoveTake?: (index: number) => void
  onRemoveAllTakes?: () => void
  /** Speech cleanup proposals (fillers + pauses), detected locally in ClipEditor. */
  cleanup?: { fillers: number; pauses: number; savedMs: number; fillersOn: boolean; pausesOn: boolean; thresholdMs: number; chips: { key: string; label: string }[] }
  onCleanupToggle?: (kind: 'fillers' | 'pauses', on: boolean) => void
  onCleanupThreshold?: (ms: number) => void
  onCleanupSkip?: (key: string) => void
  onApplyCleanup?: () => void
}): React.JSX.Element {
  const [tool, setTool] = useState<Tool | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [hook, setHook] = useState<string | null>(null)
  const [enhance, setEnhance] = useState<{ title: string; caption_edits: { segment: number; text: string }[] } | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const [audioTracks, setAudioTracks] = useState<AudioTrack[] | null>(null)
  const [audioBusy, setAudioBusy] = useState(false)
  const [audioPercent, setAudioPercent] = useState<number | null>(null)
  const [showAudioAdd, setShowAudioAdd] = useState(false)
  const [audioLink, setAudioLink] = useState('')
  const [audioQuery, setAudioQuery] = useState('')
  const [ltPicker, setLtPicker] = useState<'name-tag' | 'location' | null>(null)
  const [censorDraft, setCensorDraft] = useState('')
  const [mediaTab, setMediaTab] = useState<'all' | MediaKind>('all')
  const [mediaBin, setMediaBin] = useState<{ ref: string; kind: MediaKind; name: string }[]>([])
  const [mediaBusy, setMediaBusy] = useState(false)
  const [focusOverlay, setFocusOverlay] = useState<number | null>(null)
  const [motionIdea, setMotionIdea] = useState('')
  const [motionRefs, setMotionRefs] = useState<{ asset: string; name: string; kind: 'image' | 'video' | 'audio' }[]>(() =>
    (candidate.motion_refs ?? []).map((r) => ({ asset: r.asset, name: r.asset, kind: r.kind })))
  const [motionStyle, setMotionStyle] = useState<'auto' | 'clean' | 'dynamic' | 'cinematic'>('auto')
  const [motionLength, setMotionLength] = useState(6000)
  const [motionPlan, setMotionPlan] = useState<MotionPlan | null>(null)
  const [motionBusy, setMotionBusy] = useState<'plan' | 'render' | null>(null)
  const [motionPercent, setMotionPercent] = useState<number | null>(null)
  const [effectKind, setEffectKind] = useState<RangeEffectKind>('warm')
  const [effectIntensity, setEffectIntensity] = useState(.6)
  const [markStart, setMarkStart] = useState<number | null>(null)
  const [markEnd, setMarkEnd] = useState<number | null>(null)
  const [voScript, setVoScript] = useState(() => candidate.voiceover?.script ?? '')
  const [voVoice, setVoVoice] = useState(() => candidate.voiceover?.voice ?? '')
  const [voRate, setVoRate] = useState(() => candidate.voiceover?.rate ?? 1)
  const [voProns, setVoProns] = useState<VoiceoverPronunciation[]>(() => candidate.voiceover?.pronunciations ?? [])
  const [voVoices, setVoVoices] = useState<string[] | null>(null)
  const [voBusy, setVoBusy] = useState(false)
  const [voPlaying, setVoPlaying] = useState(false)
  const assetName = (ref: string): string => names[ref] ?? `.${ref.split('.').pop()?.toUpperCase()}`

  const addAsset = useCallback(async (kind: 'image' | 'video' | 'audio'): Promise<{ asset: string; name: string } | null> => {
    try {
      const picked = await getApi().editor.addAsset(outputDir, kind)
      if (picked) setNames((n) => ({ ...n, [picked.asset]: picked.name }))
      return picked
    } catch (e) { setError(errorMessage(e)); return null }
  }, [outputDir, setError])

  const runAi = async (action: 'hook' | 'enhance'): Promise<void> => {
    if (aiBusy) return
    setAiBusy(true); setError(null)
    try {
      if (action === 'hook') setHook((await getApi().editor.aiHook(outputDir, candidate.id)).text)
      else setEnhance(await getApi().editor.aiEnhance(outputDir, candidate.id))
    } catch (e) { setError(errorMessage(e)) } finally { setAiBusy(false) }
  }

  const patchScenes = (patch: Partial<EditorScene>): void =>
    change({ scenes: candidate.scenes.map((s, i) => i === sceneIndex ? { ...s, ...patch } : s) })
  /** Auto Transitions: apply (or clear) one setting on every scene change at once. */
  const patchEveryChange = (patch: Partial<EditorScene>): void =>
    change({ scenes: candidate.scenes.map((s) => s.at_ms > 0 ? { ...s, ...patch } : s) })

  const addTextOverlay = (): void => {
    const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + 3000)
    if (end_ms - start_ms < 100) return
    change({ text_overlays: [...(candidate.text_overlays ?? []), { text: 'New text', start_ms, end_ms, position: 'center' as OverlayPosition }] })
  }
  /** One-click styled cards (Opus's Heading / Body text): fully editable after. */
  const addStyledText = (text: string, style: TextBoxStyle): void => {
    const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + 3500)
    if (end_ms - start_ms < 100) return
    change({ text_overlays: [...(candidate.text_overlays ?? []), { text, start_ms, end_ms, position: 'center' as OverlayPosition, variant: 'solid', style }] })
  }
  const addHeadingOverlay = (): void => addStyledText('YOUR HEADING HERE', { font: 'poppins', size: 0.062, color: '#111318', background: '#ffffff', radius: 12, padding: 1.15, align: 'center' })
  const addBodyOverlay = (): void => addStyledText('Body text — one short line that supports the hook.', { font: 'montserrat', size: 0.03, color: '#ffffff', background: '#14161c', radius: 10, padding: 1, align: 'center' })
  const patchOverlay = (i: number, patch: Partial<TextOverlay>): void =>
    change({ text_overlays: candidate.text_overlays!.map((t, j) => j === i ? { ...t, ...patch } : t) })
  // Opus-style entry 1: a Lower Third preset lands at the playhead, fully editable after.
  const addLowerThird = (preset: LowerThirdPreset): void => {
    const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + 3500)
    if (end_ms - start_ms < 100) { setNotice('The lower third needs at least 0.1s after the playhead. Seek earlier and try again.'); return }
    const isName = preset.kind === 'name-tag'
    const overlay: TextOverlay = { text: isName ? 'Name Surname' : 'Location name', start_ms, end_ms, position: preset.position, preset: preset.id, variant: 'solid' }
    if (preset.sub) overlay.sub = isName ? 'Add a role or title' : 'Add a region'
    const next = [...(candidate.text_overlays ?? []), overlay].sort((a, b) => a.start_ms - b.start_ms)
    change({ text_overlays: next })
    setFocusOverlay(next.indexOf(overlay))
  }
  useEffect(() => {
    if (!textFocus) return
    setTool('text'); setLtPicker('name-tag'); setFocusOverlay(textFocus.index)
  }, [textFocus])
  useEffect(() => {
    if (cleanupFocus) setTool('cleanup')
  }, [cleanupFocus])
  useEffect(() => {
    if (openTool) setTool(openTool as Tool)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTool])
  const addBRoll = async (): Promise<void> => {
    const picked = await addAsset('video') ?? await addAsset('image')
    if (!picked) return
    const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + 5000)
    if (end_ms - start_ms < 100) { setNotice('B-roll needs at least 0.1s after the playhead. Seek earlier and try again.'); return }
    change({ brolls: [...(candidate.brolls ?? []), { asset: picked.asset, start_ms, end_ms }].sort((a, b) => a.start_ms - b.start_ms) })
  }

  const refreshAudio = useCallback(async (): Promise<AudioTrack[]> => {
    try { const tracks = await getApi().editor.audioList(); setAudioTracks(tracks); return tracks }
    catch (e) { setError(errorMessage(e)); return [] }
  }, [setError])
  useEffect(() => { if (tool === 'music') void refreshAudio() }, [tool, refreshAudio])
  // Library preview: one track at a time, stopped when the tool closes.
  const previewAudio = useRef<HTMLAudioElement | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const stopPreview = useCallback(() => {
    previewAudio.current?.pause()
    previewAudio.current = null
    setPreviewId(null)
  }, [])
  useEffect(() => { if (tool !== 'music') stopPreview() }, [tool, stopPreview])
  const togglePreview = (track: AudioTrack): void => {
    if (previewId === track.id) { stopPreview(); return }
    if (!track.file) return
    stopPreview()
    const audio = new Audio(localFileUrl(track.file))
    audio.onended = stopPreview
    previewAudio.current = audio
    setPreviewId(track.id)
    void audio.play().catch(() => stopPreview())
  }
  // The import runs as an editor operation in main; poll its audio progress until it settles.
  useEffect(() => {
    if (!audioBusy) return
    let active = true
    const tick = async (): Promise<void> => {
      try {
        const state = await getApi().editor.operationProgress(outputDir)
        if (active && state.progress?.phase === 'audio') setAudioPercent(state.progress.percent)
      } catch { /* A missed poll is not an import failure. */ }
    }
    const timer = setInterval(() => { void tick() }, 600)
    return () => { active = false; clearInterval(timer) }
  }, [audioBusy, outputDir])

  const importAudio = async (source: { mode: 'file'; path?: string } | { mode: 'link'; url: string }): Promise<void> => {
    if (audioBusy) return
    setAudioBusy(true); setAudioPercent(source.mode === 'link' ? 0 : null); setError(null); setShowAudioAdd(false)
    try {
      const imported = await getApi().editor.importAudio(outputDir, source)
      if (imported) {
        setNames((n) => ({ ...n, [imported.asset]: imported.name }))
        change({ music: { asset: imported.asset, gain: .3 } })
        await refreshAudio()
        setNotice(`Imported “${imported.name}”. It is saved in the audio library for other clips too.`)
      }
    } catch (e) {
      const message = errorMessage(e)
      if (/cancel/i.test(message)) setNotice('Audio import cancelled.')
      else setError(message)
    } finally { setAudioBusy(false); setAudioPercent(null) }
  }
  const applyTrack = async (track: AudioTrack): Promise<void> => {
    try {
      const picked = await getApi().editor.audioAttach(outputDir, track.id)
      setNames((n) => ({ ...n, [picked.asset]: picked.name }))
      change({ music: { asset: picked.asset, gain: .3 } })
    } catch (e) { setError(errorMessage(e)) }
  }
  const removeTrack = async (track: AudioTrack): Promise<void> => {
    try {
      if (await getApi().editor.audioRemove(track.id)) setAudioTracks((current) => current?.filter((t) => t.id !== track.id) ?? null)
    } catch (e) { setError(errorMessage(e)) }
  }

  // --- Voiceover Studio: script + installed voice + pacing + pronunciations, previewed locally ---
  useEffect(() => {
    setVoScript(candidate.voiceover?.script ?? '')
    setVoVoice(candidate.voiceover?.voice ?? '')
    setVoRate(candidate.voiceover?.rate ?? 1)
    setVoProns(candidate.voiceover?.pronunciations ?? [])
  }, [candidate.id])
  useEffect(() => {
    if (tool !== 'voice' || voVoices) return
    let active = true
    void getApi().editor.voiceVoices(outputDir).then((voices) => { if (active) setVoVoices(voices) }).catch(() => { if (active) setVoVoices([]) })
    return () => { active = false }
  }, [tool, voVoices, outputDir])
  const voAudioRef = useRef<HTMLAudioElement | null>(null)
  const stopVoPreview = (): void => { voAudioRef.current?.pause(); voAudioRef.current = null; setVoPlaying(false) }
  // Closing the editor must not leave a library or voiceover preview playing.
  useEffect(() => () => { previewAudio.current?.pause(); voAudioRef.current?.pause() }, [])
  const playVoAsset = (asset: string): void => {
    // Voice Studio is Windows-local; tolerate an outputDir that already ends with a separator.
    const voicePath = /[\\/]$/.test(outputDir) ? `${outputDir}editor-asset-${asset}` : `${outputDir}\\editor-asset-${asset}`
    const audio = new Audio(localFileUrl(voicePath))
    voAudioRef.current = audio
    setVoPlaying(true)
    audio.onended = () => { setVoPlaying(false); if (voAudioRef.current === audio) voAudioRef.current = null }
    void audio.play().catch(() => setVoPlaying(false))
  }
  const previewVoiceover = async (): Promise<void> => {
    if (voBusy) return
    if (voPlaying) { stopVoPreview(); return }
    if (voScript.trim().length < 10) return
    setVoBusy(true); setError(null)
    try {
      const result = await getApi().editor.voicePreview(outputDir, { script: voScript, voice: voVoice, rate: voRate, pronunciations: voProns })
      setNames((n) => ({ ...n, [result.asset]: 'Voiceover preview' }))
      change({ voiceover: { script: voScript, voice: voVoice, rate: voRate, pronunciations: voProns, audio_asset: result.asset,
        duration_ms: result.durationMs, start_ms: candidate.voiceover?.start_ms ?? 0, gain: candidate.voiceover?.gain ?? 1 } })
      setNotice(`Voiceover ready — ${(result.durationMs / 1000).toFixed(1)}s. Playing it now. Drag the Voice block on the timeline to move it.`)
      playVoAsset(result.asset)
    } catch (e) { setError(errorMessage(e)) } finally { setVoBusy(false) }
  }
  /** Sample one voice on a short fixed line, without touching the saved voiceover. */
  const sampleVoice = async (): Promise<void> => {
    if (voBusy) return
    setVoBusy(true); setError(null)
    try {
      const result = await getApi().editor.voicePreview(outputDir, { script: 'Hi! This is what this voice sounds like in your video.', voice: voVoice, rate: voRate, pronunciations: voProns })
      playVoAsset(result.asset)
    } catch (e) { setError(errorMessage(e)) } finally { setVoBusy(false) }
  }

  // --- Range Effects: scoped visual edits, applied the moment you click Apply ---
  const applyRangeEdit = (): void => {
    if (markStart == null || markEnd == null) { setNotice('Mark both a start and an end on the timeline first.'); return }
    const start_ms = Math.min(markStart, markEnd), end_ms = Math.max(markStart, markEnd)
    if (end_ms - start_ms < 100) { setNotice('The range needs at least 0.1s. Move the playhead and mark again.'); return }
    if ((candidate.range_edits?.length ?? 0) >= 8) { setNotice('Eight effects per clip. Remove one first.'); return }
    change({ range_edits: [...(candidate.range_edits ?? []),
      { id: crypto.randomUUID().replaceAll('-', ''), kind: effectKind, intensity: effectIntensity, start_ms, end_ms }].sort((a, b) => a.start_ms - b.start_ms) })
    setMarkStart(null); setMarkEnd(null)
  }

  // --- Motion Studio: idea + references → shot plan → local render as a B-roll ---
  const persistRefs = (refs: typeof motionRefs): void => {
    setMotionRefs(refs)
    change({ motion_refs: refs.map(({ asset, kind }) => ({ asset, kind })) })
  }
  const addMotionRef = async (kind: 'image' | 'video' | 'audio'): Promise<void> => {
    const caps = { image: 30, video: 10, audio: 10 }
    if (motionRefs.filter((r) => r.kind === kind).length >= caps[kind]) return
    const picked = await addAsset(kind)
    if (!picked) return
    persistRefs([...motionRefs, { asset: picked.asset, name: picked.name, kind }])
  }
  const removeMotionRef = (index: number): void => persistRefs(motionRefs.filter((_, i) => i !== index))
  const patchShot = (index: number, patch: Partial<MotionPlan['shots'][number]>): void =>
    setMotionPlan((plan) => plan && { ...plan, shots: plan.shots.map((s, i) => i === index ? { ...s, ...patch } : s) })
  const createPlan = async (): Promise<void> => {
    if (motionBusy || !motionIdea.trim()) return
    setMotionBusy('plan'); setError(null)
    try { setMotionPlan(await getApi().editor.motionPlan({ idea: motionIdea, references: motionRefs, style: motionStyle, lengthMs: motionLength })) }
    catch (e) { setError(errorMessage(e)) } finally { setMotionBusy(null) }
  }
  const generateMotion = async (): Promise<void> => {
    if (motionBusy || !motionPlan) return
    setMotionBusy('render'); setMotionPercent(0); setError(null)
    try {
      const audioRef = motionRefs.find((r) => r.kind === 'audio')
      const result = await getApi().editor.motionRender(outputDir, motionPlan, audioRef?.asset)
      setNames((n) => ({ ...n, [result.asset]: motionPlan.title }))
      const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + result.durationMs)
      if (end_ms - start_ms < 100) { setNotice('The motion clip is generated. Seek earlier to place it at the playhead.'); return }
      change({ brolls: [...(candidate.brolls ?? []), { asset: result.asset, start_ms, end_ms }].sort((a, b) => a.start_ms - b.start_ms) })
      setNotice(`Motion clip ready — placed at the playhead (${(result.durationMs / 1000).toFixed(1)}s).`)
    } catch (e) {
      const message = errorMessage(e)
      if (/cancel/i.test(message)) setNotice('Motion clip generation cancelled.')
      else setError(message)
    } finally { setMotionBusy(null); setMotionPercent(null) }
  }
  useEffect(() => {
    if (motionBusy !== 'render') return
    let active = true
    const tick = async (): Promise<void> => {
      try {
        const state = await getApi().editor.operationProgress(outputDir)
        if (active && state.progress?.phase === 'motion') setMotionPercent(state.progress.percent)
      } catch { /* A missed poll is not a render failure. */ }
    }
    const timer = setInterval(() => { void tick() }, 600)
    return () => { active = false; clearInterval(timer) }
  }, [motionBusy, outputDir])

  return <aside className="editor-rail" aria-label="Editor tools">
    {tool && <div className="editor-tool-panel" role="region" aria-label={`${tools.find((t) => t.id === tool)?.label} panel`}>
      <div className="flex items-center justify-between gap-2 mb-2"><strong className="text-xs">{tools.find((t) => t.id === tool)?.label}</strong>
        <Button size="sm" variant="ghost" iconOnly icon={<X size={13} />} aria-label="Close panel" onClick={() => setTool(null)} /></div>
      {tool === 'enhance' && <div className="space-y-3">
        <p className="text-2xs text-ink-subtle">Ask the AI backend (local or NVIDIA) for a sharper title and caption fixes for this clip.</p>
        <Button size="sm" disabled={disabled || aiBusy} icon={aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} onClick={() => { void runAi('enhance') }}>Suggest improvements</Button>
        {enhance && <div className="space-y-2 border-t border-white/10 pt-2">
          <p className="text-2xs text-ink-subtle">Suggested title</p><p className="text-xs">{enhance.title}</p>
          {enhance.caption_edits.length > 0 && <p className="text-2xs text-ink-subtle">{enhance.caption_edits.length} caption fix{enhance.caption_edits.length === 1 ? '' : 'es'} · at {enhance.caption_edits.map((e) => formatTimecode(project.transcript[e.segment]?.start_ms ?? 0)).join(', ')}</p>}
          <div className="flex gap-2"><Button size="sm" disabled={disabled} onClick={() => {
            change({ title: enhance.title, caption_edits: [...new Map([...candidate.caption_edits, ...enhance.caption_edits].map((e) => [e.segment, e])).values()].sort((a, b) => a.segment - b.segment) })
            setEnhance(null); setNotice('AI suggestions applied.')
          }}>Apply</Button><Button size="sm" variant="ghost" onClick={() => setEnhance(null)}>Dismiss</Button></div>
        </div>}
      </div>}
      {tool === 'hook' && <div className="space-y-3">
        <p className="text-2xs text-ink-subtle">Generate a punchy opening line from this clip's first words.</p>
        <Button size="sm" disabled={disabled || aiBusy} icon={aiBusy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} onClick={() => { void runAi('hook') }}>Generate hook</Button>
        {hook && <div className="space-y-2 border-t border-white/10 pt-2">
          <p className="text-xs">{hook}</p>
          <Button size="sm" disabled={disabled} onClick={() => {
            const start_ms = candidate.ranges[0][0], end_ms = Math.min(project.duration_ms, start_ms + 2500)
            const overlay: TextOverlay = { text: hook, start_ms, end_ms, position: 'top-left' }
            change({ text_overlays: [overlay, ...(candidate.text_overlays ?? [])].sort((a, b) => a.start_ms - b.start_ms) })
            setHook(null); setNotice('Hook added as an opening text overlay.')
          }}>Add as opening text</Button>
        </div>}
      </div>}
      {tool === 'caption' && <div className="space-y-3">
        <p className="text-2xs text-ink-subtle">Caption style, placement and caption-free sections live in the inspector.</p>
        <Button size="sm" icon={<Subtitles size={13} />} onClick={() => { setTab('captions'); setTool(null) }}>Open caption settings</Button>
        <Button size="sm" variant="ghost" icon={<ArrowUpRight size={13} />} onClick={() => { setTab('transcript'); setTool(null) }}>Open transcript editing</Button>
      </div>}
      {tool === 'text' && <div className="space-y-2">
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" disabled={disabled || (candidate.text_overlays?.length ?? 0) >= 20} onClick={addTextOverlay}>Add text</Button>
        {(() => {
          // Opus-style cap: at most five text boxes on screen at the same moment.
          const events = (candidate.text_overlays ?? []).flatMap((o) => [[o.start_ms, 1], [o.end_ms, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
          let active = 0, max = 0
          for (const [, delta] of events) { active += delta; if (active > max) max = active }
          return max >= 5 ? <p className="text-2xs text-ink-subtle">Five text boxes are on screen at once — end or remove one to add another.</p> : null
        })()}
          <Button size="sm" variant={ltPicker === 'name-tag' ? 'primary' : 'ghost'} aria-pressed={ltPicker === 'name-tag'}
            disabled={disabled || (candidate.text_overlays?.length ?? 0) >= 20}
            onClick={() => setLtPicker((p) => p === 'name-tag' ? null : 'name-tag')}>Name Tag</Button>
          <Button size="sm" variant={ltPicker === 'location' ? 'primary' : 'ghost'} aria-pressed={ltPicker === 'location'}
            disabled={disabled || (candidate.text_overlays?.length ?? 0) >= 20}
            onClick={() => setLtPicker((p) => p === 'location' ? null : 'location')}>Location</Button>
          <Button size="sm" disabled={disabled || (candidate.text_overlays?.length ?? 0) >= 20}
            onClick={addHeadingOverlay}>Heading</Button>
          <Button size="sm" disabled={disabled || (candidate.text_overlays?.length ?? 0) >= 20}
            onClick={addBodyOverlay}>Body text</Button>
        </div>
        {ltPicker && <div className="editor-lt-grid" role="listbox" aria-label={`${ltPicker === 'name-tag' ? 'Name Tag' : 'Location'} templates`}>
          {lowerThirdPresets.filter((p) => p.kind === ltPicker).map((p) => <button key={p.id} className="editor-lt-card" role="option"
            aria-label={`${p.label} template`} disabled={disabled} onClick={() => { addLowerThird(p); setLtPicker(null) }}>
            <span className="editor-lt-swatch" style={{ background: p.tone }} aria-hidden />
            <span className="editor-lt-label">{p.label}</span>
            {p.variants.length > 1 && <span className="text-2xs text-ink-subtle">{p.variants.length} variants</span>}
          </button>)}
        </div>}
        {(candidate.text_overlays ?? []).map((o, i) => {
          const preset = o.preset ? lowerThirdPreset(o.preset) : undefined
          return <div key={i} className={cn('editor-overlay-card', focusOverlay === i && 'focused')}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-subtle">{preset ? preset.label : `Text ${i + 1}`} · {formatTimecode(o.start_ms)}–{formatTimecode(o.end_ms)}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove text ${i + 1}`} disabled={disabled} onClick={() => change({ text_overlays: (candidate.text_overlays ?? []).filter((_, j) => j !== i) })} />
            </div>
            <textarea rows={2} maxLength={120} value={o.text} disabled={disabled} aria-label={`${preset ? preset.label : `Text ${i + 1}`} content`} onChange={(e) => {
              if (!e.target.value.trim()) return
              patchOverlay(i, { text: e.target.value })
            }} />
            {preset?.sub && <textarea rows={1} maxLength={120} placeholder={preset.kind === 'name-tag' ? 'Role or title' : 'Region'} value={o.sub ?? ''} disabled={disabled}
              aria-label={`${preset.label} secondary line`} onChange={(e) => patchOverlay(i, { sub: e.target.value.trim() ? e.target.value : undefined })} />}
            {preset && <div className="flex items-center gap-2 flex-wrap">
              <Select size="sm" className="flex-1 min-w-0" aria-label={`${preset.label} template`} value={o.preset ?? ''}
                options={lowerThirdPresets.map((p) => ({ value: p.id, label: p.label }))}
                onChange={(id) => { const next = lowerThirdPreset(id); if (next) patchOverlay(i, { preset: next.id, position: next.position }) }} />
              {preset.variants.includes('color') && <label className="editor-lt-color" title="Accent color">
                <input type="color" aria-label={`${preset.label} accent color`} disabled={disabled}
                  value={o.variant === 'color' && o.color ? o.color : preset.tone}
                  onChange={(e) => patchOverlay(i, { variant: 'color', color: e.target.value })} />
              </label>}
              {preset.variants.includes('image') && <Button size="sm" variant={o.variant === 'image' ? 'primary' : 'ghost'} aria-pressed={o.variant === 'image'} disabled={disabled}
                title={o.variant === 'image' ? 'Turn the picture band off' : 'Show a picture band behind the text'} onClick={async () => {
                  if (o.variant === 'image') { patchOverlay(i, { variant: 'solid' }); return }
                  const picked = await addAsset('image')
                  if (picked) { setNames((n) => ({ ...n, [picked.asset]: picked.name })); patchOverlay(i, { variant: 'image', image: picked.asset }) }
                }}>Image</Button>}
            </div>}
            {!preset && <Select size="sm" aria-label={`Text ${i + 1} position`} value={o.position} options={positionOptions}
              onChange={(position) => patchOverlay(i, { position: position as OverlayPosition })} />}
            {!preset && <div className="space-y-1 border-t border-white/10 pt-2">
              <p className="text-2xs text-ink-subtle">Style</p>
              <Select size="sm" aria-label={`Text ${i + 1} font`} value={o.style?.font ?? 'montserrat'}
                options={[{ value: 'montserrat', label: 'Montserrat' }, { value: 'poppins', label: 'Poppins' }, { value: 'archivo', label: 'Archivo Black' }, { value: 'instrument', label: 'Instrument Serif' }, { value: 'jakarta', label: 'Plus Jakarta' }]}
                onChange={(font) => patchOverlay(i, { style: { ...(o.style ?? { size: .032, color: '#ffffff', background: '#14161c', radius: 10, padding: 1, align: 'center' as const }), font: font as TextBoxFont } })} />
              <label className="editor-label">Size <span className="float-right">{Math.round((o.style?.size ?? .032) * 1920)}px</span>
                <input aria-label={`Text ${i + 1} size`} type="range" min={2} max={12} step={0.1} value={(o.style?.size ?? .032) * 100} disabled={disabled}
                  onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: Number(e.target.value) / 100, color: o.style?.color ?? '#ffffff', background: o.style?.background ?? '#14161c', radius: o.style?.radius ?? 10, padding: o.style?.padding ?? 1, align: o.style?.align ?? 'center' } })} /></label>
              <div className="flex items-center gap-2">
                <label className="editor-lt-color" title="Text color"><input type="color" aria-label={`Text ${i + 1} color`} value={o.style?.color ?? '#ffffff'} disabled={disabled}
                  onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: o.style?.size ?? .032, color: e.target.value, background: o.style?.background ?? '#14161c', radius: o.style?.radius ?? 10, padding: o.style?.padding ?? 1, align: o.style?.align ?? 'center' } })} /></label>
                <label className="editor-lt-color" title="Card background"><input type="color" aria-label={`Text ${i + 1} background`} value={o.style?.background ?? '#14161c'} disabled={disabled}
                  onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: o.style?.size ?? .032, color: o.style?.color ?? '#ffffff', background: e.target.value, radius: o.style?.radius ?? 10, padding: o.style?.padding ?? 1, align: o.style?.align ?? 'center' } })} /></label>
                <label className="editor-label flex-1">Corner <span className="float-right">{o.style?.radius ?? 10}</span>
                  <input aria-label={`Text ${i + 1} corner radius`} type="range" min={0} max={24} value={o.style?.radius ?? 10} disabled={disabled}
                    onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: o.style?.size ?? .032, color: o.style?.color ?? '#ffffff', background: o.style?.background ?? '#14161c', radius: Number(e.target.value), padding: o.style?.padding ?? 1, align: o.style?.align ?? 'center' } })} /></label>
              </div>
              <label className="editor-label">Padding <span className="float-right">{(o.style?.padding ?? 1).toFixed(1)}×</span>
                <input aria-label={`Text ${i + 1} padding`} type="range" min={0.4} max={2} step={0.1} value={o.style?.padding ?? 1} disabled={disabled}
                  onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: o.style?.size ?? .032, color: o.style?.color ?? '#ffffff', background: o.style?.background ?? '#14161c', radius: o.style?.radius ?? 10, padding: Number(e.target.value), align: o.style?.align ?? 'center' } })} /></label>
              <label className="flex items-center justify-between gap-2 text-xs"><span>Left-align text</span>
                <input type="checkbox" aria-label={`Text ${i + 1} left-align`} checked={(o.style?.align ?? 'center') === 'left'} disabled={disabled}
                  onChange={(e) => patchOverlay(i, { style: { font: o.style?.font ?? 'montserrat', size: o.style?.size ?? .032, color: o.style?.color ?? '#ffffff', background: o.style?.background ?? '#14161c', radius: o.style?.radius ?? 10, padding: o.style?.padding ?? 1, align: e.target.checked ? 'left' : 'center' } })} /></label>
            </div>}
            <div className="flex gap-2"><Button size="sm" variant="ghost" disabled={disabled}
              onClick={() => { const len = o.end_ms - o.start_ms, start_ms = Math.max(0, Math.min(Math.round(time), project.duration_ms - len)); patchOverlay(i, { start_ms, end_ms: Math.min(project.duration_ms, start_ms + len) }) }}>Move to playhead</Button></div>
          </div>
        })}
        {!candidate.text_overlays?.length && <p className="text-2xs text-ink-subtle">No text yet. Add plain text, or pick a Name Tag / Location template.</p>}
      </div>}
      {tool === 'upload' && <div className="space-y-3">
        <div className="editor-upload-card">
          <div className="editor-upload-thumb">{candidate.logo && assetPaths[candidate.logo.asset]
            ? <img src={localFileUrl(assetPaths[candidate.logo.asset])} alt="Logo preview" />
            : <span className="text-2xs text-ink-subtle">PNG / JPG</span>}<span className="text-2xs">{candidate.logo ? assetName(candidate.logo.asset) : 'Logo'}</span></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled} onClick={async () => { const p = await addAsset('image'); if (p) change({ logo: { asset: p.asset, position: 'top-right', scale: .18, opacity: 1 } }) }}>Upload logo</Button>
            {candidate.logo && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label="Remove logo" disabled={disabled} onClick={() => change({ logo: undefined })} />}
          </div>
          {candidate.logo && <Button size="sm" variant="ghost" icon={<ArrowUpRight size={13} />} onClick={() => { setTab('brand'); setTool(null) }}>Open brand settings</Button>}
        </div>
        <div className="editor-upload-card">
          <div className="editor-upload-thumb">{candidate.intro_asset ? <Film size={18} /> : <span className="text-2xs text-ink-subtle">MP4 / MOV</span>}<span className="text-2xs">{candidate.intro_asset ? assetName(candidate.intro_asset) : 'Intro video'}</span></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled} onClick={async () => { const p = await addAsset('video'); if (p) change({ intro_asset: p.asset }) }}>Upload intro</Button>
            {candidate.intro_asset && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label="Remove intro" disabled={disabled} onClick={() => change({ intro_asset: undefined })} />}
          </div>
          {candidate.intro_asset && <p className="text-2xs text-ink-subtle">The intro plays before the clip in the baked export.</p>}
        </div>
        <div className="editor-upload-card">
          <div className="editor-upload-thumb">{candidate.outro_asset ? <Film size={18} /> : <span className="text-2xs text-ink-subtle">MP4 / MOV</span>}<span className="text-2xs">{candidate.outro_asset ? assetName(candidate.outro_asset) : 'Outro video'}</span></div>
          <div className="flex gap-2">
            <Button size="sm" disabled={disabled} onClick={async () => { const p = await addAsset('video'); if (p) change({ outro_asset: p.asset }) }}>Upload outro</Button>
            {candidate.outro_asset && <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label="Remove outro" disabled={disabled} onClick={() => change({ outro_asset: undefined })} />}
          </div>
          {candidate.outro_asset && <p className="text-2xs text-ink-subtle">The outro plays after the clip in the baked export.</p>}
        </div>
      </div>}
      {tool === 'media' && (() => {
        const items = collectMedia(candidate, assetPaths, names, mediaBin)
        const shown = mediaTab === 'all' ? items : items.filter((item) => item.kind === mediaTab)
        const importDrop = async (file: File): Promise<void> => {
          if (mediaBusy || disabled) return
          setMediaBusy(true); setError(null)
          try {
            const path = await getApi().dialog.authorizeDrop(file)
            if (!path) throw new Error('That is not a supported media file.')
            const imported = await getApi().editor.addAssetDropped(outputDir, path)
            if (!imported) return
            const kind = mediaKindOf(imported.asset)
            if (!kind) { setError("That file type can't be used here."); return }
            setNames((n) => ({ ...n, [imported.asset]: imported.name }))
            setMediaBin((bin) => [{ ref: imported.asset, kind, name: imported.name }, ...bin.filter((b) => b.ref !== imported.asset)])
          } catch (e) { setError(errorMessage(e)) } finally { setMediaBusy(false) }
        }
        const pickMedia = (): void => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.png,.jpg,.jpeg,.webp,.mp4,.m4v,.mov,.mkv,.webm,.mp3,.wav,.m4a,.aac,.ogg,.flac'
          input.onchange = () => { const file = input.files?.[0]; if (file) void importDrop(file) }
          input.click()
        }
        const addBRollAt = (ref: string): void => {
          const start_ms = Math.round(time), end_ms = Math.min(project.duration_ms, start_ms + 5000)
          if (end_ms - start_ms < 100) { setNotice('A B-roll needs at least 0.1s after the playhead — seek earlier.'); return }
          if ((candidate.brolls ?? []).some((r) => start_ms < r.end_ms && end_ms > r.start_ms)) {
            setNotice('A B-roll already covers that spot — seek to a free part of the timeline first.'); return
          }
          change({ brolls: [...(candidate.brolls ?? []), { asset: ref, start_ms, end_ms }].sort((a, b) => a.start_ms - b.start_ms) })
          setNotice('B-roll added at the playhead — adjust it in the B-Roll tool.')
        }
        return <div className="space-y-3">
          <p className="text-2xs text-ink-subtle">Import your own images, videos and audio, then drop them onto the clip as B-roll, logo, intro, outro or music. Everything stays local to this project.</p>
          <button type="button" className="editor-audio-drop" disabled={mediaBusy || disabled}
            onClick={pickMedia}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) void importDrop(file) }}>
            <FileUp size={16} /><span>Click to upload or drop a file here</span>
            <span className="text-2xs text-ink-subtle">Images png / jpg / webp · Videos mp4 / mov / mkv / webm · Audio mp3 / wav / m4a</span>
          </button>
          {mediaBusy && <p className="text-2xs text-ink-subtle" role="status">Importing…</p>}
          <div className="flex gap-1.5" role="tablist" aria-label="Media filter">
            {([['all', 'All'], ['image', 'Image'], ['video', 'Video']] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={mediaTab === id} onClick={() => setMediaTab(id)}
                className={cn('glass-tile glass-tile-hover rounded-full px-3 py-1 text-xs', mediaTab === id ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                {label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {shown.map((item) => <div key={item.ref} className="editor-media-card" aria-label={item.name}>
              <div className="editor-media-thumb">
                {item.kind === 'image' && item.path ? <img src={localFileUrl(item.path)} alt="" /> :
                  item.kind === 'video' && item.path ? <video src={`${localFileUrl(item.path)}#t=0.5`} muted preload="metadata" /> :
                    <Music size={16} className="text-ink-subtle" aria-hidden="true" />}
              </div>
              <p className="truncate text-2xs" title={item.name}>{item.name}</p>
              <p className="truncate text-2xs text-ink-subtle" title={item.usedAs.join(' · ')}>{item.usedAs.join(' · ')}</p>
              <div className="flex flex-wrap gap-1">
                {item.kind !== 'audio' && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => addBRollAt(item.ref)}>B-roll</Button>}
                {item.kind === 'video' && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change({ intro_asset: item.ref })}>Intro</Button>}
                {item.kind === 'video' && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change({ outro_asset: item.ref })}>Outro</Button>}
                {item.kind === 'image' && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change({ logo: { asset: item.ref, position: 'top-right', scale: .18, opacity: 1 } })}>Logo</Button>}
                {item.kind === 'audio' && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => change({ music: { asset: item.ref, gain: .3 } })}>Music</Button>}
              </div>
            </div>)}
            {!shown.length && <p className="text-2xs text-ink-subtle col-span-2">Nothing here yet — upload a file, or use one in the editor first.</p>}
          </div>
        </div>
      })()}
      {tool === 'transitions' && (() => {
        const changes = candidate.scenes.filter((s) => s.at_ms > 0)
        const allAuto = changes.length > 0 && changes.every((s) => !!s.transition_ms)
        const setAll = (on: boolean): void => patchEveryChange({
          transition_ms: on ? 500 : undefined,
          transition_kind: on ? 'crossfade' : undefined
        })
        const TRANSITIONS: [NonNullable<EditorScene['transition_kind']>, string][] = [
          ['motion', 'Smooth movement'], ['crossfade', 'Crossfade'], ['dissolve', 'Dissolve'], ['wipe', 'Wipe'],
          ['crosszoom', 'Cross zoom'], ['zoomin', 'Zoom in'], ['zoomout', 'Zoom out'], ['fadein', 'Fade in'], ['fadeout', 'Fade out']]
        return <div className="space-y-3">
          {changes.length > 0 && <label className="flex items-center justify-between gap-2 text-xs"><span>Auto crossfade every change</span>
            <input type="checkbox" aria-label="Auto crossfade every change" checked={allAuto} disabled={disabled}
              onChange={(e) => setAll(e.target.checked)} /></label>}
          {sceneIndex === 0 ? <p className="text-2xs text-ink-subtle">The first section has no incoming transition. Seek past a layout change to edit its transition.</p> : <>
            <p className="text-2xs text-ink-subtle">Transition into the layout starting at {formatTimecode(candidate.scenes[sceneIndex].at_ms)}.</p>
            <label className="flex items-center justify-between gap-2 text-xs"><span>Animated transition</span>
              <input type="checkbox" aria-label="Animated transition" checked={!!candidate.scenes[sceneIndex].transition_ms} disabled={disabled}
                onChange={(e) => patchScenes({ transition_ms: e.target.checked ? 600 : undefined, transition_kind: e.target.checked ? candidate.scenes[sceneIndex].transition_kind : undefined })} /></label>
            {!!candidate.scenes[sceneIndex].transition_ms && <>
              <Select size="sm" aria-label="Transition style" value={candidate.scenes[sceneIndex].transition_kind ?? 'motion'}
                options={TRANSITIONS.map(([value, label]) => ({ value, label }))}
                onChange={(transition_kind) => patchScenes({ transition_kind: transition_kind === 'motion' ? undefined : transition_kind as EditorScene['transition_kind'] })} />
              <label className="editor-label">Duration <span className="float-right">{(candidate.scenes[sceneIndex].transition_ms! / 1000).toFixed(1)}s</span>
                <input aria-label="Transition duration" type="range" min={100} max={5000} step={100} value={candidate.scenes[sceneIndex].transition_ms!} onChange={(e) => patchScenes({ transition_ms: Number(e.target.value) })} /></label>
            </>}
          </>}
        </div>
      })()}
      {tool === 'broll' && <div className="space-y-2">
        <Button size="sm" disabled={disabled || (candidate.brolls?.length ?? 0) >= 24} onClick={() => { void addBRoll() }}>Add B-roll at playhead</Button>
        {(candidate.brolls ?? []).map((b, i) => <div key={i} className="editor-overlay-card">
          <div className="flex items-center justify-between gap-2"><span className="text-2xs text-ink-subtle">{assetName(b.asset)} · {formatTimecode(b.start_ms)}–{formatTimecode(b.end_ms)}</span>
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove B-roll ${i + 1}`} disabled={disabled} onClick={() => change({ brolls: (candidate.brolls ?? []).filter((_, j) => j !== i) })} /></div>
          <Select size="sm" aria-label={`B-roll ${i + 1} layout`} value={b.layout ?? 'fill'} disabled={disabled}
            options={[{ value: 'fill', label: 'Layout: Fill' }, { value: 'pip', label: 'Picture-in-Picture' },
              ...(project.aspect_ratio === '9:16' ? [{ value: 'split', label: 'Split' }] : [])]}
            onChange={(layout) => change({ brolls: (candidate.brolls ?? []).map((x, j) => j === i
              ? { ...x, layout: layout === 'fill' ? undefined : layout as BRollOverlay['layout'], swap: layout === 'split' ? x.swap : undefined } : x) })} />
          {b.layout === 'split' && <Button size="sm" variant="ghost" icon={<ArrowUpDown size={12} />} disabled={disabled}
            onClick={() => change({ brolls: (candidate.brolls ?? []).map((x, j) => j === i ? { ...x, swap: !x.swap } : x) })}>
            {b.swap ? 'B-roll on top — swap' : 'B-roll on bottom — swap'}</Button>}
          <div className="flex gap-2 mt-1"><Button size="sm" variant="ghost" disabled={disabled} onClick={() => seek(b.start_ms)}>Go to start</Button></div>
        </div>)}
        {!candidate.brolls?.length && <p className="text-2xs text-ink-subtle">No B-roll yet. Seek where it should start and add a clip or image over the footage.</p>}
        <div className="editor-motion">
          <strong className="text-xs">Motion Studio</strong>
          <p className="text-2xs text-ink-subtle">Describe an idea, review the shot plan, and generate — rendered locally from your references.</p>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="ghost" disabled={motionBusy != null} onClick={() => setMotionIdea('Animate the brand: the logo reveals with a slow zoom, holds, and fades out on the brand color.')}>Logo animation</Button>
            <Button size="sm" variant="ghost" disabled={motionBusy != null} onClick={() => setMotionIdea('Show the product concept: slow pans over the reference images with a bold title opener and a closing call to action.')}>Concept B-roll</Button>
            <Button size="sm" variant="ghost" disabled={motionBusy != null} onClick={() => setMotionIdea('Kinetic titles: three short message beats on dark cards, each fading in and out quickly.')}>Kinetic titles</Button>
          </div>
          <textarea rows={3} maxLength={2000} value={motionIdea} disabled={motionBusy != null}
            placeholder="Describe what happens, how it should feel, and how it ends."
            aria-label="Motion Studio idea" onChange={(e) => setMotionIdea(e.target.value)} />
          <div className="flex gap-2 flex-wrap items-center">
            <Button size="sm" variant="ghost" disabled={motionBusy != null || motionRefs.filter((r) => r.kind === 'image').length >= 30} onClick={() => { void addMotionRef('image') }}>+ Image</Button>
            <Button size="sm" variant="ghost" disabled={motionBusy != null || motionRefs.filter((r) => r.kind === 'video').length >= 10} onClick={() => { void addMotionRef('video') }}>+ Video</Button>
            <Button size="sm" variant="ghost" disabled={motionBusy != null || motionRefs.filter((r) => r.kind === 'audio').length >= 10} onClick={() => { void addMotionRef('audio') }}>+ Audio</Button>
            <span className="text-2xs text-ink-subtle">{motionRefs.length} reference{motionRefs.length === 1 ? '' : 's'}</span>
          </div>
          {motionRefs.length > 0 && <div className="editor-motion-refs">
            {motionRefs.map((r, i) => <span key={r.asset} className="editor-motion-ref">
              <span className="editor-motion-ref-name">{r.name || assetName(r.asset)}</span>
              <button type="button" aria-label={`Remove reference ${r.name || r.asset}`} disabled={motionBusy != null} onClick={() => removeMotionRef(i)}>×</button>
            </span>)}
          </div>}
          <div className="flex gap-2">
            <Select size="sm" className="flex-1 min-w-0" aria-label="Motion Studio style" value={motionStyle}
              options={[{ value: 'auto', label: 'Style: Auto' }, { value: 'clean', label: 'Style: Clean' }, { value: 'dynamic', label: 'Style: Dynamic' }, { value: 'cinematic', label: 'Style: Cinematic' }]}
              onChange={(value) => setMotionStyle(value as typeof motionStyle)} />
            <Select size="sm" aria-label="Motion Studio length" value={String(motionLength)}
              options={[{ value: '4000', label: '4s' }, { value: '6000', label: '6s' }, { value: '8000', label: '8s' }]}
              onChange={(value) => setMotionLength(Number(value))} />
          </div>
          {motionBusy === 'plan' && <p className="text-2xs text-ink-subtle" role="status">Planning the shots…</p>}
          <Button size="sm" icon={<Wand2 size={13} />} disabled={disabled || motionBusy != null || !motionIdea.trim()} onClick={() => { void createPlan() }}>Create shot plan</Button>
          {motionPlan && <>
            <div className="editor-motion-shots">
              {motionPlan.shots.map((s, i) => <div key={i} className="editor-overlay-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xs text-ink-subtle">Shot {i + 1} · {s.kind === 'still' ? 'Image' : s.kind === 'video' ? 'Video' : 'Title'}</span>
                  <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove shot ${i + 1}`} disabled={motionBusy != null}
                    onClick={() => setMotionPlan((plan) => plan && (plan.shots.length > 1 ? { ...plan, shots: plan.shots.filter((_, j) => j !== i) } : plan))} />
                </div>
                {s.kind === 'title' && <input className="editor-audio-link" value={s.text ?? ''} maxLength={120} disabled={motionBusy != null}
                  aria-label={`Shot ${i + 1} text`} onChange={(e) => { if (e.target.value.trim()) patchShot(i, { text: e.target.value }) }} />}
                {s.asset && <p className="text-2xs text-ink-subtle">{assetName(s.asset)}</p>}
                {s.kind === 'still' && <Select size="sm" aria-label={`Shot ${i + 1} movement`} value={s.motion}
                  options={[{ value: 'zoom-in', label: 'Zoom in' }, { value: 'zoom-out', label: 'Zoom out' }, { value: 'pan-left', label: 'Pan left' }, { value: 'pan-right', label: 'Pan right' }, { value: 'none', label: 'Static' }]}
                  onChange={(motion) => patchShot(i, { motion: motion as MotionShotMotion })} />}
                <label className="editor-label">Length <span className="float-right">{(s.duration_ms / 1000).toFixed(1)}s</span>
                  <input type="range" min={500} max={8000} step={100} value={s.duration_ms} disabled={motionBusy != null}
                    aria-label={`Shot ${i + 1} length`} onChange={(e) => patchShot(i, { duration_ms: Number(e.target.value) })} /></label>
              </div>)}
            </div>
            {motionBusy === 'render' && <div className="space-y-1" role="status" aria-label="Motion render progress">
              <p className="text-2xs text-ink-subtle">Generating the motion clip{motionPercent == null ? '…' : ` · ${motionPercent}%`}</p>
              <div className={cn('editor-audio-progress', motionPercent == null && 'indeterminate')}>{motionPercent != null && <div style={{ width: `${motionPercent}%` }} />}</div>
              <Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(outputDir) }}>Cancel</Button>
            </div>}
            <Button size="sm" icon={<Clapperboard size={13} />} disabled={disabled || motionBusy != null} onClick={() => { void generateMotion() }}>Generate motion clip</Button>
            <p className="text-2xs text-ink-subtle">Rendered locally into this project and placed at the playhead as a B-roll.</p>
          </>}
        </div>
      </div>}
        {tool === 'effects' && <div className="space-y-2">
          <p className="text-2xs text-ink-subtle">Scoped visual edits on a time range of the footage — applied the moment you click Apply, baked with the clip.</p>
          <Select size="sm" aria-label="Effect" value={effectKind}
            options={RANGE_EFFECTS.map((r) => ({ value: r.id, label: r.label }))}
            onChange={(kind) => setEffectKind(kind as RangeEffectKind)} />
          <label className="editor-label">Intensity <span className="float-right">{Math.round(effectIntensity * 100)}%</span>
            <input aria-label="Effect intensity" type="range" min={10} max={100} value={Math.round(effectIntensity * 100)} disabled={disabled}
              onChange={(e) => setEffectIntensity(Number(e.target.value) / 100)} /></label>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMarkStart(Math.round(time))}>Mark start{markStart != null ? ` (${formatTimecode(markStart)})` : ''}</Button>
            <Button size="sm" variant="ghost" onClick={() => setMarkEnd(Math.round(time))}>Mark end{markEnd != null ? ` (${formatTimecode(markEnd)})` : ''}</Button>
          </div>
          {markStart != null && markEnd != null && <p className="text-2xs text-ink-subtle">Selected {formatTimecode(Math.min(markStart, markEnd))} – {formatTimecode(Math.max(markStart, markEnd))}</p>}
          <Button size="sm" icon={<Contrast size={13} />} disabled={disabled} onClick={applyRangeEdit}>Apply to range</Button>
          {(candidate.range_edits?.length ?? 0) > 0 && setCompareOriginal &&
            <CheckRowLike checked={!!compareOriginal} onChange={setCompareOriginal} label="Compare original" description="Preview the footage without these effects; the bake always includes them." />}
          {(candidate.range_edits ?? []).map((edit, i) => <div key={edit.id} className="editor-overlay-card">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-subtle">#{i + 1} · {RANGE_EFFECTS.find((r) => r.id === edit.kind)?.label} · {Math.round(edit.intensity * 100)}% · {formatTimecode(edit.start_ms)}–{formatTimecode(edit.end_ms)}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove effect ${i + 1}`} disabled={disabled}
                onClick={() => change({ range_edits: (candidate.range_edits ?? []).filter((e) => e.id !== edit.id) })} />
            </div>
          </div>)}
        </div>}
      {tool === 'cleanup' && <div className="space-y-2">
        <div className="space-y-2 border-b border-white/10 pb-2">
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="Remove filler words" checked={!!cleanup?.fillersOn} disabled={disabled}
              onChange={(e) => onCleanupToggle?.('fillers', e.target.checked)} />Remove fillers</label>
            <span className="text-2xs text-ink-subtle">{cleanup?.fillers ?? 0} found</span>
          </div>
          {!!cleanup?.fillersOn && <p className="text-2xs text-ink-subtle">Flagged words glow amber in the transcript. Click one to keep it.</p>}
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" aria-label="Remove pauses" checked={!!cleanup?.pausesOn} disabled={disabled}
              onChange={(e) => onCleanupToggle?.('pauses', e.target.checked)} />Remove pauses</label>
            <span className="text-2xs text-ink-subtle">{cleanup?.pauses ?? 0} found</span>
          </div>
          {!!cleanup?.pausesOn && <label className="editor-label">Silence threshold <span className="float-right">{((cleanup?.thresholdMs ?? 500) / 1000).toFixed(1)}s</span>
            <input aria-label="Pause silence threshold" type="range" min={300} max={2000} step={100} value={cleanup?.thresholdMs ?? 500} disabled={disabled}
              onChange={(e) => onCleanupThreshold?.(Number(e.target.value))} /></label>}
          {!!cleanup?.chips?.length && <div className="editor-motion-refs">
            {cleanup.chips.map((chip) => <span key={chip.key} className="editor-motion-ref">
              <span className="editor-motion-ref-name">{chip.label}</span>
              <button type="button" aria-label={`Keep ${chip.label}`} disabled={disabled} onClick={() => onCleanupSkip?.(chip.key)}>×</button>
            </span>)}
          </div>}
          {!!cleanup && <Button size="sm" icon={<Eraser size={13} />} disabled={disabled || (!cleanup.fillers && !cleanup.pauses)}
            onClick={() => onApplyCleanup?.()}>Apply cleanup{cleanup.savedMs > 0 ? ` · ~${(cleanup.savedMs / 1000).toFixed(1)}s shorter` : ''}</Button>}
        </div>
        <p className="text-2xs text-ink-subtle">Bad takes — retakes, restarts, repeated phrases, self-corrections. Flagged lines glow amber in the transcript; cutting is always reversible.</p>
        <Button size="sm" icon={badTakesBusy ? <Loader2 size={13} className="animate-spin" /> : <Eraser size={13} />} disabled={!!badTakesBusy || disabled}
          onClick={() => onDetectTakes?.()}>{badTakes ? 'Detect again' : 'Detect bad takes'}</Button>
        {(badTakes ?? []).map((take, i) => <div key={`${take.start}-${take.end}`} className="editor-overlay-card editor-take-card">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-ink-subtle">{formatTimecode(project.transcript[take.start]?.start_ms ?? 0)}–{formatTimecode(project.transcript[take.end]?.end_ms ?? 0)}</span>
            <span className="flex gap-1">
              <Button size="sm" disabled={disabled} onClick={() => onRemoveTake?.(i)}>Cut</Button>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onKeepTake?.(i)}>Keep</Button>
            </span>
          </div>
          <p className="text-xs">{take.reason}</p>
        </div>)}
        {badTakes && !badTakes.length && <p className="text-2xs text-ink-subtle">No bad takes found — the speech is clean.</p>}
        {!!badTakes?.length && <Button size="sm" disabled={disabled} onClick={() => onRemoveAllTakes?.()}>Remove all</Button>}
      </div>}
      {tool === 'censor' && (() => {
        const censor = candidate.censor
        const stems = censor?.words ?? []
        const setCensor = (patch: Partial<NonNullable<CandidateEdit['censor']>>): void =>
          change({ censor: { words: stems, captions: 'asterisk', audio: 'mute', ...censor, ...patch } })
        const addCensorWord = (): void => {
          const word = censorDraft.trim().toLowerCase()
          if (!word || disabled) return
          setCensorDraft('')
          setCensor({ words: [...new Set([...stems, word])] })
        }
        const hits = censorTokens(project, stems)
        const captionsOptions = [
          { value: 'asterisk', label: 'Asterisks — f***' },
          { value: 'first', label: 'Keep first letter — f***' },
          ...(censor?.audio !== 'off' ? [{ value: 'off', label: 'Off — plain text' }] : [])
        ]
        const audioOptions = [
          { value: 'mute', label: 'Mute the word' },
          { value: 'bleep', label: 'Bleep tone' },
          ...(censor?.captions !== 'off' ? [{ value: 'off', label: 'Off — keep audio' }] : [])
        ]
        return <div className="space-y-3">
          <p className="text-2xs text-ink-subtle">Mask sensitive words in captions and mute or bleep them in the audio. Detection runs locally on your transcript; censored words glow red there.</p>
          <div className="flex items-center gap-2">
            <Button size="sm" icon={<ShieldOff size={13} />} disabled={disabled}
              onClick={() => {
                const tokens = transcriptTokens(project)
                const present = builtinCensorWords.filter((stem) => tokens.some((t) => censorWordHit(t, [stem])))
                const custom = stems.filter((w) => !builtinCensorWords.includes(w))
                const words = [...new Set([...present, ...custom])]
                if (!words.length) { setNotice('No sensitive words found in this clip. Add your own below.'); return }
                setCensor({ words })
              }}>Auto-detect</Button>
            <span className="text-2xs text-ink-subtle">{hits.length ? `${hits.length} match${hits.length === 1 ? '' : 'es'} in this clip` : 'Nothing censored yet'}</span>
          </div>
          {!!stems.length && <div className="editor-motion-refs">
            {stems.map((word) => <span key={word} className="editor-motion-ref">
              <span className="editor-motion-ref-name">{word}</span>
              <button type="button" aria-label={`Stop censoring ${word}`} disabled={disabled}
                onClick={() => { const rest = stems.filter((w) => w !== word); change(rest.length ? { censor: { ...censor!, words: rest } } : { censor: undefined }) }}>×</button>
            </span>)}
          </div>}
          <div className="flex gap-1.5">
            <input className="editor-input flex-1" placeholder="Add a word…" aria-label="Custom censor word" value={censorDraft} disabled={disabled}
              onChange={(e) => setCensorDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCensorWord() } }} />
            <Button size="sm" variant="ghost" disabled={disabled || !censorDraft.trim()} onClick={addCensorWord}>Add</Button>
          </div>
          {!!stems.length && <>
            <label className="editor-label">Captions
              <Select size="sm" aria-label="Caption censor style" value={censor!.captions} disabled={disabled}
                options={captionsOptions} onChange={(value) => setCensor({ captions: value as 'asterisk' | 'first' | 'off' })} />
            </label>
            <label className="editor-label">Audio
              <Select size="sm" aria-label="Audio censor style" value={censor!.audio} disabled={disabled}
                options={audioOptions} onChange={(value) => setCensor({ audio: value as 'mute' | 'bleep' | 'off' })} />
            </label>
            <p className="text-2xs text-ink-subtle">Only the speech is muted — music and the rest of the mix keep playing. Applies to the baked export.</p>
          </>}
        </div>
      })()}
            {tool === 'voice' && <div className="space-y-2">
        <p className="text-2xs text-ink-subtle">Shape a narrated voiceover locally — script, installed Windows voice, pacing and pronunciations. Sample a voice, preview, and it bakes into the export; drag the Voice block on the timeline to reposition it.</p>
        <label className="editor-label">Script <span className="float-right">{voScript.trim().length}/5000</span>
          <textarea rows={6} maxLength={5000} value={voScript} disabled={disabled || voBusy} aria-label="Voiceover script"
            placeholder="Write or paste the voiceover script…"
            onChange={(e) => setVoScript(e.target.value)} /></label>
        <Select size="sm" aria-label="Voice actor" value={voVoice} disabled={voBusy}
          options={[{ value: '', label: voVoices?.length ? 'System default voice' : 'Loading voices…' },
            ...(voVoices ?? []).map((name) => ({ value: name, label: name }))]}
          onChange={setVoVoice} />
        <label className="editor-label">Speed <span className="float-right">{voRate.toFixed(1)}×</span>
          <input aria-label="Voiceover speed" type="range" min={0.5} max={2} step={0.1} value={voRate} disabled={voBusy}
            onChange={(e) => setVoRate(Number(e.target.value))} /></label>
        <div className="space-y-1">
          <p className="text-2xs text-ink-subtle">Pronunciations — how a word is said, spelled out</p>
          {voProns.map((pron, i) => <div key={i} className="flex gap-1 items-center">
            <input className="editor-audio-link" style={{ maxWidth: '38%' }} placeholder="Word" value={pron.word} maxLength={40} disabled={voBusy}
              aria-label={`Pronunciation ${i + 1} word`} onChange={(e) => setVoProns(voProns.map((p, j) => j === i ? { ...p, word: e.target.value } : p))} />
            <input className="editor-audio-link flex-1 min-w-0" placeholder="Say it like…" value={pron.say} maxLength={120} disabled={voBusy}
              aria-label={`Pronunciation ${i + 1} say-as`} onChange={(e) => setVoProns(voProns.map((p, j) => j === i ? { ...p, say: e.target.value } : p))} />
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove pronunciation ${i + 1}`} disabled={voBusy}
              onClick={() => setVoProns(voProns.filter((_, j) => j !== i))} />
          </div>)}
          <Button size="sm" variant="ghost" icon={<Plus size={12} />} disabled={voBusy || voProns.length >= 20}
            onClick={() => setVoProns([...voProns, { word: '', say: '' }])}>Add pronunciation</Button>
        </div>
        <Button size="sm" variant="ghost" disabled={voBusy} onClick={() => { void sampleVoice() }}>Sample this voice</Button>
        <Button size="sm" icon={voBusy ? <Loader2 size={13} className="animate-spin" /> : voPlaying ? <Square size={12} /> : <Play size={13} />}
          disabled={disabled || voBusy || voScript.trim().length < 10} onClick={() => { void previewVoiceover() }}>
          {voBusy ? 'Generating preview…' : voPlaying ? 'Playing… — click to stop' : 'Preview voiceover'}</Button>
        {candidate.voiceover?.audio_asset && <>
          <label className="editor-label">Voiceover level <span className="float-right">{Math.round((candidate.voiceover.gain ?? 1) * 100)}%</span>
            <input aria-label="Voiceover level" type="range" min={0} max={200} value={Math.round((candidate.voiceover.gain ?? 1) * 100)} disabled={disabled}
              onChange={(e) => change({ voiceover: { ...candidate.voiceover!, gain: Number(e.target.value) / 100 } })} /></label>
          <p className="text-2xs text-ink-subtle">Baked into the export at {formatTimecode(candidate.voiceover.start_ms ?? 0)} — drag the Voice block on the timeline to move it. The Clip volume slider (Music tab) sets the original audio's level against it.</p>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={disabled} onClick={() => { stopVoPreview(); change({ voiceover: undefined }) }}>Remove voiceover</Button>
        </>}
      </div>}
            {tool === 'music' && <div className="space-y-3">
        {candidate.music ? <div className="space-y-2">
          <p className="text-2xs text-ink-subtle">Track: {assetName(candidate.music.asset)}</p>
          <label className="editor-label">Music level<input aria-label="Music level" type="range" min={0} max={100} value={Math.round(candidate.music.gain * 100)} onChange={(e) => change({ music: { ...candidate.music!, gain: Number(e.target.value) / 100 } })} /></label>
          <label className="editor-label">Start at <span className="float-right">{formatTimecode(candidate.music.start_ms ?? 0)}</span>
            <input aria-label="Music start position" type="range" min={0} max={300000} step={1000} value={candidate.music.start_ms ?? 0} disabled={disabled}
              title="Where in the track the bed begins — it still loops for the whole clip"
              onChange={(e) => change({ music: { ...candidate.music!, start_ms: Number(e.target.value) || undefined } })} /></label>
          <label className="editor-label">Fade in <span className="float-right">{((candidate.music.fade_in_ms ?? 0) / 1000).toFixed(1)}s</span>
            <input aria-label="Music fade in" type="range" min={0} max={5000} step={100} value={candidate.music.fade_in_ms ?? 0} disabled={disabled}
              onChange={(e) => change({ music: { ...candidate.music!, fade_in_ms: Number(e.target.value) || undefined } })} /></label>
          <label className="editor-label">Fade out <span className="float-right">{((candidate.music.fade_out_ms ?? 0) / 1000).toFixed(1)}s</span>
            <input aria-label="Music fade out" type="range" min={0} max={5000} step={100} value={candidate.music.fade_out_ms ?? 0} disabled={disabled}
              onChange={(e) => change({ music: { ...candidate.music!, fade_out_ms: Number(e.target.value) || undefined } })} /></label>
          <label className="editor-label">Clip volume <span className="float-right">{((candidate.audio_gain ?? 1) * 100).toFixed(0)}%</span>
            <input aria-label="Clip volume" type="range" min={0} max={200} value={Math.round((candidate.audio_gain ?? 1) * 100)} onChange={(e) => change({ audio_gain: Number(e.target.value) / 100 })} /></label>
          <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} disabled={disabled} onClick={() => change({ music: undefined })}>Remove music</Button>
        </div>
        : <p className="text-2xs text-ink-subtle">Add a music bed under the speech. It loops to the clip length in the baked export.</p>}
        <div className="space-y-2 border-t border-white/10 pt-2">
          <p className="text-2xs text-ink-subtle">Speech enhancement — a louder, clearer voice with background noise toned down. Both are baked into the export.</p>
          <label className="editor-label">Noise reduction <span className="float-right">{Math.round((candidate.speech_denoise ?? 0) * 100)}%</span>
            <input aria-label="Noise reduction" type="range" min={0} max={100} value={Math.round((candidate.speech_denoise ?? 0) * 100)} disabled={disabled}
              onChange={(e) => change({ speech_denoise: Number(e.target.value) / 100 })} /></label>
          <label className="editor-label">Voice enhancement <span className="float-right">{Math.round((candidate.speech_enhance ?? 0) * 100)}%</span>
            <input aria-label="Voice enhancement" type="range" min={0} max={100} value={Math.round((candidate.speech_enhance ?? 0) * 100)} disabled={disabled}
              onChange={(e) => change({ speech_enhance: Number(e.target.value) / 100 })} /></label>
        </div>
        {audioBusy && <div className="space-y-1" role="status" aria-label="Audio import progress">
          <p className="text-2xs text-ink-subtle">Importing audio{audioPercent == null ? '…' : ` · ${audioPercent}%`}</p>
          <div className={cn('editor-audio-progress', audioPercent == null && 'indeterminate')}>{audioPercent != null && <div style={{ width: `${audioPercent}%` }} />}</div>
          <Button size="sm" variant="ghost" onClick={() => { void getApi().editor.cancel(outputDir) }}>Cancel import</Button>
        </div>}
        <Button size="sm" icon={<Upload size={13} />} disabled={disabled || audioBusy} onClick={() => setShowAudioAdd(true)}>Add audio</Button>
        <div className="editor-audio-library">
          <p className="text-2xs text-ink-subtle">Audio library · ready for any clip</p>
          {(audioTracks ?? []).length > 3 && <div className="flex items-center gap-1.5">
            <Search size={12} className="text-ink-subtle" aria-hidden="true" />
            <input className="editor-input flex-1" placeholder="Search the library…" aria-label="Search audio library" value={audioQuery}
              onChange={(e) => setAudioQuery(e.target.value)} />
          </div>}
          {(audioTracks ?? []).filter((track) => !audioQuery.trim() || track.title.toLowerCase().includes(audioQuery.trim().toLowerCase())).map((track) => <div key={track.id} className="editor-audio-track">
            <button className="editor-audio-track-apply" disabled={disabled || audioBusy} title={`Use “${track.title}” on this clip`} onClick={() => { void applyTrack(track) }}>
              <Music size={12} /><span className="editor-audio-title">{track.title}</span>
              {track.duration_ms > 0 && <span className="text-2xs text-ink-subtle">{formatTimecode(track.duration_ms)}</span>}
            </button>
            <Button size="sm" variant="ghost" iconOnly icon={previewId === track.id ? <Square size={12} /> : <Play size={12} />} disabled={!track.file}
              aria-label={previewId === track.id ? `Stop preview of ${track.title}` : `Preview ${track.title}`}
              title={track.file ? 'Preview' : 'Preview unavailable — the track file is missing'} onClick={() => togglePreview(track)} />
            <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={12} />} aria-label={`Remove ${track.title} from the library`} disabled={audioBusy}
              title="Removes it from the library. Clips already using it keep their copy." onClick={() => { void removeTrack(track) }} />
          </div>)}
          {audioTracks && !(audioTracks.some((track) => !audioQuery.trim() || track.title.toLowerCase().includes(audioQuery.trim().toLowerCase()))) && <p className="text-2xs text-ink-subtle">{audioQuery.trim() ? 'No tracks match that search.' : 'Imported tracks land here, ready to reuse.'}</p>}
        </div>
        {showAudioAdd && <div className="editor-audio-dialog" role="dialog" aria-modal="true" aria-label="Add audio">
          <div className="editor-audio-card">
            <div className="flex items-center justify-between mb-2"><strong className="text-xs">Add audio</strong>
              <Button size="sm" variant="ghost" iconOnly icon={<X size={13} />} aria-label="Close add audio" disabled={audioBusy} onClick={() => setShowAudioAdd(false)} /></div>
            <button type="button" className="editor-audio-drop" disabled={audioBusy} onClick={() => { void importAudio({ mode: 'file' }) }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (!file || audioBusy) return
                void (async () => { const path = await getApi().dialog.authorizeDrop(file)
                  if (path) void importAudio({ mode: 'file', path })
                  else setError('That is not a supported audio or video file.') })() }}>
              <Plus size={16} /><span>Click to upload or drop a file here</span>
              <span className="text-2xs text-ink-subtle">An audio or video file — we pull the audio out for you</span>
            </button>
            <p className="text-2xs text-ink-subtle mt-2">Extract audio from a video or audio link</p>
            <div className="flex gap-2">
              <input className="editor-audio-link" placeholder="Paste a video or audio link" value={audioLink} maxLength={2000} disabled={audioBusy}
                onChange={(e) => setAudioLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && audioLink.trim()) void importAudio({ mode: 'link', url: audioLink.trim() }) }} />
              <Button size="sm" disabled={audioBusy || !audioLink.trim()} onClick={() => { void importAudio({ mode: 'link', url: audioLink.trim() }) }}>Add audio</Button>
            </div>
            <p className="text-2xs text-ink-subtle mt-2">Only use audio you own or have permission to use.</p>
            <div className="flex justify-end mt-2"><Button size="sm" variant="ghost" disabled={audioBusy} onClick={() => setShowAudioAdd(false)}>Cancel</Button></div>
          </div>
        </div>}
      </div>}
    </div>}
    <nav className="editor-rail-buttons" aria-label="Tools">
      {tools.map((t) => <button key={t.id} className={cn('editor-rail-button', tool === t.id && 'selected')} aria-pressed={tool === t.id}
        onClick={() => setTool((current) => current === t.id ? null : t.id)}>
        {t.icon}<span>{t.label}</span>
      </button>)}
    </nav>
  </aside>
}

function CheckRowLike({ checked, onChange, label, description }: { checked: boolean; onChange: (value: boolean) => void; label: string; description?: string }): React.JSX.Element {
  return <label className="flex items-start gap-2 text-xs text-ink">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span className="min-w-0"><span>{label}</span>{description && <span className="block text-2xs text-ink-subtle">{description}</span>}</span>
  </label>
}
