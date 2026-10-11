import type { RunDiagnostics } from './run-diagnostics'
import type { PipelineStage } from './job-progress'
import type { JobOutput } from './job-output'
import type { CaptionStyleOverrides, OverlayPosition } from './clip-editor'

/** Brand-template logo snapshot; main owns the asset, so `path` is absolute. */
export interface JobLogoOverlay { path: string; position: OverlayPosition; /** Fraction of output width, 0.05–0.5. */ scale: number; /** 0.1–1. */ opacity: number; /** Corner inset as a fraction of output width; absent keeps the engine margin. */ margin?: number }
/** Brand-template CTA badge snapshot, burned in for the whole clip. */
export interface JobCtaBadge { kind: 'subscribe' | 'follow'; position: OverlayPosition; margin?: number }
/** Brand-template intro/outro video snapshot; main owns the asset, so `path` is absolute. */
export interface JobBrandVideo { path: string }

/** Options for one clipping run, as the Create wizard submits them. */
export interface ClipJobRequest {
  workflow?: 'automatic' | 'review' | 'captions-only'
  videoUrl: string
  /** Missing on older queued requests; those retain the original quality mode. */
  clippingMode?: 'quality' | 'economy' | 'advanced'
  /** Required in Advanced mode; presets choose their own models. */
  plannerModel?: string
  transcriptionModel?: string
  /** What the user wants clipped, in their words. Omitted: the best moments. */
  clipRequest?: string
  maxClips: number | null
  autoClipCount: boolean
  /** Full-coverage extraction: every self-contained moment, not only the most viral. */
  coverage?: boolean
  durationRanges: string[] | null
  aspectRatio: string
  /** Output formats for every clip; aspectRatio stays the primary (= [0]). Missing on older requests. */
  aspectRatios?: string[]
  layoutStyle: string
  layoutVision: boolean
  pacing: string
  /** Export speed for every clip. Older requests default to normal speed. */
  videoSpeed?: number
  includeCaptions: boolean
  captionPreset: string
  /** Caption customisation layered on the preset; absent = the plain preset. */
  captionStyle?: CaptionStyleOverrides
  /** Title card at the top of Automatic clips. Older requests default to shown. */
  includeTitle?: boolean
  startTimeSeconds: number | null
  endTimeSeconds: number | null
  bannerPlatform: string | null
  bannerChannelUrl: string | null
  /** User-uploaded .srt replacing AI transcription; main validates the path. */
  srtPath?: string
  /** Brand pack applied at creation; provenance only — the fields below are the snapshot. */
  templateId?: string
  /** Brand-template overlays materialized onto every clip of the run. */
  logo?: JobLogoOverlay
  ctaBadges?: JobCtaBadge[]
  /** Brand-template intro/outro videos appended around every clip of the run. */
  intro?: JobBrandVideo
  outro?: JobBrandVideo
}

/** How many clipping runs the main process lets run at once; the rest wait in a queue. */
export const MAX_PARALLEL_JOBS = 2

/** Requested output formats, primary first; older requests carry only aspectRatio. */
export function jobAspectRatios(request: { aspectRatio: string; aspectRatios?: string[] }): string[] {
  return request.aspectRatios?.length ? request.aspectRatios : [request.aspectRatio]
}

/** Finished runs retained in the live session; older runs remain on disk. */
export const MAX_FINISHED_JOBS = 50

export type ActiveJobStatus = 'queued' | 'pending' | 'downloading' | 'contextualizing' | 'transcribing' | 'planning' | 'rendering' | 'uploading'
export type TerminalJobStatus = 'completed' | 'failed' | 'cancelled'
export type JobStatus = ActiveJobStatus | TerminalJobStatus

export const ACTIVE_JOB_STATUSES: readonly ActiveJobStatus[] = ['queued', 'pending', 'downloading', 'contextualizing', 'transcribing', 'planning', 'rendering', 'uploading']

export function isActiveJobStatus(status: string): status is ActiveJobStatus {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status)
}

/**
 * A job as the main process tracks it. The main process owns the list and
 * pushes a fresh snapshot on every change (`jobs:update`); `revision` only goes
 * up, so the renderer can drop a snapshot that arrives after a newer one.
 */
export interface JobSnapshot {
  id: string
  revision: number
  request: ClipJobRequest
  status: JobStatus
  percent: number
  stages?: PipelineStage[]
  diagnostics?: RunDiagnostics
  progressAt?: number
  /** When the current status first appeared; lets the UI time the active step even without engine stage measurements. */
  statusAt?: number
  step: string
  clipsDone: number
  clipsTotal: number
  error: string | null
  /** Suggested fix, when the main process can tell what went wrong. */
  errorHint: string | null
  failureCode?: string | null
  failureStage?: string | null
  httpStatus?: number | null
  output: JobOutput | null
  /** The run folder inside the output directory. */
  outputDir: string
  queuedAt: string
  startedAt: string | null
  finishedAt: string | null
}
