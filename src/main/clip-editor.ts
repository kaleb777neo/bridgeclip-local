import { execFile, spawn, type ChildProcess } from 'child_process'
import { constants, closeSync, createReadStream, createWriteStream, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from 'fs'
import { pipeline } from 'stream/promises'
import { delimiter, dirname, extname, join, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { EDITOR_NEEDS_SOURCE, EDITOR_REVISION_CONFLICT, editorFailureMessage, editorProgress, isEditorErrorCode, parseCandidateEdit, parseEditorProject, parseVoiceoverConfig, parseMotionPlan, parseSpeakerNames, previewWindow, renderEditKey, assetRefs, type AudioTrack, type CandidateEdit, type EditorBatch, type EditorErrorCode, type EditorProgress, type EditorProgressSummary, type EditorProject, type EditorSession } from '../shared/clip-editor'
import { addToAudioLibrary, audioTrackFile, getAudioTrack } from './audio-library'
import { loadSettings, getSettingsForBridge, vocabularyTerms } from './settings-store'
import { assertAbsolutePath, assertMediaPath, isWebUrl, isWithinDirectory, openAuthorizedMedia } from './security'
import { getJobOutput } from './file-manager'
import { getBridgeRunnerPath, getEnginePath, resolvePythonPath, runtimeEnvironment } from './pipeline-runner'
import { resolveBinary } from './tools'
import { logger } from './logger'

type WorkerAction = 'review' | 'export' | 'export-all' | 'scan-cameras' | 'auto-frame' | 'replace-source' | 'create-project' | 'build-preview' | 'import-audio' | 'motion-render' | 'voice-voices' | 'voice-preview'
interface EditorOperation { progress?: EditorSession['progress']; action: NonNullable<EditorSession['operation']>; child?: ChildProcess; cancelled?: boolean; abort?: AbortController; batch?: EditorBatch }
const operations = new Map<string, EditorOperation>()
export function editorBusy(path: string): boolean { return operations.has(realpathSync(path)) }
function runPath(path: unknown): string {
  assertAbsolutePath(path)
  const run = realpathSync(path as string), library = realpathSync(loadSettings().outputDirectory)
  if (dirname(run) !== library || lstatSync(path as string).isSymbolicLink()) throw new Error('Editor project is outside the library')
  return run
}
function readProject(run: string): ReturnType<typeof parseEditorProject> {
  const path = join(run, 'editor-project.json')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || !isWithinDirectory(path, run)) throw new Error('Invalid editor file')
    const data = Buffer.alloc(stat.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, data, used, data.length - used, null); used += count } while (count && used < data.length)
    if (used !== stat.size) throw new Error('Editor project changed while reading')
    return parseEditorProject(JSON.parse(data.subarray(0, used).toString('utf8')))
  } finally { closeSync(fd) }
}
function writeProject(run: string, project: EditorProject): void {
  const data = JSON.stringify(project)
  if (Buffer.byteLength(data) > 32 * 1024 * 1024) throw new Error('This editor project has too many caption edits to save')
  if (runPath(run) !== run) throw new Error('Editor folder changed')
  const temporary = join(run, `.editor-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, join(run, 'editor-project.json'))
  } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
}
function mediaNames(project: EditorProject): { source: string; preview: string } {
  const suffix = project.source_id ? `-${project.source_id}` : ''
  return { source: `editor-source${suffix}.mp4`, preview: `editor-preview${project.preview_id ? `-${project.preview_id}` : suffix}.mp4` }
}

const EDITOR_MEDIA = /^editor-(?:source|preview)(?:-[a-f0-9]{32})?\.mp4(?:\.partial\.mp4)?$|^editor-asset-[a-f0-9]{32}\.[a-z0-9]{2,4}$/
const assetName = (ref: string): string => `editor-asset-${ref}`
/** Referenced assets survive the sweep; unreferenced uploads (removed overlays) do not. */
function referencedMedia(project: EditorProject): Set<string> {
  return new Set([...(project.media_freed ? [] : Object.values(mediaNames(project))), ...assetRefs(project).map(assetName)])
}
/**
 * Remove leftovers of killed or cancelled operations: `.editor-*` temp files and
 * folders, and editor media the project does not reference. Runs only while no
 * editor operation owns the run, so nothing here can be in use by a worker.
 */
function sweepEditorFiles(run: string, project?: EditorProject): void {
  if (operations.has(run)) return
  let keep: Set<string> | null = null
  try {
    project ??= readProject(run)
    keep = referencedMedia(project)
  } catch { /* Unreadable state: keep all media, still remove temporary entries. */ }
  let entries: Dirent[]
  try { entries = readdirSync(run, { withFileTypes: true }) } catch { return }
  let removed = 0
  for (const entry of entries) {
    const temporary = entry.name.startsWith('.editor-')
    if (!temporary && !(keep && EDITOR_MEDIA.test(entry.name) && !keep.has(entry.name) && (entry.isFile() || entry.isSymbolicLink()))) continue
    try { rmSync(join(run, entry.name), { recursive: temporary && entry.isDirectory(), force: true }); removed++ } catch { /* A playing preview can stay open on Windows; retry next time. */ }
  }
  if (removed) logger.info('editor.sweep', { removed })
}

function mediaSize(paths: string[]): number {
  return paths.reduce((total, file) => { try { return total + statSync(file).size } catch { return total } }, 0)
}
function assetPaths(run: string, project: EditorProject): Record<string, string> {
  const paths: Record<string, string> = {}
  for (const ref of assetRefs(project)) {
    const file = join(run, assetName(ref))
    try { if (!lstatSync(file).isSymbolicLink() && isWithinDirectory(file, run)) paths[ref] = file } catch { /* A missing asset surfaces as a bake error. */ }
  }
  return paths
}
export async function openEditor(path: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (!(await getJobOutput(run, loadSettings().outputDirectory))?.editor_project) throw new Error('This run has no editor project')
  const project = readProject(run), names = mediaNames(project)
  sweepEditorFiles(run, project)
  const operation = operations.get(run)
  const state = { progress: operation?.progress ? { ...operation.progress } : undefined, operation: operation?.action ?? null, batch: operation?.batch ? { ...operation.batch } : undefined }
  if (project.media_freed) return { project, sourcePath: '', previewPath: '', mediaBytes: 0, assetPaths: assetPaths(run, project), ...state }
  const sourcePath = join(run, names.source), previewPath = join(run, names.preview)
  for (const file of [sourcePath, previewPath]) {
    if (lstatSync(file).isSymbolicLink() || !isWithinDirectory(file, run)) throw new Error('Editor source is missing')
    assertMediaPath(file, loadSettings().outputDirectory)
  }
  return { project, sourcePath, previewPath, mediaBytes: mediaSize([sourcePath, previewPath]), assetPaths: assetPaths(run, project), ...state }
}

/**
 * Audio envelope for the timeline waveform: ffmpeg decodes the project media to mono 8 kHz PCM and
 * the result collapses to normalized peaks in fixed time buckets, cached in editor-peaks.json
 * against the media's name, size and mtime so a replaced source regenerates it.
 */
const waveformTasks = new Map<string, Promise<number[]>>()
export function editorWaveform(path: unknown): Promise<number[]> {
  const run = runPath(path)
  const pending = waveformTasks.get(run)
  if (pending) return pending
  const task = buildWaveform(run).finally(() => waveformTasks.delete(run))
  waveformTasks.set(run, task)
  return task
}
async function buildWaveform(run: string): Promise<number[]> {
  const project = readProject(run), names = mediaNames(project)
  let file = ''
  // A fast per-reel import's preview covers only a window; its audio would
  // stretch over the whole timeline, so peaks come from the full source.
  for (const name of previewWindow(project) ? [names.source] : [names.preview, names.source]) {
    const candidate = join(run, name)
    try { if (!lstatSync(candidate).isSymbolicLink() && isWithinDirectory(candidate, run)) { file = candidate; break } } catch { /* Try the other media. */ }
  }
  if (!file) throw new Error('Editor media is unavailable')
  const media = statSync(file)
  const id = `${basename(file)}:${media.size}:${Math.round(media.mtimeMs)}`
  const cache = join(run, 'editor-peaks.json')
  try {
    const fd = openSync(cache, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (st.isFile() && st.size <= 4 * 1024 * 1024 && isWithinDirectory(cache, run)) {
        const buffer = Buffer.alloc(st.size)
        if (readSync(fd, buffer, 0, st.size, 0) === st.size) {
          const parsed = JSON.parse(buffer.toString('utf8'))
          if (parsed?.media === id && Array.isArray(parsed.peaks) && parsed.peaks.length <= 20000 &&
            parsed.peaks.every((p: unknown) => typeof p === 'number' && p >= 0 && p <= 1)) return parsed.peaks
        }
      }
    } finally { closeSync(fd) }
  } catch { /* A missing or corrupt cache is regenerated below. */ }
  const peaks = await decodePeaks(file, Math.max(10, Math.ceil(project.duration_ms / 16000)))
  const temporary = join(run, `.editor-peaks-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify({ media: id, peaks }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, cache)
  } finally { try { unlinkSync(temporary) } catch { /* Already committed. */ } }
  return peaks
}
function decodePeaks(file: string, bucketMs: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary('ffmpeg'), ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true })
    const timer = setTimeout(() => { child.kill(); reject(new Error('Waveform generation timed out')) }, 3 * 60 * 1000)
    const samplesPerBucket = bucketMs * 8
    const result: number[] = []
    let leftover: Buffer | null = null, filled = 0, peak = 0, max = 0, bytes = 0, failed = ''
    child.stdout.on('data', (chunk: Buffer) => {
      let data = leftover && leftover.length ? Buffer.concat([leftover, chunk]) : chunk
      if (data.length % 2) { leftover = data.subarray(data.length - 1); data = data.subarray(0, data.length - 1) } else leftover = null
      bytes += data.length
      for (let offset = 0; offset + 2 <= data.length; offset += 2) {
        const sample = Math.abs(data.readInt16LE(offset))
        if (sample > peak) peak = sample
        if (++filled === samplesPerBucket) { result.push(peak); if (peak > max) max = peak; filled = 0; peak = 0 }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { if (failed.length < 2000) failed += chunk.toString('utf8') })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Silence or no audio track: keep the partial bucket if any, normalize what we have.
      if (code !== 0 && bytes === 0) { if (/does not have any stream/i.test(failed)) resolve([]); else reject(new Error('Could not read the audio for the waveform')); return }
      if (code !== 0 && !/does not have any stream/i.test(failed)) { reject(new Error('Could not read the audio for the waveform')); return }
      if (filled) { result.push(peak); if (peak > max) max = peak }
      resolve(max ? result.map((p) => p / max) : result.map(() => 0))
    })
  })
}

type ProgressCounts = Omit<EditorProgressSummary, 'operation' | 'batch' | 'progress'>
const progressCache = new Map<string, { mtimeMs: number; size: number; ino: number; summary: ProgressCounts }>()
/**
 * Status counts for Library cards, Jobs rows and editor polling. Unlike
 * openEditor, it sends no project to the renderer and re-reads the project
 * only when its file changes.
 */
export async function readEditorProgress(path: unknown): Promise<EditorProgressSummary> {
  const run = runPath(path)
  const stat = lstatSync(join(run, 'editor-project.json'))
  if (!stat.isFile()) throw new Error('This run has no editor project')
  let summary = progressCache.get(run)
  if (!summary || summary.mtimeMs !== stat.mtimeMs || summary.size !== stat.size || summary.ino !== stat.ino) {
    const project = readProject(run)
    const { remaining, initialCandidate } = editorProgress(project.candidates)
    const counts = { refining: 0, ready: 0, baked: 0, discarded: 0 }
    for (const c of project.candidates) counts[c.status]++
    let previewPath: string | null = project.media_freed ? null : join(run, mediaNames(project).preview)
    try { if (previewPath && (lstatSync(previewPath).isSymbolicLink() || !isWithinDirectory(previewPath, run))) previewPath = null } catch { previewPath = null }
    summary = { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, summary: {
      total: project.candidates.length, remaining, initialCandidate, counts, previewPath,
      thumbnailMs: project.candidates[initialCandidate].ranges[0][0], mediaFreed: project.media_freed === true,
      previewStartMs: project.preview_start_ms ?? 0, previewEndMs: project.preview_end_ms ?? project.duration_ms } }
    progressCache.delete(run)
    progressCache.set(run, summary)
    if (progressCache.size > 1000) progressCache.delete(progressCache.keys().next().value!)
  }
  const operation = operations.get(run)
  return { ...summary.summary, counts: { ...summary.summary.counts }, operation: operation?.action ?? null,
    ...(operation?.batch ? { batch: { ...operation.batch } } : {}), ...(operation?.progress ? { progress: { ...operation.progress } } : {}) }
}

/**
 * Live worker state without requiring an editor project: the import waiting
 * screen polls this while createEditorProject is still downloading, before
 * editor-project.json exists (editor:progress would reject until it does).
 */
export function editorOperationProgress(path: unknown): Pick<EditorProgressSummary, 'operation' | 'batch' | 'progress'> {
  const operation = operations.get(runPath(path))
  return { operation: operation?.action ?? null,
    ...(operation?.batch ? { batch: { ...operation.batch } } : {}),
    ...(operation?.progress ? { progress: { ...operation.progress } } : {}) }
}

const bakedHash = (c: CandidateEdit): string => createHash('sha256').update(renderEditKey(c)).digest('hex')
export async function saveEditor(path: unknown, revision: unknown, edits: unknown, speakerNames?: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    if (!Array.isArray(edits) || edits.length !== project.candidates.length) throw new Error('Invalid candidate edits')
    if (speakerNames !== undefined) project.speaker_names = parseSpeakerNames(speakerNames)
    const clean = edits.map((c) => parseCandidateEdit(c, project.duration_ms, project.transcript.length))
    if (new Set(clean.map((c) => c.id)).size !== clean.length) throw new Error('Duplicate candidates')
    project.candidates = project.candidates.map((c) => {
      const edit = clean.find((e) => e.id === c.id)
      if (!edit) throw new Error('Candidate is missing')
      const next = { ...c, ...edit }
      if (edit.status === 'baked') {
        // Unchanged since its render, or restored to the exact render "Refine again" left.
        const unchanged = c.status === 'baked' ? renderEditKey(edit) === renderEditKey(c) : !!c.baked_hash && c.exports.length > 0 && bakedHash(edit) === c.baked_hash
        if (!unchanged) throw new Error('Only a completed render can mark a clip as baked')
        delete next.baked_hash
      } else if (c.status === 'baked') next.baked_hash = bakedHash(c)
      return next
    })
    project.revision++
    writeProject(run, project)
  } finally { operations.delete(run) }
  return openEditor(run)
}
/** Delete the source and preview once every clip is baked or discarded. The project becomes read-only. */
export async function freeEditorMedia(path: unknown, revision: unknown): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  operations.set(run, { action: 'save' })
  try {
    const { project } = await openEditor(run)
    if (!Number.isSafeInteger(revision) || project.revision !== revision) throw new Error(EDITOR_REVISION_CONFLICT)
    if (editorProgress(project.candidates).remaining) throw new Error('Bake or discard every clip before freeing editor media.')
    if (!project.media_freed) {
      project.media_freed = true
      project.revision++
      writeProject(run, project)
    }
  } finally { operations.delete(run) }
  sweepEditorFiles(run)
  logger.info('editor.mediaFreed')
  return openEditor(run)
}
/** Editor media kinds: the extensions and size caps addEditorAsset enforces. */
export const assetKinds: Record<string, { exts: string[]; maxBytes: number }> = {
  image: { exts: ['png', 'jpg', 'jpeg', 'webp'], maxBytes: 15 * 1024 * 1024 },
  video: { exts: ['mp4', 'm4v', 'mov', 'mkv', 'webm'], maxBytes: 250 * 1024 * 1024 },
  audio: { exts: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], maxBytes: 40 * 1024 * 1024 }
}
/** Copy a user-picked file into the run folder as an editor asset; returns its reference. */
export async function addEditorAsset(path: unknown, kind: unknown, sourcePath: unknown): Promise<{ asset: string; name: string }> {
  const run = runPath(path)
  const spec = assetKinds[String(kind)]
  if (!spec) throw new Error('Invalid asset kind')
  assertAbsolutePath(sourcePath)
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  const { handle, size, canonical } = await openAuthorizedMedia(sourcePath as string, loadSettings().outputDirectory)
  try {
    const ext = extname(canonical).slice(1).toLowerCase()
    if (!spec.exts.includes(ext)) throw new Error(`That file type can't be used here. Choose a ${spec.exts.join(', ')} file.`)
    if (size > spec.maxBytes) throw new Error('That file is too large for the editor.')
    const asset = `${randomUUID().replaceAll('-', '')}.${ext}`
    operations.set(run, { action: 'save' })
    try {
      await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(join(run, assetName(asset)), { flags: 'wx', mode: 0o600 }))
    } finally { operations.delete(run) }
    return { asset, name: basename(canonical) }
  } finally { await handle.close() }
}

/** A track import: a picked or dropped file (any audio/video container) or a link the engine downloads. */
export interface AudioImportResult { asset: string; name: string; durationMs: number; track: AudioTrack }
const AUDIO_IMPORT_EXTS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'm4v', 'mov', 'webm'])
const AUDIO_IMPORT_MAX_BYTES = 250 * 1024 * 1024

/**
 * Import a music track from a file or link: the engine extracts it to an m4a editor
 * asset inside the run, and main mirrors that file into the cross-project audio
 * library. The renderer then sets the clip's music to the returned asset reference.
 */
export async function importEditorAudio(path: unknown, source: { kind: 'file'; path: string } | { kind: 'link'; url: string }): Promise<AudioImportResult> {
  const run = runPath(path), settings = loadSettings()
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'import-audio', progress: { phase: 'audio', percent: 0 } }
  operations.set(run, operation)
  let staged: string | null = null
  try {
    let requestSource: Record<string, unknown>, fallbackTitle: string
    if (source.kind === 'link') {
      if (!isWebUrl(source.url) || source.url.length > 2048) throw new Error('Paste a valid audio or video link')
      requestSource = { kind: 'url', url: source.url }
      fallbackTitle = 'Imported audio'
    } else {
      const media = await openAuthorizedMedia(source.path, settings.outputDirectory)
      try {
        const ext = extname(media.canonical).slice(1).toLowerCase()
        if (!AUDIO_IMPORT_EXTS.has(ext)) throw new Error('Choose an audio or video file to extract the audio from')
        if (media.size > AUDIO_IMPORT_MAX_BYTES) throw new Error('That file is too large to import audio from.')
        // The engine only reads inside the run folder, so the pick is staged there first.
        staged = `editor-asset-${randomUUID().replaceAll('-', '')}.${ext}`
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(join(run, staged), { flags: 'wx', mode: 0o600 }))
      } finally { await media.handle.close() }
      requestSource = { kind: 'file', name: staged }
      fallbackTitle = basename(media.canonical).replace(/\.[^.]+$/, '') || 'Imported audio'
    }
    if (operation.cancelled) throw new Error(editorFailureMessage('import-audio', 'cancelled'))
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: getEnginePath(), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    const python = resolvePythonPath(getEnginePath(), settings.pythonPath)
    // Small next to source imports, yet a slow link still gets generous room.
    const result = await runWorker(run, operation, 'import-audio', env, python, 35 * 60 * 1000,
      { run, library: realpathSync(settings.outputDirectory), action: 'import-audio', source: requestSource, title: fallbackTitle })
    const asset = typeof result?.asset === 'string' && /^[a-f0-9]{32}\.m4a$/.test(result.asset) ? result.asset : null
    if (!asset) throw new Error('The audio import produced no usable track. Try a different file or link.')
    const title = typeof result?.title === 'string' && result.title.trim() ? result.title.trim().slice(0, 200) : fallbackTitle.slice(0, 200)
    const durationMs = typeof result?.duration_ms === 'number' && Number.isFinite(result.duration_ms)
      ? Math.max(0, Math.min(6 * 3600 * 1000, Math.round(result.duration_ms))) : 0
    // No sweep in the finally: the produced asset is referenced only once the
    // renderer applies it; the sweep that follows that save keeps it.
    const track = addToAudioLibrary(join(run, `editor-asset-${asset}`), title, durationMs, source.kind === 'link' ? 'link' : 'file')
    return { asset, name: track.title, durationMs: track.duration_ms, track }
  } finally {
    operations.delete(run)
    if (staged) { try { unlinkSync(join(run, staged)) } catch { /* The sweep removes strays later. */ } }
  }
}

/** Copy a library track into the project like a fresh upload, ready for candidate.music. */
export async function attachEditorAudio(path: unknown, trackId: unknown): Promise<{ asset: string; name: string }> {
  const run = runPath(path)
  const track = getAudioTrack(trackId)
  const file = track ? audioTrackFile(track.id) : null
  if (!track || !file) throw new Error('That audio track is no longer in the library.')
  if (operations.has(run)) throw new Error('Wait for the current editor operation to finish')
  const asset = `${randomUUID().replaceAll('-', '')}.m4a`
  operations.set(run, { action: 'save' })
  try {
    await pipeline(createReadStream(file), createWriteStream(join(run, assetName(asset)), { flags: 'wx', mode: 0o600 }))
    return { asset, name: track.title }
  } finally { operations.delete(run) }
}

/** The installed Windows voices for the Voiceover Studio's actor picker. */
export async function listEditorVoices(path: unknown): Promise<string[]> {
  const run = runPath(path), settings = loadSettings()
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'voice-voices' }
  operations.set(run, operation)
  try {
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: getEnginePath(), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    const python = resolvePythonPath(getEnginePath(), settings.pythonPath)
    const result = await runWorker(run, operation, 'voice-voices', env, python, 2 * 60 * 1000,
      { run, library: realpathSync(settings.outputDirectory), action: 'voice-voices' })
    return Array.isArray(result?.voices) ? result.voices.filter((voice): voice is string => typeof voice === 'string').slice(0, 40) : []
  } finally { operations.delete(run) }
}

/** Generate a scratch voiceover preview (Windows SAPI) and keep it as a run asset. */
export async function previewEditorVoiceover(path: unknown, config: unknown): Promise<{ asset: string; durationMs: number }> {
  const run = runPath(path), settings = loadSettings()
  const voiceover = parseVoiceoverConfig(config)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'voice-preview', progress: { phase: 'motion', percent: 0 } }
  operations.set(run, operation)
  try {
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: getEnginePath(), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    const python = resolvePythonPath(getEnginePath(), settings.pythonPath)
    const result = await runWorker(run, operation, 'voice-preview', env, python, 5 * 60 * 1000,
      { run, library: realpathSync(settings.outputDirectory), action: 'voice-preview', script: voiceover.script,
        voice: voiceover.voice, rate: voiceover.rate, pronunciations: voiceover.pronunciations })
    const asset = typeof result?.asset === 'string' && /^[a-f0-9]{32}\.wav$/.test(result.asset) ? result.asset : null
    if (!asset) throw new Error('The voice preview produced no audio. Try again.')
    const durationMs = typeof result?.duration_ms === 'number' && Number.isFinite(result.duration_ms) ? Math.max(100, Math.round(result.duration_ms)) : 0
    // No sweep in the finally: the studio references the audio until it is regenerated or removed.
    return { asset, durationMs }
  } finally { operations.delete(run) }
}

/** Render a Motion Studio shot plan into the run as a new video asset (the local ffmpeg generator). */
export async function renderMotionClip(path: unknown, plan: unknown, audioAsset?: unknown): Promise<{ asset: string; durationMs: number }> {
  const run = runPath(path), settings = loadSettings()
  // Structure is validated here; the engine re-validates everything and every
  // referenced file against the run folder, which main never saw.
  const shots = (plan as { shots?: unknown } | null)?.shots
  const references = Array.isArray(shots)
    ? shots.flatMap((s) => (s && typeof s === 'object' && typeof (s as { asset?: unknown }).asset === 'string'
        ? [{ asset: (s as { asset: string }).asset, kind: (s as { kind?: unknown }).kind === 'video' ? 'video' as const : 'image' as const }] : []))
    : []
  let motion: ReturnType<typeof parseMotionPlan>
  try {
    motion = parseMotionPlan(plan, references)
  } catch {
    throw new Error('The shot plan is invalid: 1 to 8 shots, each 0.5 to 8 seconds, at most 20 seconds total.')
  }
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'motion-render', progress: { phase: 'motion', percent: 0 } }
  operations.set(run, operation)
  try {
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: getEnginePath(), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    const python = resolvePythonPath(getEnginePath(), settings.pythonPath)
    const result = await runWorker(run, operation, 'motion-render', env, python,
      30 * 60 * 1000 + 3 * motion.shots.reduce((total, s) => total + s.duration_ms, 0),
      { run, library: realpathSync(settings.outputDirectory), action: 'motion-render', plan: motion,
        ...(typeof audioAsset === 'string' && /^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test(audioAsset) ? { audio_asset: audioAsset } : {}) })
    const asset = typeof result?.asset === 'string' && /^[a-f0-9]{32}\.mp4$/.test(result.asset) ? result.asset : null
    if (!asset) throw new Error('The motion clip render produced no file. Try again.')
    const durationMs = typeof result?.duration_ms === 'number' && Number.isFinite(result.duration_ms) && result.duration_ms > 0
      ? Math.round(result.duration_ms) : motion.shots.reduce((total, s) => total + s.duration_ms, 0)
    // No sweep in the finally: the clip becomes a referenced b-roll once the renderer applies it.
    return { asset, durationMs }
  } finally { operations.delete(run) }
}

function stop(child?: ChildProcess, force = false): void {
  if (!child?.pid) return
  try { if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => {}); else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch { /* Already exited. */ }
}
export function stopEditorsForQuit(): void { for (const op of operations.values()) { op.abort?.abort(); stop(op.child, true) } }
export function cancelEditor(path: unknown): void {
  const operation = operations.get(runPath(path))
  if (operation) operation.cancelled = true
  operation?.abort?.abort()
  const child = operation?.child
  stop(child)
  if (child) { const timer = setTimeout(() => stop(child, true), 3000); timer.unref(); child.once('close', () => clearTimeout(timer)) }
}
export async function replaceEditorSource(path: unknown, revision: unknown, replacement: unknown): Promise<EditorSession> {
  assertAbsolutePath(replacement)
  return executeEditor(path, revision, undefined, 'replace-source', replacement)
}
export async function runEditor(path: unknown, revision: unknown, candidateId: unknown, action: unknown, subject?: unknown): Promise<EditorSession> {
  if (action !== 'review' && action !== 'export' && action !== 'export-all' && action !== 'scan-cameras' && action !== 'auto-frame' && action !== 'build-preview') throw new Error('Invalid editor operation')
  let hint: Record<string, unknown> | undefined
  if (action === 'auto-frame' && subject !== undefined) {
    if (typeof subject !== 'object' || subject === null) throw new Error('Invalid subject selection')
    const s = subject as { atMs?: unknown; x?: unknown; y?: unknown }
    if (typeof s.atMs !== 'number' || !Number.isSafeInteger(s.atMs) || s.atMs < 0 ||
        typeof s.x !== 'number' || !Number.isFinite(s.x) || s.x < 0 || s.x > 1 ||
        typeof s.y !== 'number' || !Number.isFinite(s.y) || s.y < 0 || s.y > 1) throw new Error('Invalid subject selection')
    hint = { atMs: s.atMs, x: s.x, y: s.y }
  }
  return executeEditor(path, revision, candidateId, action, undefined, hint)
}

/**
 * Turn an automatic run's finished clips into an editable project by re-attaching its
 * source: re-download the stored URL, or stream the file the user picked. The editor
 * project and the editor_project flag are only committed once the whole import succeeds.
 * `focusClipIndex` (the reel's clip index) limits the preview to that reel's window, so
 * "Edit this" on one reel of a long show does not wait on a full-source transcode.
 */
export async function createEditorProject(path: unknown, mediaPath?: unknown, focusClipIndex?: unknown): Promise<EditorSession> {
  const run = runPath(path), settings = loadSettings()
  if (mediaPath !== undefined && mediaPath !== null) assertAbsolutePath(mediaPath)
  if (focusClipIndex !== undefined && focusClipIndex !== null &&
    !(typeof focusClipIndex === 'number' && Number.isSafeInteger(focusClipIndex) && focusClipIndex >= 0 && focusClipIndex <= 999)) throw new Error('Invalid clip for this edit')
  const output = await getJobOutput(run, settings.outputDirectory)
  if (!output) throw new Error('Could not read this run.')
  if (output.editor_project) throw new Error('This run already has an editor project')
  if (!output.clips.length) throw new Error('This run has no clips to edit')
  let source: { kind: 'url'; url: string } | { kind: 'file' }
  if (mediaPath !== undefined && mediaPath !== null) source = { kind: 'file' }
  else if (isWebUrl(output.source_video_url)) source = { kind: 'url', url: output.source_video_url }
  else throw new Error(EDITOR_NEEDS_SOURCE)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action: 'create-project', progress: { phase: 'scan', percent: 0 } }
  operations.set(run, operation)
  const target = join(run, 'editor-source.mp4')
  let wroteSource = false
  try {
    if (source.kind === 'file') {
      try { if (lstatSync(target).isSymbolicLink()) throw new Error('The editor source is not a regular file') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      rmSync(target, { force: true })
      const media = await openAuthorizedMedia(mediaPath as string, settings.outputDirectory)
      operation.abort = new AbortController()
      try {
        if (operation.cancelled) throw new Error('Import cancelled.')
        wroteSource = true
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
      } finally { await media.handle.close() }
    }
    const engine = getEnginePath()
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge(settings), PYTHONPATH: engine, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    // The Brand Vocabulary rides along so an import's transcript highlights
    // carry the user's proper nouns consistently across every project.
    env.BRIDGECLIP_KEYTERMS = JSON.stringify(vocabularyTerms(settings.customVocabulary).slice(0, 20))
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    const python = resolvePythonPath(engine, settings.pythonPath)
    // Long sources re-download over the network; give the import a generous bound.
    const request = { run, library: realpathSync(settings.outputDirectory), action: 'create-project', source,
      ...(focusClipIndex !== undefined && focusClipIndex !== null ? { focus_clip: focusClipIndex } : {}) }
    if (source.kind === 'url') {
      try { await runWorker(run, operation, 'create-project', env, python, 60 * 60 * 1000, request) }
      catch (error) {
        // A failed re-download falls back to picking the file, unless the user
        // cancelled, it timed out, or the engine itself could not start.
        const code = (error as { editorCode?: EditorErrorCode }).editorCode
        if (operation.cancelled || code === undefined || code === 'cancelled' || code === 'timeout' || code === 'engine_unavailable') throw error
        throw new Error(EDITOR_NEEDS_SOURCE)
      }
    } else {
      await runWorker(run, operation, 'create-project', env, python, 60 * 60 * 1000, request)
    }
    if (operation.cancelled) throw new Error(editorFailureMessage('create-project', 'cancelled'))
  } catch (error) {
    if (wroteSource) { try { rmSync(target, { force: true }) } catch { /* A locked preview can stay until the next sweep. */ } }
    throw error
  } finally {
    operations.delete(run)
    try { sweepEditorFiles(run) } catch { /* Cleanup is best effort. */ }
  }
  return openEditor(run)
}

/** Worker output can contain private paths and keys: log only a short, redacted tail. */
function safeTail(stderr: string): Record<string, string> {
  const lines = stderr.split(/\r?\n/).map((line) => line
    .replace(/^\d{4}-\d{2}-\d{2} [\d:,.]+ - [\w.]+ - [A-Z]+ - /, '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\b(?:sk|pk|rk)-[\w-]{8,}/g, '[key]')
    .replace(/\b(?:authorization|api[_ -]?key|token|password|secret|bearer)\b\S*\s*[:=]?\s*\S+/gi, '[redacted]')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]*/g, '[path]')
    .replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean).slice(-8)
  return Object.fromEntries(lines.map((line, i) => [`line${i + 1}`, line]))
}
/** Generous for long sources on CPU encoders, yet bounded if a worker hangs. */
const workerLimitMs = (durationMs: number): number => 30 * 60 * 1000 + 3 * durationMs

/** What a worker's final `ok` line may carry: import-audio also returns the new asset's reference and metadata. */
interface WorkerResult { ok: boolean; error?: unknown; asset?: unknown; title?: unknown; duration_ms?: unknown; voices?: unknown }

function runWorker(run: string, operation: EditorOperation, action: WorkerAction, env: Record<string, string | undefined>, python: string, limitMs: number, request: Record<string, unknown>): Promise<WorkerResult | undefined> {
  const engine = env.PYTHONPATH!
  return new Promise<WorkerResult | undefined>((resolve, reject) => {
    const child = spawn(python, [join(dirname(getBridgeRunnerPath()), 'editor_runner.py')],
      { cwd: engine, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true })
    operation.child = child
    let stdout = '', stderr = '', settled = false, protocolFailed = false, timedOut = false
    let result: WorkerResult | undefined
    const consume = (line: string): void => {
      if (!line.trim()) return
      if (line.length > 16384) { protocolFailed = true; stop(child); return }
      try {
        const value = JSON.parse(line)
        if (value?.type === 'progress') {
          if ((action === 'scan-cameras' || action === 'auto-frame' || action === 'create-project' || action === 'build-preview' || action === 'import-audio' || action === 'motion-render') &&
              (value.phase === 'scan' || value.phase === 'preview' || value.phase === 'audio' || value.phase === 'motion') &&
              typeof value.percent === 'number' && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100) {
            const previous = operation.progress
            if (!previous || (previous.phase === 'scan' && value.phase === 'preview') ||
                (previous.phase === value.phase && value.percent >= previous.percent)) {
              // Download-phase extras feed the import screen's bytes/rate readout.
              const bytes = (x: unknown): number | undefined => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
              const downloadedBytes = bytes(value.downloaded_bytes), totalBytes = bytes(value.total_bytes), bytesPerSecond = bytes(value.speed)
              operation.progress = { phase: value.phase, percent: Math.floor(value.percent),
                ...(downloadedBytes !== undefined ? { downloadedBytes } : {}),
                ...(totalBytes !== undefined ? { totalBytes } : {}),
                ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}) }
            }
          }
        } else if (typeof value?.ok === 'boolean' && !result) result = value
        else protocolFailed = true
      } catch { protocolFailed = true }
    }
    const timer = setTimeout(() => { timedOut = true; stop(child, true) }, limitMs)
    const finish = (error?: Error, payload?: WorkerResult): void => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(payload) }
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      let end: number
      while ((end = stdout.indexOf('\n')) >= 0) { consume(stdout.slice(0, end)); stdout = stdout.slice(end + 1) }
      if (stdout.length > 16384) { protocolFailed = true; stdout = ''; stop(child) }
    })
    // Keep a bounded tail for the log; it is redacted before it is written.
    child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8192) })
    child.on('error', (error) => {
      logger.error('editor.worker.spawnFailed', { action, errno: (error as NodeJS.ErrnoException).code ?? 'unknown' })
      finish(new Error('Could not start the editor engine. Open Settings and run System check.'))
    })
    child.on('close', (exitCode, signal) => {
      consume(stdout)
      if (exitCode === 0 && !protocolFailed && result?.ok === true) return finish(undefined, result)
      const code: EditorErrorCode | undefined = timedOut ? 'timeout' : operation.cancelled ? 'cancelled' : isEditorErrorCode(result?.error) ? result.error : undefined
      logger.warn('editor.worker.failed', { action, code: code ?? 'unknown', exitCode, signal, protocolFailed, ...safeTail(stderr) })
      finish(Object.assign(new Error(editorFailureMessage(action === 'export-all' ? 'export' : action, code)), { editorCode: code }))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}

const quote = (title: string): string => `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`
class BatchError extends Error {}
/** Report a partial "Bake all": what finished, which clips failed and why, and what is still ready. */
function batchFailure(batch: EditorBatch, failed: { title: string; error: Error }[], cancelled: boolean, stoppedBy?: unknown): Error {
  const parts = [`Baked ${batch.completed} of ${batch.total} ready clips.`]
  if (failed.length) {
    const reasons = [...new Set(failed.map((f) => f.error.message))]
    parts.push(`Could not bake ${failed.slice(0, 3).map((f) => quote(f.title)).join(', ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}:`,
      reasons.length === 1 ? reasons[0] : `${reasons[0]} (and other errors)`)
  }
  if (cancelled) parts.push('Batch cancelled.')
  else if (stoppedBy !== undefined) parts.push(`Batch stopped: ${stoppedBy instanceof Error ? stoppedBy.message : 'Export failed.'}`)
  if (batch.completed < batch.total) parts.push('Clips that were not baked are still ready.')
  return new BatchError(parts.join(' '))
}
async function executeEditor(path: unknown, revision: unknown, candidateId: unknown, action: WorkerAction, replacement?: string, subject?: Record<string, unknown>): Promise<EditorSession> {
  const run = runPath(path)
  if (operations.has(run) || operations.size >= 2) throw new Error('An editor operation is already running. Try again when it finishes.')
  const operation: EditorOperation = { action, ...(action === 'scan-cameras' || action === 'auto-frame' ? { progress: { phase: 'scan', percent: 0 } as const } : action === 'build-preview' ? { progress: { phase: 'preview', percent: 0 } as const } : {}) }
  operations.set(run, operation)
  const sourceId = action === 'replace-source' ? randomUUID().replaceAll('-', '') : undefined
  const previewId = action === 'scan-cameras' || action === 'build-preview' ? randomUUID().replaceAll('-', '') : undefined
  let previousPreview: string | undefined
  let previousMedia: string[] = []
  const failed: { title: string; error: Error }[] = []
  try {
    const session = await openEditor(run)
    if (session.project.media_freed) throw new Error('Editor media was freed. This project is read-only.')
    previousPreview = session.previewPath
    if (revision !== session.project.revision || (action !== 'export-all' && action !== 'replace-source' && action !== 'build-preview' && !session.project.candidates.some((c) => c.id === candidateId))) throw new Error('Project changed. Reopen it and retry.')
    if (sourceId) {
      const media = await openAuthorizedMedia(replacement!, loadSettings().outputDirectory)
      operation.abort = new AbortController()
      try {
        if (operation.cancelled) throw new Error('Source replacement cancelled.')
        await pipeline(media.handle.createReadStream({ autoClose: false }), createWriteStream(join(run, `editor-source-${sourceId}.mp4`), { flags: 'wx', mode: 0o600 }), { signal: operation.abort.signal })
      } finally { await media.handle.close() }
      previousMedia = [session.sourcePath, session.previewPath]
    }
    if (action === 'export' && session.project.candidates.find((c) => c.id === candidateId)!.status !== 'ready') throw new Error('Mark this clip ready before baking it')
    const candidates = action === 'build-preview' ? [] : action === 'replace-source' ? session.project.candidates.slice(0, 1) : action === 'export-all' ? session.project.candidates.filter((c) => c.status === 'ready') : session.project.candidates.filter((c) => c.id === candidateId)
    if (action !== 'build-preview' && !candidates.length) throw new Error('Mark at least one clip ready before baking.')
    if (action === 'export-all') operation.batch = { completed: 0, total: candidates.length }
    const settings = loadSettings(), engine = getEnginePath()
    if (action === 'review' && !settings.openrouterApiKey) throw new Error('Add your OpenRouter key in Settings to run this review.')
    const env: Record<string, string | undefined> = { ...runtimeEnvironment(), ...getSettingsForBridge({ ...settings, jevEnabled: 'on' }), PYTHONPATH: engine, PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' }
    const ffmpeg = resolveBinary('ffmpeg')
    if (ffmpeg !== 'ffmpeg') env.PATH = `${dirname(ffmpeg)}${delimiter}${env.PATH ?? ''}`
    const python = resolvePythonPath(engine, settings.pythonPath), limitMs = workerLimitMs(session.project.duration_ms)
    for (const candidate of candidates) {
      if (operation.cancelled) break
      try {
        await runWorker(run, operation, action, env, python, limitMs, { run, library: realpathSync(settings.outputDirectory), revision, candidate_id: candidate.id, action: action === 'export-all' ? 'export' : action, source_id: sourceId, preview_id: previewId, ...(subject ? { subject } : {}) })
        if (operation.batch) operation.batch.completed++
      } catch (error) {
        // One failed clip must not strand the rest of "Bake all".
        if (action !== 'export-all' || operation.cancelled) throw error
        failed.push({ title: candidate.title, error: error as Error })
        operation.batch!.failed = failed.length
      } finally { operation.child = undefined }
      revision = readProject(run).revision
    }
    // A fast per-reel import's segment preview is upgraded to a full-source one
    // when the user scrubs outside its window; no candidate is involved.
    if (action === 'build-preview') {
      await runWorker(run, operation, action, env, python, limitMs, { run, library: realpathSync(settings.outputDirectory), revision, action, preview_id: previewId })
    }
    if (operation.batch && (operation.cancelled || failed.length)) throw batchFailure(operation.batch, failed, !!operation.cancelled)
    if (operation.cancelled) throw new Error(editorFailureMessage(action, 'cancelled'))
  } catch (error) {
    if (operation.batch && !(error instanceof BatchError)) throw batchFailure(operation.batch, failed, !!operation.cancelled, error)
    throw error
  } finally {
    if (previewId) {
      let active: string | undefined, readable = false
      try { active = readProject(run).preview_id; readable = true } catch { /* Preserve media if state is unreadable. */ }
      const stale = !readable ? [] : active === previewId ? (previousPreview ? [previousPreview] : [])
        : [join(run, `editor-preview-${previewId}.mp4`), join(run, `editor-preview-${previewId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* A playing preview can remain open on Windows. */ } }
    }
    if (sourceId) {
      // The JSON pointer switches both media files together. Never delete the active pair,
      // including when cancellation/worker exit races with the commit.
      let active: string | undefined, readable = false
      try { active = readProject(run).source_id; readable = true } catch { /* Preserve files if the project cannot be read. */ }
      const stale = !readable ? [] : active === sourceId ? previousMedia : [join(run, `editor-source-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4`), join(run, `editor-preview-${sourceId}.mp4.partial.mp4`)]
      for (const file of stale) { try { unlinkSync(file) } catch { /* Open previews may remain until a later cleanup on Windows. */ } }
    }
    operations.delete(run)
    try { sweepEditorFiles(run) } catch { /* Cleanup is best effort. */ }
  }
  return openEditor(run)
}
// Keep IPC's editable surface narrow; no media paths, reviews or export records come from React.
export type { CandidateEdit }

let resumeAfterSave: (() => void) | null = null
/** Closing with unsaved edits: main asked the renderer to save, and resumes the close only after it succeeds. */
export function awaitEditorSaveBeforeClose(resume: () => void): void { resumeAfterSave = resume }
export function editorCloseReady(saved: unknown): void {
  const resume = resumeAfterSave
  resumeAfterSave = null
  if (saved === true && resume) setImmediate(resume)
}
