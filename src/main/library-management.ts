import { editorBusy } from './clip-editor'
import { randomUUID } from 'crypto'
import { closeSync, constants, copyFileSync, existsSync, type Dirent, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'
import { DELETING_RUN_PREFIX, getJobOutput, isManuallyPosted, isRunFavorite, LIBRARY_FAVORITE_FILE, manualPostedFile, removeRunThumbnails } from './file-manager'
import { logger } from './logger'
import { parseJobOutput, type ClipArtifact, type JobOutput } from '../shared/job-output'
import { parseEditorProject } from '../shared/clip-editor'
import { dismissJob, liveJobIds } from './job-manager'
import { loadSettings } from './settings-store'

/** Only a completed, immediate child of the configured Library can be changed. */
async function checkedRun(raw: unknown): Promise<{ check: () => string; output: JobOutput; library: string; identity: { dev: number; ino: number } }> {
  const librarySetting = loadSettings().outputDirectory
  if (typeof raw !== 'string' || !isAbsolute(raw) || raw.includes('\0')) throw new Error('Choose a run in your Library.')
  const library = realpathSync(librarySetting)
  const path = resolve(raw)
  const original = lstatSync(path)
  const canonical = realpathSync(path)
  const check = (): string => {
    const current = lstatSync(path)
    if (loadSettings().outputDirectory !== librarySetting || realpathSync(librarySetting) !== library ||
        !current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== canonical ||
        dirname(canonical) !== library || realpathSync(dirname(path)) !== library ||
        current.dev !== original.dev || current.ino !== original.ino) throw new Error('The Library run changed. Refresh and try again.')
    if (editorBusy(path)) throw new Error('Wait for the editor to finish before changing this run.')
    if (liveJobIds().has(basename(path))) throw new Error('Wait for this run to finish before changing it.')
    return path
  }
  check()
  const output = await getJobOutput(path, library)
  if (!output) throw new Error('This run is no longer in your Library. Refresh the list; it may have been deleted or be mid-deletion.')
  check()
  return { check, output, library, identity: { dev: original.dev, ino: original.ino } }
}

export async function setLibraryFavorite(outputDir: unknown, favorite: unknown): Promise<boolean> {
  if (typeof favorite !== 'boolean') throw new Error('Choose a valid favorite value.')
  const { check } = await checkedRun(outputDir)
  const path = check()
  const marker = join(path, LIBRARY_FAVORITE_FILE)
  if (favorite) {
    if (!isRunFavorite(path)) writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  } else {
    try { unlinkSync(marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return favorite
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const isDeletingRun = (name: string): boolean => name.startsWith(DELETING_RUN_PREFIX) && UUID.test(name.slice(DELETING_RUN_PREFIX.length))

export async function deleteLibraryRun(outputDir: unknown): Promise<void> {
  const { check, output, library, identity } = await checkedRun(outputDir)
  removeRunThumbnails(check(), output)
  // Rename right after the final check (no await in between), then delete.
  // The Library never lists a half-deleted run, a locked file on Windows
  // fails the rename before anything is removed, and a crash leaves a hidden
  // folder that the next startup finishes removing.
  const path = check()
  const trash = join(library, `${DELETING_RUN_PREFIX}${randomUUID()}`)
  renameSync(path, trash)
  const moved = lstatSync(trash)
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== identity.dev || moved.ino !== identity.ino) {
    try { renameSync(trash, path) } catch { /* Best effort: it is still a folder directly inside the Library. */ }
    throw new Error('The Library run changed. Refresh and try again.')
  }
  dismissJob(basename(path))
  // Never follow the manifest's media paths. Remove only this validated run
  // directory; recursive rm unlinks internal symlinks rather than their targets.
  try { rmSync(trash, { recursive: true }) } catch {
    logger.warn('library.delete.cleanup_deferred', { message: 'Some run files could not be removed; they will be removed at the next start.' })
  }
}

/**
 * Delete a run straight from the Jobs list, whether it finished or not. Failed,
 * cancelled and interrupted runs have no job_output.json, so they can only be
 * recognised by their UUID folder name directly inside the Library; the same
 * guarded rename-then-remove as a completed run still applies.
 */
export async function deleteJobRun(outputDir: unknown): Promise<void> {
  const librarySetting = loadSettings().outputDirectory
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir) || outputDir.includes('\0')) throw new Error('Choose a run in your Library.')
  const library = realpathSync(librarySetting)
  const path = resolve(outputDir)
  if (!UUID.test(basename(path))) throw new Error('This run cannot be deleted.')
  const original = lstatSync(path)
  const canonical = realpathSync(path)
  const check = (): string => {
    const current = lstatSync(path)
    if (loadSettings().outputDirectory !== librarySetting || realpathSync(librarySetting) !== library ||
        !current.isDirectory() || current.isSymbolicLink() || realpathSync(path) !== canonical ||
        dirname(canonical) !== library || realpathSync(dirname(path)) !== library ||
        current.dev !== original.dev || current.ino !== original.ino) throw new Error('The run changed. Refresh and try again.')
    if (editorBusy(path)) throw new Error('Wait for the editor to finish before deleting this run.')
    if (liveJobIds().has(basename(path))) throw new Error('Wait for this run to finish before deleting it.')
    return path
  }
  check()
  // Only a completed run has a manifest listing cached thumbnails; an unfinished
  // folder's previews are removed with the folder itself.
  const output = await getJobOutput(path, library)
  if (output) removeRunThumbnails(check(), output)
  // Rename right after the final check (no await in between), then delete.
  const p = check()
  const trash = join(library, `${DELETING_RUN_PREFIX}${randomUUID()}`)
  renameSync(p, trash)
  const moved = lstatSync(trash)
  if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== original.dev || moved.ino !== original.ino) {
    try { renameSync(trash, p) } catch { /* Best effort: it is still a folder directly inside the Library. */ }
    throw new Error('The run changed. Refresh and try again.')
  }
  dismissJob(basename(p))
  try { rmSync(trash, { recursive: true }) } catch {
    logger.warn('jobs.delete.cleanup_deferred', { message: 'Some run files could not be removed; they will be removed at the next start.' })
  }
}

/**
 * Finish run deletions interrupted by a crash or a locked file. Only real
 * directories named .deleting-<uuid> directly inside the Library are removed.
 */
export async function sweepDeletingRuns(): Promise<void> {
  let library: string
  try { library = realpathSync(loadSettings().outputDirectory) } catch { return }
  let entries: Dirent[]
  try { entries = await readdir(library, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!isDeletingRun(entry.name) || !entry.isDirectory()) continue
    const path = join(library, entry.name)
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || dirname(realpathSync(path)) !== library) continue
      await rm(path, { recursive: true })
    } catch {
      logger.warn('library.delete.sweep_failed', { message: 'A run left from an interrupted deletion could not be removed yet.' })
    }
  }
}

export async function setLibraryPosted(outputDir: unknown, clipIndex: unknown, posted: unknown): Promise<boolean> {
  if (!Number.isSafeInteger(clipIndex) || (clipIndex as number) < 0 || (clipIndex as number) > 999 || typeof posted !== 'boolean') {
    throw new Error('Choose a clip and a valid posted status.')
  }
  const { check } = await checkedRun(outputDir)
  const run = check()
  const output = parseJobOutput(readRunJson(run, 'job_output.json'))
  if (!output?.clips.some((clip) => clip.clip_index === clipIndex)) throw new Error('This clip is no longer in the run.')
  const marker = join(run, manualPostedFile(clipIndex as number))
  if (posted) {
    if (!isManuallyPosted(run, clipIndex as number)) writeFileSync(marker, '', { flag: 'wx', mode: 0o600 })
  } else {
    try { unlinkSync(marker) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return posted
}

/** Keep the complete persisted metadata, including fields not exposed to React. */
function readRunJson(run: string, name: string): Record<string, unknown> {
  const path = join(run, name)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const file = fstatSync(fd), current = lstatSync(path)
    if (!file.isFile() || current.isSymbolicLink() || file.dev !== current.dev || file.ino !== current.ino ||
        file.size > 32 * 1024 * 1024 || dirname(realpathSync(path)) !== realpathSync(run)) throw new Error('Invalid Library metadata.')
    const bytes = Buffer.alloc(file.size + 1)
    let used = 0, count = 0
    do { count = readSync(fd, bytes, used, bytes.length - used, null); used += count } while (count && used < bytes.length)
    if (used !== file.size) throw new Error('Library metadata changed. Refresh and retry.')
    const data = JSON.parse(bytes.subarray(0, used).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Library metadata.')
    return data
  } finally { closeSync(fd) }
}

export async function deleteClipArtifacts(outputDir: unknown, indices: unknown): Promise<JobOutput> {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > 1000 ||
      indices.some((id) => !Number.isSafeInteger(id) || id < 0 || id > 999) || new Set(indices).size !== indices.length) {
    throw new Error('Select clips from this Library run to delete.')
  }
  const { check } = await checkedRun(outputDir)
  const run = check(), canonical = realpathSync(run)
  // No awaits below: re-read after validation so overlapping requests cannot
  // overwrite a newer manifest or race an editor operation in this process.
  const raw = readRunJson(run, 'job_output.json'), output = parseJobOutput(raw)
  if (!output) throw new Error('Invalid Library metadata.')
  const selected = new Set<number>(indices)
  const picked = output.clips.filter((clip) => selected.has(clip.clip_index))
  if (picked.length !== selected.size) throw new Error('Some selected clips are no longer in this run. Refresh and retry.')
  const files: string[] = []
  const include = (file: string): void => {
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || dirname(realpathSync(file)) !== canonical) throw new Error('The selected clip has an unsafe file path.')
      files.push(file)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  for (const clip of picked) {
    const file = resolve(clip.s3_url.replace(/^file:\/\//, ''))
    const name = `clip_${String(clip.clip_index).padStart(2, '0')}`
    // Derive the allowed filename from its ID; a forged manifest cannot delete
    // source media, editor previews, metadata or another run's files.
    if (basename(file) !== `${name}.mp4` || realpathSync(dirname(file)) !== canonical) throw new Error('The selected clip is outside its Library run.')
    include(file)
    // Sidecars written next to each clip: framing, captions and upload notes.
    for (const suffix of ['.framing.json', '.srt', '.youtube.txt']) include(join(run, `${name}${suffix}`))
    include(join(run, manualPostedFile(clip.clip_index)))
  }
  const changes: [string, Record<string, unknown>][] = []
  if (output.editor_project) {
    const project = readRunJson(run, 'editor-project.json')
    parseEditorProject(project)
    for (const c of project.candidates as Record<string, unknown>[]) {
      const previous = c.exports as number[]
      c.exports = previous.filter((id) => !selected.has(id))
      // Earlier exports may describe older edits. Removing the latest bake
      // means the current edit needs rendering again, even if older copies remain.
      if (c.status === 'baked' && previous.length && selected.has(previous[previous.length - 1])) c.status = 'ready'
    }
    project.revision = (project.revision as number) + 1
    changes.push(['editor-project.json', project])
  }
  // IDs are permanent provenance for posts and automation bank copies. Never
  // recycle a deleted export's ID, even after deleting every clip in a run.
  raw.next_clip_index = Math.max(Number.isSafeInteger(raw.next_clip_index) ? raw.next_clip_index as number : 0,
    ...output.clips.map((clip) => clip.clip_index + 1))
  raw.clips = (raw.clips as { clip_index: number }[]).filter((clip) => !selected.has(clip.clip_index))
  raw.total_clips = (raw.clips as unknown[]).length
  changes.push(['job_output.json', raw])
  check()
  removeRunThumbnails(run, { ...output, clips: picked })
  const staging = mkdtempSync(join(run, '.delete-clips-'))
  const moved: [string, string][] = [], installed: string[] = []
  try {
    for (const [name, value] of changes) writeFileSync(join(staging, `new-${name}`), JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    for (const file of files) {
      const destination = join(staging, basename(file))
      renameSync(file, destination); moved.push([file, destination])
    }
    for (const [name] of changes) {
      const path = join(run, name), backup = join(staging, name)
      renameSync(path, backup); moved.push([path, backup])
      renameSync(join(staging, `new-${name}`), path); installed.push(path)
    }
  } catch (error) {
    try {
      for (const path of installed.reverse()) unlinkSync(path)
      for (const [path, backup] of moved.reverse()) renameSync(backup, path)
      rmSync(staging, { recursive: true })
    } catch { throw new Error('Deletion failed and could not be fully restored. The recovery files remain in the run folder. Reopen the Library to check its files.') }
    throw error
  }
  // Metadata now references only the retained clips. Do not roll back after
  // cleanup starts, since some deleted files may already have been removed.
  try { rmSync(staging, { recursive: true }) } catch { throw new Error('Clips were removed from the Library, but some files could not be cleaned up in the run folder.') }
  return parseJobOutput(raw)!
}

/**
 * Duplicate Library clips: copy each rendered file (and its .srt sidecar) to a
 * fresh, never-recycled index and clone the linked editor candidate, so edits
 * to the duplicate never touch the original. Unedited clips duplicate as
 * plain library entries with no editor link.
 */
export async function duplicateClipArtifacts(outputDir: unknown, indices: unknown): Promise<JobOutput> {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > 100 ||
      indices.some((id) => !Number.isSafeInteger(id) || id < 0 || id > 999) || new Set(indices).size !== indices.length) {
    throw new Error('Select clips from this Library run to duplicate.')
  }
  const { check } = await checkedRun(outputDir)
  const run = check(), canonical = realpathSync(run)
  const raw = readRunJson(run, 'job_output.json'), output = parseJobOutput(raw)
  if (!output) throw new Error('Invalid Library metadata.')
  const selected = new Set<number>(indices)
  const picked = output.clips.filter((clip) => selected.has(clip.clip_index))
  if (picked.length !== selected.size) throw new Error('Some selected clips are no longer in this run. Refresh and retry.')
  if (output.clips.length + picked.length > 1000) throw new Error('Duplicating would exceed the 1000-clip limit for this run.')
  // The duplicate clones the RAW manifest entry, so every persisted setting
  // (editor links, layout choices, future fields) carries over intact.
  const rawClips = new Map<number, Record<string, unknown>>(
    (Array.isArray(raw.clips) ? raw.clips : []).map((clip) => {
      const record = clip as Record<string, unknown>
      return [record.clip_index as number, record]
    })
  )
  const pad = (index: number): string => `clip_${String(index).padStart(2, '0')}`
  const safeSource = (clip: Record<string, unknown>): string => {
    const file = resolve(String(clip.s3_url).replace(/^file:\/\//, ''))
    if (basename(file) !== `${pad(clip.clip_index as number)}.mp4` || realpathSync(dirname(file)) !== canonical) {
      throw new Error('The selected clip is outside its Library run.')
    }
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The selected clip has an unsafe file path.')
    return file
  }

  // Editor project: clone the linked candidate per duplicate so edits to the
  // duplicate never touch the original.
  let project: Record<string, unknown> | null = null
  const cloneIds = new Map<number, string>()
  if (output.editor_project) {
    project = readRunJson(run, 'editor-project.json')
    parseEditorProject(project)
    const candidates = project.candidates as Record<string, unknown>[]
    for (const clip of picked) {
      const rawClip = rawClips.get(clip.clip_index)
      const source = typeof rawClip?.editor_candidate === 'string' ? rawClip.editor_candidate : null
      const original = source ? candidates.find((c) => c.id === source) : undefined
      if (!original) continue
      const clone = structuredClone(original)
      clone.id = `${String(source).slice(0, 47)}-copy-${randomUUID().replaceAll('-', '').slice(0, 8)}`
      clone.exports = []
      candidates.push(clone)
      cloneIds.set(clip.clip_index, String(clone.id))
    }
    project.revision = (project.revision as number) + 1
  }

  const used = new Set(output.clips.map((clip) => clip.clip_index))
  let next = Number.isSafeInteger(raw.next_clip_index) ? raw.next_clip_index as number : 0
  const changes: { entry: Record<string, unknown>; sourceFile: string; srtSource: string | null; index: number }[] = []
  for (const clip of picked) {
    const rawClip = rawClips.get(clip.clip_index)!
    const sourceFile = safeSource(rawClip)
    while (used.has(next) || existsSync(join(run, `${pad(next)}.mp4`))) next++
    if (next > 999) throw new Error('Too many clips in this run to duplicate.')
    used.add(next)
    const srtSource = join(run, `${pad(clip.clip_index)}.srt`)
    const entry = structuredClone(rawClip)
    entry.clip_index = next
    entry.s3_url = join(run, `${pad(next)}.mp4`)
    if (cloneIds.has(clip.clip_index)) {
      entry.editor_candidate = cloneIds.get(clip.clip_index)
      entry.editor_revision = project!.revision as number
    } else {
      delete entry.editor_candidate
      delete entry.editor_revision
    }
    changes.push({ entry, sourceFile, srtSource: existsSync(srtSource) ? srtSource : null, index: next })
    next++
  }
  for (const change of changes) {
    const cloneCandidate = project ? (project.candidates as Record<string, unknown>[]).find((c) => c.id === change.entry.editor_candidate) : undefined
    if (cloneCandidate) cloneCandidate.exports = [change.index]
  }
  raw.next_clip_index = next
  raw.clips = [...(raw.clips as unknown[]), ...changes.map((change) => change.entry)]
  raw.total_clips = (raw.clips as unknown[]).length

  const staging = mkdtempSync(join(run, '.duplicate-clips-'))
  const moved: Array<{ path: string; backup: string }> = [], copied: string[] = []
  try {
    for (const [name, value] of [['editor-project.json', project], ['job_output.json', raw]] as [string, Record<string, unknown> | null][]) {
      if (!value) continue
      writeFileSync(join(staging, `new-${name}`), JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    }
    for (const change of changes) {
      const target = join(run, `${pad(change.index)}.mp4`)
      copyFileSync(change.sourceFile, target); copied.push(target)
      if (change.srtSource) {
        const srt = join(run, `${pad(change.index)}.srt`)
        copyFileSync(change.srtSource, srt); copied.push(srt)
      }
    }
    for (const [name, value] of [['editor-project.json', project], ['job_output.json', raw]] as [string, Record<string, unknown> | null][]) {
      if (!value) continue
      const path = join(run, name), backup = join(staging, name)
      renameSync(path, backup); moved.push({ path, backup })
      renameSync(join(staging, `new-${name}`), path)
    }
  } catch (error) {
    try {
      // Every original already moved aside goes back, newest first; rename
      // replaces a half-installed new file, so `moved` alone covers both a
      // manifest that failed mid-install and one never installed at all.
      for (const { path, backup } of moved.reverse()) renameSync(backup, path)
      for (const path of copied.reverse()) unlinkSync(path)
      rmSync(staging, { recursive: true })
    } catch { throw new Error('Duplication failed and could not be fully restored. The recovery files remain in the run folder. Reopen the Library to check its files.') }
    throw error
  }
  try { rmSync(staging, { recursive: true }) } catch { /* Best effort. */ }
  return parseJobOutput(raw)!
}

/** A clip's canonical cover: a frame time or an uploaded image, stored on the raw manifest entry. */
export interface ClipThumbnail { kind: 'frame' | 'image'; atMs?: number; file?: string }

function writeRunJson(run: string, name: string, value: Record<string, unknown>): void {
  const temp = join(run, `.${name}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    renameSync(temp, join(run, name))
  } finally { try { unlinkSync(temp) } catch { /* Already committed. */ } }
}

/** The stored cover for a clip, resolved to an absolute file when it is an uploaded image. */
export async function clipThumbnail(outputDir: unknown, clipIndex: unknown): Promise<ClipThumbnail | null> {
  if (!Number.isSafeInteger(clipIndex) || (clipIndex as number) < 0 || (clipIndex as number) > 999) throw new Error('Choose a clip.')
  const { check } = await checkedRun(outputDir)
  const run = check()
  const raw = readRunJson(run, 'job_output.json')
  const entry = (Array.isArray(raw.clips) ? raw.clips : []).find((clip) => (clip as Record<string, unknown>).clip_index === clipIndex) as Record<string, unknown> | undefined
  const thumb = entry?.thumbnail as ClipThumbnail | undefined
  if (!thumb || (thumb.kind !== 'frame' && thumb.kind !== 'image')) return null
  if (thumb.kind === 'image') {
    if (typeof thumb.file !== 'string') return null
    const file = join(run, thumb.file)
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
    } catch { return null }
    return { kind: 'image', file }
  }
  return { kind: 'frame', atMs: Number.isFinite(thumb.atMs) ? thumb.atMs : 0 }
}

/** Store (or clear, with null) a clip's cover. Uploaded images are copied into the run. */
export async function setClipThumbnail(outputDir: unknown, clipIndex: unknown, thumb: unknown): Promise<ClipThumbnail | null> {
  if (!Number.isSafeInteger(clipIndex) || (clipIndex as number) < 0 || (clipIndex as number) > 999) throw new Error('Choose a clip.')
  const { check } = await checkedRun(outputDir)
  const run = check()
  const raw = readRunJson(run, 'job_output.json')
  const clips = (Array.isArray(raw.clips) ? raw.clips : []) as Record<string, unknown>[]
  const entry = clips.find((clip) => clip.clip_index === clipIndex)
  if (!entry) throw new Error('This clip is no longer in this run. Refresh and retry.')

  let stored: ClipThumbnail | null = null
  if (thumb && typeof thumb === 'object') {
    const request = thumb as { kind?: unknown; atMs?: unknown; path?: unknown }
    if (request.kind === 'frame') {
      if (!Number.isFinite(request.atMs) || (request.atMs as number) < 0) throw new Error('Pick a frame inside the video.')
      stored = { kind: 'frame', atMs: Math.round(request.atMs as number) }
    } else if (request.kind === 'image') {
      if (typeof request.path !== 'string') throw new Error('Choose an image file for the cover.')
      const { authorizeMedia } = await import('./security')
      const canonical = authorizeMedia(request.path)
      const index = Number(clipIndex)
      const target = join(run, `${padClip(index)}-cover${extname(canonical).toLowerCase()}`)
      copyFileSync(canonical, target)
      stored = { kind: 'image', file: basename(target) }
    }
  }

  if (stored) entry.thumbnail = stored
  else delete entry.thumbnail
  // An old uploaded cover leaves with the replacement; nothing else references it.
  writeRunJson(run, 'job_output.json', raw)
  return stored
}

function padClip(index: number): string {
  return `clip_${String(index).padStart(2, '0')}`
}
