/**
 * Auto Import: watch YouTube playlists and enqueue new uploads for clipping.
 *
 * The user picks playlists once (Settings → Auto Import); a background timer
 * polls them through the bundled yt-dlp (flat listing, no downloads), skips
 * videos already imported, and queues the fresh ones through the normal job
 * pipeline. State lives in a small JSON store under userData.
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { promisify } from 'util'
import { resolveBinary } from './tools'
import { loadSettings, type AppSettings } from './settings-store'
import { logger } from './logger'

const execFileAsync = promisify(execFile)

export interface AutoImportConfig {
  enabled: boolean
  /** YouTube playlist URLs or IDs, one per line. */
  playlists: string[]
  /** Minutes between polls (min 15). */
  intervalMinutes: number
  /** Max videos queued per poll, per playlist. */
  maxPerPoll: number
}

const DEFAULTS: AutoImportConfig = { enabled: false, playlists: [], intervalMinutes: 60, maxPerPoll: 3 }
const STATE_VERSION = 1
const MAX_PLAYLISTS = 20
const MAX_STORED = 2000
const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,64}$/

interface ImportState {
  version: number
  /** videoId → ISO time queued. */
  imported: Record<string, string>
  lastPollAt: string | null
}

let state: ImportState = { version: STATE_VERSION, imported: {}, lastPollAt: null }
let stateLoaded = false
let polling = false
let timer: ReturnType<typeof setInterval> | null = null

function statePath(): string {
  return join(app.getPath('userData'), 'auto-import-state.json')
}

function loadState(): void {
  if (stateLoaded) return
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8'))
    if (raw && raw.version === STATE_VERSION && raw.imported && typeof raw.imported === 'object') {
      state = { version: STATE_VERSION, imported: raw.imported, lastPollAt: typeof raw.lastPollAt === 'string' ? raw.lastPollAt : null }
    }
  } catch { /* Missing or corrupt state starts fresh. */ }
  stateLoaded = true
}

function saveState(): void {
  const temp = `${statePath()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(temp, statePath())
  } catch {
    try { unlinkSync(temp) } catch { /* Best effort. */ }
  }
}

/** Playlist URLs from settings, normalized to bare playlist IDs. */
export function autoImportConfig(settings: AppSettings): AutoImportConfig {
  const raw = String((settings as unknown as { autoImportPlaylists?: unknown }).autoImportPlaylists ?? '')
  const playlists: string[] = []
  for (const line of raw.split(/\n/)) {
    const value = line.trim()
    if (!value) continue
    let id: string | null = null
    try {
      const url = new URL(value)
      id = url.searchParams.get('list')
    } catch { id = PLAYLIST_ID.test(value) ? value : null }
    if (id && PLAYLIST_ID.test(id) && !playlists.includes(id)) playlists.push(id)
    if (playlists.length >= MAX_PLAYLISTS) break
  }
  const interval = Number((settings as unknown as { autoImportIntervalMinutes?: unknown }).autoImportIntervalMinutes)
  return {
    enabled: (settings as unknown as { autoImportEnabled?: unknown }).autoImportEnabled === true,
    playlists,
    intervalMinutes: Number.isFinite(interval) && interval >= 15 ? Math.min(interval, 1440) : 60,
    maxPerPoll: 3
  }
}

/** The watched playlists as stored (ids), for the settings UI. */
export function autoImportStatus(): { config: AutoImportConfig; lastPollAt: string | null; importedCount: number; polling: boolean } {
  loadState()
  return { config: autoImportConfig(loadSettings()), lastPollAt: state.lastPollAt, importedCount: Object.keys(state.imported).length, polling }
}

/** Extract a bare playlist ID from a URL or raw id; null when it isn't one. */
export function playlistIdFrom(value: string): string | null {
  try {
    const url = new URL(value.trim())
    const id = url.searchParams.get('list')
    return id && PLAYLIST_ID.test(id) ? id : null
  } catch {
    return PLAYLIST_ID.test(value.trim()) ? value.trim() : null
  }
}

/** Flat-list a playlist through the bundled yt-dlp; newest entries first. */
export async function listPlaylistVideos(playlistId: string): Promise<{ id: string; title: string }[]> {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`
  const { stdout } = await execFileAsync(resolveBinary('yt-dlp'), [
    '--ignore-config', '--no-warnings', '--flat-playlist', '--no-download',
    '--print', JSON.stringify({ id: '%(id)j', title: '%(title)j' }), url
  ], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
  const entries: { id: string; title: string }[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (typeof item.id === 'string' && /^[\w-]{5,}$/.test(item.id)) {
        entries.push({ id: item.id, title: typeof item.title === 'string' ? item.title.slice(0, 200) : '' })
      }
    } catch { /* Skip malformed lines. */ }
  }
  return entries
}

function queueImport(videoId: string, title: string, settings: AppSettings): void {
  const { createRunRecord } = require('./run-history')
  const { enqueueJob } = require('./job-manager')
  const jobId = randomUUID()
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
  createRunRecord(settings.outputDirectory, jobId, videoUrl)
  enqueueJob(jobId, {
    videoUrl,
    workflow: 'automatic',
    maxClips: null,
    autoClipCount: true,
    durationRanges: null,
    aspectRatio: '9:16',
    aspectRatios: ['9:16'],
    layoutStyle: 'auto',
    layoutVision: false,
    pacing: 'tight',
    videoSpeed: 1,
    includeCaptions: true,
    captionPreset: 'pop',
    includeTitle: true,
    startTimeSeconds: null,
    endTimeSeconds: null,
    bannerPlatform: null,
    bannerChannelUrl: null
  }, settings.outputDirectory)
  logger.info('auto-import.queued', { videoId, title: title.slice(0, 120) })
}

/**
 * One poll pass over every configured playlist. Returns what was queued.
 * Errors on one playlist never block the others.
 */
export async function pollAutoImport(options: { lister?: (playlistId: string) => Promise<{ id: string; title: string }[]> } = {}): Promise<{ queued: { videoId: string; title: string }[]; errors: string[] }> {
  loadState()
  if (polling) return { queued: [], errors: ['A poll is already running.'] }
  const lister = options.lister ?? listPlaylistVideos
  const settings = loadSettings()
  const config = autoImportConfig(settings)
  if (!config.enabled || !config.playlists.length) return { queued: [], errors: [] }
  polling = true
  const queued: { videoId: string; title: string }[] = []
  const errors: string[] = []
  try {
    for (const playlistId of config.playlists) {
      if (queued.length >= config.maxPerPoll) break
      let entries: { id: string; title: string }[]
      try {
        entries = await lister(playlistId)
      } catch (error) {
        errors.push(`Playlist ${playlistId}: ${error instanceof Error ? error.message : 'listing failed'}`)
        continue
      }
      let fromPlaylist = 0
      for (const entry of entries) {
        if (queued.length >= config.maxPerPoll || fromPlaylist >= config.maxPerPoll) break
        if (state.imported[entry.id]) continue
        try {
          queueImport(entry.id, entry.title, settings)
          state.imported[entry.id] = new Date().toISOString()
          queued.push({ videoId: entry.id, title: entry.title })
          fromPlaylist++
        } catch (error) {
          errors.push(`Could not queue ${entry.id}: ${error instanceof Error ? error.message : 'unknown error'}`)
        }
      }
    }
    // Keep the imported map bounded.
    const keys = Object.keys(state.imported)
    if (keys.length > MAX_STORED) {
      for (const key of keys.sort((a, b) => state.imported[a].localeCompare(state.imported[b])).slice(0, keys.length - MAX_STORED)) delete state.imported[key]
    }
    state.lastPollAt = new Date().toISOString()
    saveState()
    if (queued.length) logger.info('auto-import.polled', { queued: queued.length })
  } finally { polling = false }
  return { queued, errors }
}

/**
 * Whether a poll is due: never polled yet (or an unreadable timestamp) means
 * due; otherwise the configured interval must have elapsed since the last one.
 */
export function autoImportDue(lastPollAt: string | null, intervalMinutes: number): boolean {
  if (!lastPollAt) return true
  const elapsedMs = Date.now() - new Date(lastPollAt).getTime()
  return !Number.isFinite(elapsedMs) || elapsedMs >= intervalMinutes * 60_000
}

/** The background timer; reads settings every tick, so edits apply without a restart. */
export function initAutoImport(): void {
  if (timer) return
  timer = setInterval(() => {
    const config = autoImportConfig(loadSettings())
    if (!config.enabled || !config.playlists.length) return
    // The timer ticks every 5 minutes; the configured interval decides whether
    // a poll is actually due, so 15–1440 minutes is honored without a restart.
    loadState()
    if (!autoImportDue(state.lastPollAt, config.intervalMinutes)) return
    void pollAutoImport().catch(() => { /* Logged in poll. */ })
  }, 5 * 60_000)
  if (typeof timer.unref === 'function') timer.unref()
}

/** Test-only; not used by the app. */
export function resetAutoImportStateForTests(): void {
  state = { version: STATE_VERSION, imported: {}, lastPollAt: null }
  stateLoaded = false
  polling = false
}
