import { app } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'
import { parseAudioTracks, type AudioTrack } from '../shared/clip-editor'

/**
 * Versioned store for imported audio tracks, next to settings.json. Every editor
 * import (file or link) lands here, so any project can reuse the track later —
 * "attach" copies it into that project's run folder like a fresh upload.
 */
export const AUDIO_LIBRARY_VERSION = 1
const MAX_TRACK_BYTES = 120 * 1024 * 1024

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function userDataDir(): string {
  return ensureDir(app.getPath('userData'))
}

function getLibraryPath(): string {
  return join(userDataDir(), 'audio-library.json')
}

/** One directory holds every track file; ids are uuid hex, so paths stay contained. */
export function audioLibraryDir(): string {
  return ensureDir(join(userDataDir(), 'audio-library'))
}

function loadAudioLibrary(): AudioTrack[] {
  const path = getLibraryPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return parseAudioTracks(Array.isArray(raw) ? raw : raw?.tracks)
  } catch (error) {
    throw new Error('Could not read the audio library. The library file was kept for recovery.', { cause: error })
  }
}

export function listAudioLibrary(): AudioTrack[] {
  // The stored file rides along so the editor can preview it; clips only ever
  // receive their own copy via attach.
  return loadAudioLibrary().map((track) => ({ ...track, file: audioTrackFile(track.id) ?? '' }))
}

export function getAudioTrack(id: unknown): AudioTrack | null {
  if (typeof id !== 'string') return null
  return loadAudioLibrary().find((track) => track.id === id) ?? null
}

const TRACK_ID = /^[a-f0-9]{32}$/

/** The stored track file, or null when the file was removed behind the store's back. */
export function audioTrackFile(id: string): string | null {
  if (!TRACK_ID.test(id)) return null
  try {
    const file = join(audioLibraryDir(), `${id}.m4a`)
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return null
    return file
  } catch { return null }
}

function writeLibrary(tracks: AudioTrack[]): void {
  const path = getLibraryPath()
  const tempPath = `${path}.${randomUUID()}.tmp`
  const persisted = { version: AUDIO_LIBRARY_VERSION, tracks }
  try {
    writeFileSync(tempPath, JSON.stringify(persisted, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tempPath, path)
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

/** Copy a freshly imported track file into the library and register it. */
export function addToAudioLibrary(sourceFile: unknown, title: unknown, durationMs: unknown, origin: unknown): AudioTrack {
  if (typeof sourceFile !== 'string' || !isAbsolute(sourceFile) || sourceFile.includes('\0')) throw new Error('Invalid audio import result')
  let stat
  try { stat = statSync(sourceFile) } catch { throw new Error('The imported audio vanished before it could be saved') }
  if (lstatSync(sourceFile).isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRACK_BYTES) throw new Error('The imported audio is not a usable file')
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Invalid audio title')
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 6 * 3600 * 1000) throw new Error('Invalid audio duration')
  if (origin !== 'file' && origin !== 'link') throw new Error('Invalid audio origin')
  const track: AudioTrack = { id: randomUUID().replaceAll('-', ''), title: title.trim(), duration_ms: Math.round(durationMs), origin, added_at: Date.now() }
  copyFileSync(sourceFile, join(audioLibraryDir(), `${track.id}.m4a`))
  const tracks = loadAudioLibrary()
  if (tracks.length >= 300) throw new Error('The audio library is full. Remove a track first.')
  tracks.push(track)
  writeLibrary(tracks)
  return { ...track }
}

export function removeAudioTrack(id: unknown): boolean {
  if (typeof id !== 'string') return false
  const tracks = loadAudioLibrary()
  const next = tracks.filter((track) => track.id !== id)
  if (next.length === tracks.length) return false
  writeLibrary(next)
  const file = audioTrackFile(String(id))
  // Projects hold their own copies, so a removed library file breaks nothing.
  if (file) { try { rmSync(file, { force: true }) } catch { /* A locked file is swept later. */ } }
  return true
}
