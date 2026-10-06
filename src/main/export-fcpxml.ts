import { execFile } from 'child_process'
import { promisify } from 'util'
const execFileAsync = promisify(execFile)
import { BrowserWindow, dialog } from 'electron'
import { constants } from 'fs'
import { copyFile, lstat, open, readdir, readFile } from 'fs/promises'
import { join, parse as parsePath } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { resolveBinary } from './tools'
import { getJobOutput } from './file-manager'
import { assertMediaPath } from './security'
import { buildTimeline, cropTransform, type FcpXmlAsset, type FcpXmlSequence } from '../shared/fcpxml'
import { parseEditorProject, type EditorProject } from '../shared/clip-editor'
import type { JobOutput } from '../shared/job-output'

const MAX_SRT_BYTES = 2 * 1024 * 1024
const MAX_PROJECT_BYTES = 20 * 1024 * 1024

export interface FcpXmlExportResult {
  success: boolean
  canceled?: boolean
  fileName?: string
  destDir?: string
  clipCount?: number
  failedCount?: number
  srtCount?: number
}

interface ClipProbe {
  width: number | null
  height: number | null
  fps: number
  durationMs: number | null
  hasAudio: boolean
}

/** Read real geometry/frame rate when ffprobe is available; the caller falls back to the manifest. */
async function probeClip(filePath: string): Promise<ClipProbe> {
  const empty: ClipProbe = { width: null, height: null, fps: 30, durationMs: null, hasAudio: false }
  try {
    const { stdout } = await execFileAsync(
      resolveBinary('ffprobe'),
      ['-v', 'error', '-protocol_whitelist', 'file,pipe,fd', '-format_whitelist', 'mov,matroska,webm,avi,flv',
        '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration',
        '-of', 'json', filePath],
      { timeout: 15_000, maxBuffer: 1024 * 1024 }
    )
    const parsed = JSON.parse(stdout) as { streams?: Record<string, unknown>[]; format?: { duration?: string } }
    const streams = Array.isArray(parsed.streams) ? parsed.streams : []
    const video = streams.find((s) => s.codec_type === 'video')
    if (!video) return empty
    let width = Number(video.width) || null
    let height = Number(video.height) || null
    const sideData = Array.isArray(video.side_data_list) ? (video.side_data_list as Record<string, unknown>[]) : []
    const rotation = Number(sideData.find((d) => d.rotation !== undefined)?.rotation ?? (video.tags as Record<string, unknown> | undefined)?.rotate ?? 0)
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]
    const rate = typeof video.avg_frame_rate === 'string' ? video.avg_frame_rate : ''
    const [num, den] = rate.split('/').map(Number)
    const fps = Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0 ? num / den : 30
    const seconds = Number(parsed.format?.duration)
    return {
      width, height, fps,
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
    }
  } catch {
    return empty
  }
}

function clipFilePathFromUrl(url: string): string {
  if (url.startsWith('file://')) return fileURLToPath(url)
  return url
}

/** The engine names sidecars deterministically next to the clip; the manifest does not carry them for editor exports. */
async function findSidecar(outputDir: string, clipIndex: number): Promise<string | null> {
  const name = `clip_${String(clipIndex).padStart(2, '0')}.srt`
  try {
    const entry = await lstat(join(outputDir, name))
    return entry.isFile() && !entry.isSymbolicLink() && entry.size <= MAX_SRT_BYTES ? name : null
  } catch { return null }
}

async function uniqueWriteFlags(dir: string, base: string, ext: string): Promise<{ dest: string; suffix: number }> {
  let suffix = 0
  while (true) {
    const dest = join(dir, `${base}${suffix ? ` (${suffix})` : ''}${ext}`)
    try {
      const handle = await open(dest, 'wx', 0o600)
      await handle.close()
      return { dest, suffix }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || ++suffix > 10000) throw error
    }
  }
}

async function readEditorProject(outputDir: string): Promise<EditorProject | null> {
  const file = join(outputDir, 'editor-project.json')
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_PROJECT_BYTES) return null
    return parseEditorProject(JSON.parse(await readFile(file, 'utf-8')))
  } catch { return null }
}

export async function exportRunFcpXml(
  window: BrowserWindow | null,
  outputDir: string,
  clipIndices: number[] | null,
  settings: { outputDirectory: string }
): Promise<FcpXmlExportResult> {
  const data: JobOutput | null = await getJobOutput(outputDir, settings.outputDirectory)
  if (!data) throw new Error('The saved result could not be read.')
  const wanted = clipIndices && clipIndices.length > 0 ? new Set(clipIndices) : null
  const clips = data.clips.filter((clip) => !wanted || wanted.has(clip.clip_index))
  if (clips.length === 0) throw new Error('No clips to export.')

  if (!window || window.isDestroyed()) return { success: false, canceled: true }
  const picked = await dialog.showOpenDialog(window, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Export XML To…'
  })
  if (picked.canceled || picked.filePaths.length === 0) return { success: false, canceled: true }
  const destDir = picked.filePaths[0]

  const title = data.source_video_title || 'BridgeClip'
  const safeBase = Array.from(title).filter((c) => c.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'bridgeclip'
  const requestedAspect = (data.metrics?.requested_settings as Record<string, unknown> | undefined)?.aspect_ratio
  const fallback = requestedAspect === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 }

  const assets: FcpXmlAsset[] = []
  const sequences: FcpXmlSequence[] = []
  const exportedClipIndices: number[] = []
  let failedCount = 0

  // Editor projects round-trip on the kept source: one asset plus the real
  // pacing cuts from editor-project.json, so the NLE can re-edit them.
  const covered = new Set<number>()
  const project = data.editor_project === true ? await readEditorProject(outputDir) : null
  const sourcePath = join(outputDir, 'editor-source.mp4')
  if (project && !project.media_freed) {
    try {
      assertMediaPath(sourcePath, settings.outputDirectory)
      const probe = await probeClip(sourcePath)
      if (probe.width && probe.height) {
        assets.push({
          id: 'source', name: title, srcUrl: pathToFileURL(sourcePath).href,
          durationMs: probe.durationMs ?? project.duration_ms,
          width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio,
        })
        // Source-clock → spine-time mapping over the kept ranges (butt-joined).
        const timelineAt = (ranges: Array<[number, number]>, ms: number): number | null => {
          let timeline = 0
          for (const [a, b] of ranges) {
            if (ms < a) return timeline // before this range: clamp to its spine start
            if (ms <= b) return timeline + (ms - a)
            timeline += b - a
          }
          return null
        }
        for (const candidate of project.candidates) {
          const chosen = candidate.exports.filter((index) => !wanted || wanted.has(index))
          if (chosen.length === 0 || candidate.ranges.length === 0) continue
          // Speaker tracking: one spine item per scene piece, crop applied as
          // pan & zoom so the NLE shows the same reframing.
          const items: FcpXmlSequence['items'] = []
          for (const [start, end] of candidate.ranges) {
            for (let si = 0; si < candidate.scenes.length; si++) {
              const scene = candidate.scenes[si]
              const sceneEnd = si + 1 < candidate.scenes.length ? candidate.scenes[si + 1].at_ms : project.duration_ms
              const pieceStart = Math.max(start, scene.at_ms)
              const pieceEnd = Math.min(end, sceneEnd)
              if (pieceEnd - pieceStart < 100) continue
              const crop = scene.crops[0]
              items.push({ assetId: 'source', startMs: pieceStart, durationMs: pieceEnd - pieceStart,
                transform: crop ? cropTransform(crop) : undefined })
            }
          }
          const sequence: FcpXmlSequence = { name: candidate.title || `Clip ${chosen[0] + 1}`, items, overlays: [] }
          // B-rolls ride lane 1 over the spine, clamped to the kept ranges.
          for (const [bi, roll] of (candidate.brolls ?? []).entries()) {
            const rollPath = join(outputDir, `editor-asset-${roll.asset}`)
            let rollProbe: { width: number | null; height: number | null; fps: number; durationMs: number | null; hasAudio: boolean }
            try {
              assertMediaPath(rollPath, settings.outputDirectory)
              rollProbe = await probeClip(rollPath)
            } catch { continue }
            const rollId = `broll-${candidate.id}-${bi}`
            assets.push({ id: rollId, name: roll.asset, srcUrl: pathToFileURL(rollPath).href,
              durationMs: rollProbe.durationMs ?? roll.end_ms - roll.start_ms,
              width: rollProbe.width ?? fallback.width, height: rollProbe.height ?? fallback.height,
              fps: rollProbe.fps, hasAudio: rollProbe.hasAudio })
            let rollOrigin: number | null = null
            for (const [start, end] of candidate.ranges) {
              const pieceStart = Math.max(start, roll.start_ms), pieceEnd = Math.min(end, roll.end_ms)
              if (pieceEnd - pieceStart < 100) continue
              const offset = timelineAt(candidate.ranges, pieceStart)
              if (offset === null) continue
              // The engine plays a video insert from its own start and lets its
              // playhead run on through cut-out gaps, so the asset in-point is
              // the elapsed spine time since the insert's first visible piece.
              rollOrigin ??= offset
              sequence.overlays!.push({ kind: 'video', assetId: rollId, offsetMs: offset,
                startMs: offset - rollOrigin, durationMs: pieceEnd - pieceStart, lane: 1 })
            }
          }
          // Captions ride lane 2 as timed titles (editable in the NLE).
          for (const segment of project.transcript ?? []) {
            for (const [start, end] of candidate.ranges) {
              const pieceStart = Math.max(start, segment.start_ms), pieceEnd = Math.min(end, segment.end_ms)
              if (pieceEnd - pieceStart < 100) continue
              const offset = timelineAt(candidate.ranges, pieceStart)
              if (offset === null) continue
              sequence.overlays!.push({ kind: 'title', text: segment.text.slice(0, 400),
                offsetMs: offset, durationMs: pieceEnd - pieceStart, lane: 2 })
            }
          }
          sequences.push(sequence)
          for (const index of chosen) covered.add(index)
          exportedClipIndices.push(...chosen)
        }
      }
    } catch { /* No usable source media: fall back to the rendered clips below. */ }
  }
  // A source asset nobody cut from only adds noise to the timeline file.
  if (sequences.length === 0 && assets[0]?.id === 'source') {
    assets.length = 0
    covered.clear()
  }

  const remaining = assets.length > 0 ? clips.filter((clip) => !covered.has(clip.clip_index)) : clips
  for (const clip of remaining) {
    const filePath = clipFilePathFromUrl(clip.s3_url)
    try {
      assertMediaPath(filePath, settings.outputDirectory)
    } catch {
      failedCount++
      continue
    }
    const probe = await probeClip(filePath)
    const durationMs = probe.durationMs ?? clip.duration_ms
    const id = `a${assets.length}`
    assets.push({
      id,
      name: clip.summary || `Clip ${clip.clip_index + 1}`,
      srcUrl: pathToFileURL(filePath).href,
      durationMs,
      width: probe.width ?? fallback.width,
      height: probe.height ?? fallback.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
    })
    sequences.push({ name: clip.summary || `Clip ${clip.clip_index + 1}`, items: [{ assetId: id, startMs: 0, durationMs }] })
    exportedClipIndices.push(clip.clip_index)
  }
  if (sequences.length === 0) return { success: false, failedCount: clips.length }

  const xml = buildTimeline(title, assets, sequences)
  const { dest: xmlPath } = await uniqueWriteFlags(destDir, safeBase, '.fcpxml')
  const handle = await open(xmlPath, 'w', 0o600)
  try { await handle.writeFile(xml, 'utf-8') } finally { await handle.close() }

  // Ship the caption sidecars of the exported clips next to the XML.
  let srtCount = 0
  const existing = new Set(await readdir(destDir))
  for (const clipIndex of new Set(exportedClipIndices)) {
    const name = await findSidecar(outputDir, clipIndex)
    if (!name) continue
    const dest = existing.has(name) ? `${safeBase} ${name}` : name
    try {
      await copyFile(join(outputDir, name), join(destDir, dest), constants.COPYFILE_EXCL)
      existing.add(dest)
      srtCount++
    } catch { /* The XML still opens; the SRT stays in the run folder. */ }
  }

  return { success: true, fileName: parsePath(xmlPath).base, destDir, clipCount: sequences.length, failedCount, srtCount }
}
