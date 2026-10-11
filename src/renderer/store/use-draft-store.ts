import { create } from 'zustand'
import type { CaptionStyleOverrides } from '../../shared/clip-editor'

/** The Create wizard's steps, in order. */
export type WizardStep = 'video' | 'format' | 'clips' | 'captions' | 'review'

/** The run the wizard just queued, shown as a confirmation until the next video. */
export interface StartedJob {
  jobId: string
  source: string
  /** True when every slot was busy and the job is waiting its turn. */
  queued: boolean
}

/** Output formats the wizard can pick; primary first. */
export type WizardAspectRatio = '9:16' | '16:9' | '1:1'

/**
 * The Create form, kept outside the component so the chosen video and options
 * survive navigating away (e.g. to Settings to add a key) and a failed run.
 */
export interface ClipDraft {
  workflow: 'automatic' | 'review' | null
  source: string
  clippingMode: 'quality' | 'economy' | 'advanced'
  plannerModel: string
  transcriptionModel: string
  /** Output formats for every clip, primary first; review workflows keep one. */
  aspectRatios: WizardAspectRatio[]
  /** Brand pack selected in the wizard; its fields are applied to the draft on select, and later manual edits win. */
  templateId: string | null
  /** Framing for 9:16 / 1:1 output: smart per-shot layouts, always full frame, or letterbox. */
  layoutStyle: 'auto' | 'fill' | 'fit'
  /** Paid vision verification for ambiguous shots in Smart framing. */
  layoutVision: boolean
  /** tight: cut dead air and filler words; natural: original timing. */
  pacing: 'tight' | 'natural'
  videoSpeed: number
  /** Optional description of the moments to clip; blank finds the best ones. */
  clipRequest: string
  durations: string[]
  autoClipCount: boolean
  maxClips: number
  /** Full coverage: extract every self-contained moment, not only the most viral. */
  coverage: boolean
  includeCaptions: boolean
  /** Only add caption without clipping: caption the whole video, no clip selection. */
  captionsOnly: boolean
  captionPreset: string
  /** Customisation layered on captionPreset; null = the plain preset. */
  captionStyle: CaptionStyleOverrides | null
  /** User-uploaded .srt for the transcript; null uses AI transcription. */
  srtPath: string | null
  srtName: string | null
  /** Automatic clips: the title card at the top of each clip. */
  includeTitle: boolean
  /** Channel banner from a brand pack; the wizard has no banner editor, so these only arrive via draftPatchForTemplate. */
  bannerPlatform: string | null
  bannerChannelUrl: string | null
  trimOpen: boolean
  trimStart: string
  trimEnd: string
}

interface DraftState extends ClipDraft {
  step: WizardStep
  started: StartedJob | null
  update: (patch: Partial<ClipDraft>) => void
  setStep: (step: WizardStep) => void
  clearSource: () => void
  /** The job was queued: show the confirmation. */
  markStarted: (started: StartedJob) => void
  /** Start a new video with no workflow selected, keeping output preferences (not the video-specific clip request). */
  startAnother: () => void
}

export const useDraftStore = create<DraftState>((set) => ({
  workflow: null,
  source: '',
  clippingMode: 'quality',
  plannerModel: '',
  transcriptionModel: '',
  aspectRatios: ['9:16'],
  templateId: null,
  layoutStyle: 'auto',
  layoutVision: true,
  pacing: 'tight',
  videoSpeed: 1,
  clipRequest: '',
  durations: ['short'],
  autoClipCount: true,
  maxClips: 5,
  coverage: false,
  includeCaptions: true,
  captionsOnly: false,
  captionPreset: 'pop',
  captionStyle: null,
  srtPath: null,
  srtName: null,
  includeTitle: true,
  bannerPlatform: null,
  bannerChannelUrl: null,
  trimOpen: false,
  trimStart: '',
  trimEnd: '',
  step: 'video',
  started: null,
  update: (patch) => set(patch),
  setStep: (step) => set({ step }),
  clearSource: () => set({ source: '', trimStart: '', trimEnd: '' }),
  markStarted: (started) => set({ started }),
  startAnother: () => set({ workflow: null, source: '', clipRequest: '', trimOpen: false, trimStart: '', trimEnd: '', step: 'video', started: null })
}))
