import type { JevThresholdSettings } from '../shared/jev-settings'
import type { LibraryClipTarget } from '../shared/library-posting'
import type { AutomationReviewResult } from '../shared/automations'
import type { AudioTrack, CandidateEdit, EditorProgressSummary, EditorSession, MotionPlan } from '../shared/clip-editor'
import type { BulkExportProgress, JobOutput } from '../shared/job-output'
import type { EditAudit } from '../shared/editorial'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ZernioConnectOptions,
  ZernioConnectResult,
  ZernioConnectStart,
  ZernioOverview,
  ZernioPendingConnect,
  ZernioPlatform,
  ZernioProfile,
  ZernioSyncResult,
  ZernioStatusCheck
} from '../shared/zernio'
import type { CalendarResult, ClipMediaInfo, PostClipRequest, PostClipResult, PostProgress, PostRecord, PostsRefreshResult, TikTokCreatorInfo, TikTokLegalLink } from '../shared/zernio-posts'
import type { BestTimeResult, DashboardResult } from '../shared/zernio-analytics'
import type { ClipJobRequest, JobSnapshot } from '../shared/jobs'
import type { BrandTemplate } from '../shared/templates'
import type { SavedCaptionStyle } from '../shared/caption-styles'
import type { MetadataEnhancement, AutomationSourceGroup, AutomationBatchResult, AutomationSourceContext, Automation, AutomationUpdate, AutomationTikTokReview, AutomationTikTokReviewUpdate } from '../shared/automations'
import type { LibraryClipPostingStatus, LibraryEnhancementOptions, LibraryRunPostingCounts } from '../shared/library-posting'
import type { OpenRouterCatalog } from '../shared/openrouter-models'
import type { LocalAiProgress, LocalAiStatus } from '../shared/local-ai'
import type { UpdateState } from '../shared/updates'
import type { OutputStorageUsage } from '../shared/output-storage'
import type { YouTubePreview } from '../shared/youtube-preview'

export interface ClipSettings extends JevThresholdSettings {
  openrouterConfigured: boolean
  nvidiaConfigured: boolean
  zernioConfigured: boolean
  jevEnabled: string
  jevVisualContext: string
  sourceContextWebResearch: string
  aiProvider: 'cloud' | 'nvidia' | 'local'
  nvidiaPlannerModel: string
  localLlmBaseUrl: string
  localPlannerModel: string
  localWhisperModel: string
  transcriptionLanguage: string
  outputDirectory: string
  pythonPath: string
  customVocabulary: string
  /** Brand pack auto-applied to new projects; empty string = none. */
  defaultTemplateId: string
  /** Auto Import: YouTube playlist URLs/IDs, one per line. */
  autoImportPlaylists: string
  autoImportEnabled: boolean
  autoImportIntervalMinutes: number
}

export type { ClipJobRequest, JobSnapshot } from '../shared/jobs'

export interface HistoryEntry {
  editorProject?: boolean
  candidateCount?: number
  favorite?: boolean
  jobId: string
  date: string
  videoTitle: string
  clipCount: number
  status: 'completed' | 'failed' | 'cancelled' | 'running' | 'interrupted' | 'incomplete'
  outputDir: string
  totalCostUsd: number | null
  finishedAt: string | null
  durationMs: number | null
  errorMessage: string | null
}

export interface ToolStatus {
  python: boolean
  pythonDeps: boolean
  pythonPath: string
  pythonError: string | null
  pythonHint?: string | null
  pythonRepairCommand?: string | null
  ffmpeg: boolean
  ffmpegCaptions: boolean
  ffprobe: boolean
  ytdlp: boolean
  engine: boolean
  enginePath: string
  bridgeRunner: boolean
  bridgePath: string
}

export interface BridgeClipAPI {
  source: { youtubePreview: (url: string, details?: boolean) => Promise<YouTubePreview> }
  editor: {
    open: (path: string) => Promise<EditorSession>
    /** Re-attach an automatic run's source (URL, or the file the user picked) to make its clips editable.
     * `focusClipIndex` prepares only that reel's preview window first (fast per-reel edit).
     * `allowDownload` is his answer to "the original isn't on this PC" — without it the import
     * only ever reads the Library, because a button must not pull gigabytes by itself. */
    createProject: (path: string, mediaPath?: string, focusClipIndex?: number, allowDownload?: boolean) => Promise<EditorSession>
    save: (path: string, revision: number, edits: CandidateEdit[], speakerNames?: Record<string, string>) => Promise<EditorSession>
    /** Opens a picker for the kind (image | video | audio), copies the choice into the project; null when cancelled. */
    addAsset: (path: string, kind: 'image' | 'video' | 'audio') => Promise<{ asset: string; name: string } | null>
    /** Import tab: a dropped media file; main infers the kind from its extension. */
    addAssetDropped: (path: string, file: string) => Promise<{ asset: string; name: string } | null>
    /** "Add audio": a dropped/picked audio-or-video file or a pasted link; extracts the track, saves it to the audio library and returns the asset to set as the clip's music. Null when cancelled. */
    importAudio: (path: string, source: { mode: 'file'; path?: string } | { mode: 'link'; url: string }) => Promise<{ asset: string; name: string; durationMs: number; track: AudioTrack } | null>
    /** The saved audio library, shared by every project; attach copies a track into this project. */
    audioList: () => Promise<AudioTrack[]>
    audioAttach: (path: string, id: string) => Promise<{ asset: string; name: string }>
    audioRemove: (id: string) => Promise<boolean>
    /** Motion Studio: plan shots for an idea via the configured AI provider. */
    motionPlan: (request: { idea: string; references: { asset: string; name: string; kind: 'image' | 'video' | 'audio' }[]; style: string; lengthMs: number }) => Promise<MotionPlan>
    /** Motion Studio: render a reviewed shot plan with the local generator. */
    motionRender: (path: string, plan: MotionPlan, audioAsset?: string) => Promise<{ asset: string; durationMs: number }>
    run: (path: string, revision: number, id: string, action: 'review' | 'export' | 'export-all' | 'scan-cameras' | 'auto-frame' | 'build-preview', subject?: { atMs: number; x: number; y: number }) => Promise<EditorSession>
    cancel: (path: string) => Promise<void>
    /** "AI hook": one punchy opening line (≤120 chars) for the candidate, on the configured local/NVIDIA provider. */
    aiHook: (path: string, candidateId: string) => Promise<{ text: string }>
    /** Rewrite a video title in one of the announced styles (interesting/catchy/serious/question). */
    titleStyle: (input: { title: string; caption: string; style: 'interesting' | 'catchy' | 'serious' | 'question' }) => Promise<{ title: string }>
    /** "AI enhance": a sharper title (≤200 chars) plus up to 5 caption cleanups for the candidate. */
    aiEnhance: (path: string, candidateId: string) => Promise<{ title: string; caption_edits: { segment: number; text: string }[] }>
    /** Speech cleanup: flags retakes, restarts, repetitions and self-corrections as covered transcript line spans. */
    aiBadTakes: (path: string, candidateId: string) => Promise<{ start: number; end: number; reason: string }[]>
    /** Voiceover Studio: the installed Windows voices, and a scratch preview synthesis. */
    voiceVoices: (path: string) => Promise<string[]>
    voicePreview: (path: string, config: { script: string; voice: string; rate: number; pronunciations: { word: string; say: string }[] }) => Promise<{ asset: string; durationMs: number }>
    replaceSource: (path: string, revision: number, replacement: string) => Promise<EditorSession>
    /** Status counts only; cheap enough for list rows and polling. */
    progress: (path: string) => Promise<EditorProgressSummary>
    /** Live import/operation state, also before the editor project exists. */
    operationProgress: (path: string) => Promise<{ operation: EditorProgressSummary['operation']; batch?: EditorProgressSummary['batch']; progress?: EditorProgressSummary['progress'] }>
    /** Normalized audio peaks (0–1) across the source, for the timeline waveform. */
    waveform: (path: string) => Promise<number[]>
    freeMedia: (path: string, revision: number) => Promise<EditorSession>
    /** Main asks the open editor to save before a close or quit continues. */
    onSaveBeforeClose: (callback: () => void) => () => void
    closeReady: (saved: boolean) => Promise<void>
  }
  edits: { inspect: (outputDir: string) => Promise<EditAudit> }
  models: { list: (refresh?: boolean) => Promise<OpenRouterCatalog> }
  localai: {
    /** Offline stack readiness: GPU, faster-whisper, weights, Ollama, model. */
    status: () => Promise<LocalAiStatus>
    /** Deploys everything the offline mode needs; progress via onProgress. */
    setup: () => Promise<LocalAiStatus>
    cancel: () => Promise<boolean>
    onProgress: (callback: (progress: LocalAiProgress) => void) => () => void
  }
  automations: {
    reviewContent: (id: string, contentId: string, returnToQueue: boolean) => Promise<AutomationReviewResult>
    acknowledgeWarnings: (id: string | null, contentId?: string) => Promise<Automation[]>
    dismissMetadataError: (id: string, contentId: string) => Promise<Automation[]>
    libraryClip: (id: string, contentId: string) => Promise<LibraryClipTarget | null>
    showInFolder: (id: string, contentId: string) => Promise<boolean>
    reorder: (id: string, contentId: string, beforeId: string | null) => Promise<Automation[]>
    enhancementGroups: (id: string) => Promise<AutomationSourceGroup[]>
    enhanceBatch: (id: string, contentIds: string[], key: string, guidance?: string) => Promise<AutomationBatchResult>
    source: (id: string, contentId: string) => Promise<AutomationSourceContext | null>
    enhance: (id: string, contentId: string, options: { source?: AutomationSourceContext | null; research: boolean }) => Promise<Automation[]>
    resolveDraft: (id: string, contentId: string, draftId: string, apply: boolean) => Promise<Automation[]>
    list: () => Promise<Automation[]>
    create: (name: string) => Promise<Automation[]>
    update: (id: string, update: AutomationUpdate) => Promise<Automation[]>
    delete: (id: string) => Promise<Automation[]>
    retryContent: (id: string, contentId: string) => Promise<Automation[]>
    run: (id: string) => Promise<Automation[]>
    addContent: (id: string) => Promise<Automation[]>
    addLibraryClips: (id: string, outputDir: string, clipIndices: number[]) => Promise<Automation[]>
    updateContent: (id: string, contentId: string, update: { title: string; caption: string; returnToQueue?: boolean }) => Promise<Automation[]>
    prepareTikTokReview: (id: string, contentId: string) => Promise<AutomationTikTokReview>
    approveTikTokReview: (id: string, contentId: string, update: AutomationTikTokReviewUpdate) => Promise<Automation[]>
    removeContent: (id: string, contentId: string) => Promise<Automation[]>
  }
  autoImport: {
    /** Status + current Auto Import config. */
    status: () => Promise<{ config: { enabled: boolean; playlists: string[]; intervalMinutes: number; maxPerPoll: number }; lastPollAt: string | null; importedCount: number; polling: boolean }>
    /** Persists the Auto Import config. */
    set: (patch: { playlists?: string; enabled?: boolean; intervalMinutes?: number }) => Promise<ClipSettings>
    /** Polls every configured playlist now. */
    pollNow: () => Promise<{ queued: { videoId: string; title: string }[]; errors: string[] }>
  },
  settings: {
    load: () => Promise<ClipSettings>
    /** Pass true to count again instead of reusing a result from the last few seconds. */
    storageUsage: (fresh?: boolean) => Promise<OutputStorageUsage>
    save: (settings: ClipSettings) => Promise<ClipSettings>
    /** Brand Vocabulary: one proper noun (from the editor's transcript), merged into the saved terms. */
    addVocabularyTerm: (term: string) => Promise<{ terms: string[] }>
    replaceApiKey: (key: 'openrouterApiKey' | 'nvidiaApiKey' | 'zernioApiKey', value: string) => Promise<ClipSettings>
    selectOutputDir: () => Promise<string | null>
  }
  templates: {
    /** Built-in packs first, then the user's saved ones. */
    list: () => Promise<BrandTemplate[]>
    /**
     * Inserts or replaces a pack. The picked paths (logo image, intro/outro
     * videos) are copied by main into the pack's asset folder; null keeps the
     * stored asset.
     */
    save: (template: BrandTemplate, logoPath?: string | null, introPath?: string | null, outroPath?: string | null) => Promise<BrandTemplate>
    /** false when the id was not a saved pack; built-ins throw instead. */
    delete: (id: string) => Promise<boolean>
  }
  captionStyles: {
    /** The user's saved caption styles. */
    list: () => Promise<SavedCaptionStyle[]>
    /** Inserts or replaces by id; returns the updated list. */
    save: (style: SavedCaptionStyle) => Promise<SavedCaptionStyle[]>
    /** Removes one; returns the updated list. */
    delete: (id: string) => Promise<SavedCaptionStyle[]>
  }
  zernio: {
    checkStatus: () => Promise<ZernioStatusCheck>
    overview: () => Promise<ZernioOverview>
    createProfile: (name: string) => Promise<ZernioProfile>
    /** Live accounts from Zernio, or the cached copy with the reason Zernio couldn't be read. Never rejects for Zernio failures. */
    sync: () => Promise<ZernioSyncResult>
    /** The last synced accounts, from disk (no network). */
    cachedOverview: () => Promise<ZernioOverview | null>
    /** A sign-in still waiting for the browser, e.g. after the window reloaded. */
    pendingConnect: () => Promise<ZernioPendingConnect | null>
    /**
     * Opens the platform's sign-in in the browser; the outcome arrives via onConnectResult when the
     * result is `pending`. `profileId` null uses the default profile (creating one if needed).
     */
    connect: (platform: ZernioPlatform, profileId: string | null, options?: ZernioConnectOptions) => Promise<ZernioConnectStart>
    cancelConnect: () => Promise<void>
    disconnect: (accountId: string) => Promise<void>
    onConnectResult: (callback: (result: ZernioConnectResult) => void) => () => void
    /** The Zernio key was added, replaced or removed; drop anything from the previous workspace. */
    onReset: (callback: (state: { configured: boolean }) => void) => () => void
    /** Posting clips. Uploads, post creation and links run in the main process. */
    posts: {
      probe: (clipPath: string, durationMs: number | null) => Promise<ClipMediaInfo>
      /** The clip's run's original video URL, or null; drives the YouTube full-video-link checkbox. */
      sourceVideoLink: (clipPath: string) => Promise<string | null>
      tiktokCreatorInfo: (accountId: string) => Promise<TikTokCreatorInfo>
      /** Uploads the clip and creates the post; progress arrives via onProgress. */
      publish: (request: PostClipRequest) => Promise<PostClipResult>
      cancelUpload: (attemptId: string) => Promise<void>
      onProgress: (callback: (progress: PostProgress) => void) => () => void
      list: () => Promise<PostRecord[]>
      /** Re-reads posts whose status can still change, a few per call. `force` includes ones refreshed recently. */
      refresh: (force: boolean) => Promise<PostsRefreshResult>
      /** Every post in the Zernio workspace inside a date window (calendar view). */
      calendar: (from: string, to: string) => Promise<CalendarResult>
      cancel: (postId: string) => Promise<PostRecord[]>
      reschedule: (postId: string, scheduledFor: string, timezone: string) => Promise<PostRecord[]>
      /** Edits the title, caption and accounts of a still-scheduled post. The video never changes. */
      edit: (postId: string, patch: { title: string; content: string; targets: { platform: string; accountId: string }[] }) => Promise<PostRecord[]>
      retry: (postId: string) => Promise<PostRecord[]>
      dismiss: (postId: string) => Promise<PostRecord[]>
      open: (postId: string, targetIndex: number) => Promise<void>
      /** Opens a calendar post's public link, validated against the platform's site. */
      openCalendarLink: (platform: string, url: string) => Promise<void>
      openTikTokLegal: (key: TikTokLegalLink) => Promise<void>
    }
    /** Read-only workspace analytics; Zernio problems arrive as an error field, never a rejection. */
    analytics: {
      /** Dashboard totals, followers, daily series and top posts for a UTC day window. */
      dashboard: (from: string, to: string) => Promise<DashboardResult>
      /** Average engagement per weekday/UTC-hour slot, over the workspace's whole history. */
      bestTime: () => Promise<BestTimeResult>
    }
  }
  job: {
    /** Queues a clipping run; it starts right away when a slot is free (`queued: false`). */
    start: (config: ClipJobRequest) => Promise<{ jobId?: string; queued?: boolean; job?: JobSnapshot; error?: string }>
    cancel: (jobId: string) => Promise<boolean>
    /** Every job the main process knows about this session, newest first. */
    list: () => Promise<JobSnapshot[]>
    /** Forget a finished job for this session; its run folder stays in the library. */
    dismiss: (jobId: string) => Promise<boolean>
    /** Delete a run's whole folder from disk, whether it finished or not. */
    deleteRun: (outputDir: string) => Promise<void>
    /** A fresh snapshot each time any job changes. */
    onUpdate: (callback: (job: JobSnapshot) => void) => () => void
  }
  history: {
    setFavorite: (outputDir: string, favorite: boolean) => Promise<boolean>
    delete: (outputDir: string) => Promise<void>
    deleteClips: (outputDir: string, indices: number[]) => Promise<JobOutput>
    /** Copies each clip's render (+ .srt) to a fresh index and clones its editor candidate. */
    duplicateClips: (outputDir: string, indices: number[]) => Promise<JobOutput>
    /** The clip's canonical cover (frame time or uploaded image), or null for the auto cover. */
    thumbnail: (outputDir: string, clipIndex: number) => Promise<{ kind: 'frame' | 'image'; atMs?: number; file?: string } | null>
    setThumbnail: (outputDir: string, clipIndex: number, thumb: { kind: 'frame'; atMs: number } | { kind: 'image'; path: string } | null) => Promise<{ kind: 'frame' | 'image'; atMs?: number; file?: string } | null>
    postingStatus: (outputDir: string) => Promise<LibraryClipPostingStatus[]>
    /** Posted counts for many runs at once, for the Library list. */
    postingSummary: (outputDirs: string[]) => Promise<LibraryRunPostingCounts[]>
    setPosted: (outputDir: string, clipIndex: number, posted: boolean) => Promise<boolean>
    metadataSource: (outputDir: string, clipIndex: number) => Promise<AutomationSourceContext | null>
    enhanceMetadata: (outputDir: string, clipIndex: number, options: LibraryEnhancementOptions) => Promise<MetadataEnhancement>
    list: () => Promise<HistoryEntry[]>
    getJob: (outputDir: string) => Promise<Record<string, unknown> | null>
  }
  thumbnails: {
    generate: (videoPath: string, seekSeconds?: number) => Promise<string | null>
  }
  shell: {
    /** Opens a local path with its default app, or an http(s) URL in the browser. */
    openPath: (path: string) => Promise<boolean>
    showItemInFolder: (path: string) => Promise<boolean>
  }
  dialog: {
    selectVideo: () => Promise<string | null>
    /** Absolute path of a picked logo image for a brand pack; main copies it into the pack's folder. */
    selectImage: () => Promise<string | null>
    selectSrt: () => Promise<string | null>
    /** The absolute path of a file the user actually dropped, authorized for posting; null for anything else. */
    authorizeDrop: (file: File) => Promise<string | null>
  }
  clips: {
    bulkExport: (clips: { path: string; name: string }[]) => Promise<{ success: boolean; count: number; failedCount: number; destDir?: string; failures?: string[] }>
    /** Live per-clip progress (clips:bulkExportProgress) while a bulk export copies files. */
    onBulkExportProgress: (cb: (progress: BulkExportProgress) => void) => () => void
    exportFcpXml: (outputDir: string, clipIndices?: number[] | null) => Promise<{ success: boolean; canceled?: boolean; fileName?: string; destDir?: string; clipCount?: number; failedCount?: number; srtCount?: number }>
  }
  system: {
    isPackaged: () => Promise<boolean>
    checkTools: () => Promise<ToolStatus>
  }
  diagnostics: {
    getLogPath: () => Promise<string>
    openLogFolder: () => Promise<boolean>
  }
  update: {
    getState: () => Promise<UpdateState>
    /** Every change to the update state, from background checks too. */
    onState: (cb: (state: UpdateState) => void) => () => void
    /** Help → Check for Updates… asks the window to show the Updates row. */
    onShow: (cb: () => void) => () => void
    /** Check now; resolves with the state once the check finishes. */
    check: () => Promise<UpdateState>
    /** Quit and install the downloaded update, then reopen BridgeClip. */
    install: () => Promise<boolean>
    /** macOS: move the app out of the disk image or Downloads so it can update. */
    moveToApplications: () => Promise<boolean>
    /** The GitHub release page for the new version (or this one). */
    openReleaseNotes: () => Promise<boolean>
  }
  changelog: {
    /** Help → Changelog asks the window to show the changelog. */
    onShow: (cb: () => void) => () => void
  }
}

function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: BridgeClipAPI = {
  source: { youtubePreview: (url, details = false) => ipcRenderer.invoke('source:youtubePreview', url, details) },
  editor: {
    open: (path) => ipcRenderer.invoke('editor:open', path),
    createProject: (path, mediaPath, focusClipIndex, allowDownload) =>
      ipcRenderer.invoke('editor:createProject', path, mediaPath, focusClipIndex, allowDownload),
    save: (path, revision, edits, speakerNames) => ipcRenderer.invoke('editor:save', path, revision, edits, speakerNames),
    addAsset: (path, kind) => ipcRenderer.invoke('editor:addAsset', path, kind),
    addAssetDropped: (path, file) => ipcRenderer.invoke('editor:addAssetDropped', path, file),
    importAudio: (path, source) => ipcRenderer.invoke('editor:importAudio', path, source),
    audioList: () => ipcRenderer.invoke('audioLibrary:list'),
    audioAttach: (path, id) => ipcRenderer.invoke('audioLibrary:attach', path, id),
    audioRemove: (id) => ipcRenderer.invoke('audioLibrary:remove', id),
    motionPlan: (request) => ipcRenderer.invoke('editor:motionPlan', request),
    motionRender: (path, plan, audioAsset) => ipcRenderer.invoke('editor:motionRender', path, plan, audioAsset),
    run: (path, revision, id, action, subject) => ipcRenderer.invoke('editor:run', path, revision, id, action, subject),
    cancel: (path) => ipcRenderer.invoke('editor:cancel', path),
    aiHook: (path, candidateId) => ipcRenderer.invoke('editor:aiHook', path, candidateId),
    titleStyle: (input) => ipcRenderer.invoke('editor:titleStyle', input),
    aiEnhance: (path, candidateId) => ipcRenderer.invoke('editor:aiEnhance', path, candidateId),
    aiBadTakes: (path, candidateId) => ipcRenderer.invoke('editor:aiBadTakes', path, candidateId),
    voiceVoices: (path) => ipcRenderer.invoke('editor:voiceVoices', path),
    voicePreview: (path, config) => ipcRenderer.invoke('editor:voicePreview', path, config),
    replaceSource: (path, revision, replacement) => ipcRenderer.invoke('editor:replaceSource', path, revision, replacement),
    progress: (path) => ipcRenderer.invoke('editor:progress', path),
    operationProgress: (path) => ipcRenderer.invoke('editor:operationProgress', path),
    waveform: (path) => ipcRenderer.invoke('editor:waveform', path),
    freeMedia: (path, revision) => ipcRenderer.invoke('editor:freeMedia', path, revision),
    onSaveBeforeClose: (callback) => subscribe<void>('editor:saveBeforeClose', () => callback()),
    closeReady: (saved) => ipcRenderer.invoke('editor:closeReady', saved)
  },
  edits: { inspect: (outputDir) => ipcRenderer.invoke('edits:inspect', outputDir) },
  models: { list: (refresh = false) => ipcRenderer.invoke('models:list', refresh) },
  localai: {
    status: () => ipcRenderer.invoke('localai:status'),
    setup: () => ipcRenderer.invoke('localai:setup'),
    cancel: () => ipcRenderer.invoke('localai:cancel'),
    onProgress: (callback) => subscribe('localai:progress', callback)
  },
  automations: {
    reviewContent: (id, contentId, returnToQueue) => ipcRenderer.invoke('automations:reviewContent', id, contentId, returnToQueue),
    acknowledgeWarnings: (id, contentId) => ipcRenderer.invoke('automations:acknowledgeWarnings', id, contentId),
    dismissMetadataError: (id, contentId) => ipcRenderer.invoke('automations:dismissMetadataError', id, contentId),
    libraryClip: (id, contentId) => ipcRenderer.invoke('automations:libraryClip', id, contentId),
    showInFolder: (id, contentId) => ipcRenderer.invoke('automations:showInFolder', id, contentId),
    reorder: (id, contentId, beforeId) => ipcRenderer.invoke('automations:reorder', id, contentId, beforeId),
    enhancementGroups: (id) => ipcRenderer.invoke('automations:enhancementGroups', id),
    enhanceBatch: (id, contentIds, key, guidance) => ipcRenderer.invoke('automations:enhanceBatch', id, contentIds, key, guidance),
    source: (id, contentId) => ipcRenderer.invoke('automations:source', id, contentId),
    enhance: (id, contentId, options) => ipcRenderer.invoke('automations:enhance', id, contentId, options),
    resolveDraft: (id, contentId, draftId, apply) => ipcRenderer.invoke('automations:resolveDraft', id, contentId, draftId, apply),
    list: () => ipcRenderer.invoke('automations:list'),
    create: (name) => ipcRenderer.invoke('automations:create', name),
    update: (id, update) => ipcRenderer.invoke('automations:update', id, update),
    delete: (id) => ipcRenderer.invoke('automations:delete', id),
    retryContent: (id, contentId) => ipcRenderer.invoke('automations:retryContent', id, contentId),
    run: (id) => ipcRenderer.invoke('automations:run', id),
    addContent: (id) => ipcRenderer.invoke('automations:addContent', id),
    addLibraryClips: (id, outputDir, clipIndices) => ipcRenderer.invoke('automations:addLibraryClips', id, outputDir, clipIndices),
    updateContent: (id, contentId, update) => ipcRenderer.invoke('automations:updateContent', id, contentId, update),
    prepareTikTokReview: (id, contentId) => ipcRenderer.invoke('automations:prepareTikTokReview', id, contentId),
    approveTikTokReview: (id, contentId, update) => ipcRenderer.invoke('automations:approveTikTokReview', id, contentId, update),
    removeContent: (id, contentId) => ipcRenderer.invoke('automations:removeContent', id, contentId)
  },
  autoImport: {
    status: () => ipcRenderer.invoke('autoImport:status'),
    set: (patch) => ipcRenderer.invoke('autoImport:set', patch),
    pollNow: () => ipcRenderer.invoke('autoImport:pollNow')
  },
  settings: {
    load: () => ipcRenderer.invoke('settings:load'),
    storageUsage: (fresh) => ipcRenderer.invoke('settings:storageUsage', fresh === true),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    addVocabularyTerm: (term) => ipcRenderer.invoke('settings:addVocabularyTerm', term),
    replaceApiKey: (key, value) => ipcRenderer.invoke('settings:replaceApiKey', key, value),
    selectOutputDir: () => ipcRenderer.invoke('settings:selectOutputDir')
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (template, logoPath = null, introPath = null, outroPath = null) => ipcRenderer.invoke('templates:save', template, logoPath, introPath, outroPath),
    delete: (id) => ipcRenderer.invoke('templates:delete', id)
  },
  captionStyles: {
    list: () => ipcRenderer.invoke('captionStyles:list'),
    save: (style) => ipcRenderer.invoke('captionStyles:save', style),
    delete: (id) => ipcRenderer.invoke('captionStyles:delete', id)
  },
  zernio: {
    checkStatus: () => ipcRenderer.invoke('zernio:checkStatus'),
    overview: () => ipcRenderer.invoke('zernio:overview'),
    createProfile: (name) => ipcRenderer.invoke('zernio:profiles:create', name),
    sync: () => ipcRenderer.invoke('zernio:sync'),
    cachedOverview: () => ipcRenderer.invoke('zernio:cachedOverview'),
    pendingConnect: () => ipcRenderer.invoke('zernio:pendingConnect'),
    connect: (platform, profileId, options) => ipcRenderer.invoke('zernio:connect', platform, profileId, options),
    cancelConnect: () => ipcRenderer.invoke('zernio:cancelConnect'),
    disconnect: (accountId) => ipcRenderer.invoke('zernio:disconnect', accountId),
    onConnectResult: (callback) => subscribe('zernio:connectResult', callback),
    onReset: (callback) => subscribe('zernio:reset', callback),
    posts: {
      probe: (clipPath, durationMs) => ipcRenderer.invoke('zernio:posts:probe', clipPath, durationMs),
      sourceVideoLink: (clipPath) => ipcRenderer.invoke('zernio:posts:sourceVideoLink', clipPath),
      tiktokCreatorInfo: (accountId) => ipcRenderer.invoke('zernio:posts:tiktokCreatorInfo', accountId),
      publish: (request) => ipcRenderer.invoke('zernio:posts:publish', request),
      cancelUpload: (attemptId) => ipcRenderer.invoke('zernio:posts:cancelUpload', attemptId),
      onProgress: (callback) => subscribe('zernio:postProgress', callback),
      list: () => ipcRenderer.invoke('zernio:posts:list'),
      refresh: (force) => ipcRenderer.invoke('zernio:posts:refresh', force),
      calendar: (from, to) => ipcRenderer.invoke('zernio:posts:calendar', from, to),
      cancel: (postId) => ipcRenderer.invoke('zernio:posts:cancel', postId),
      reschedule: (postId, scheduledFor, timezone) => ipcRenderer.invoke('zernio:posts:reschedule', postId, scheduledFor, timezone),
      edit: (postId, patch) => ipcRenderer.invoke('zernio:posts:edit', postId, patch),
      retry: (postId) => ipcRenderer.invoke('zernio:posts:retry', postId),
      dismiss: (postId) => ipcRenderer.invoke('zernio:posts:dismiss', postId),
      open: (postId, targetIndex) => ipcRenderer.invoke('zernio:posts:open', postId, targetIndex),
      openCalendarLink: (platform, url) => ipcRenderer.invoke('zernio:posts:openCalendarLink', platform, url),
      openTikTokLegal: (key) => ipcRenderer.invoke('zernio:posts:openTikTokLegal', key)
    },
    analytics: {
      dashboard: (from, to) => ipcRenderer.invoke('zernio:analytics:dashboard', from, to),
      bestTime: () => ipcRenderer.invoke('zernio:analytics:bestTime')
    }
  },
  job: {
    start: (config) => ipcRenderer.invoke('job:start', config),
    cancel: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
    list: () => ipcRenderer.invoke('jobs:list'),
    dismiss: (jobId) => ipcRenderer.invoke('jobs:dismiss', jobId),
    deleteRun: (outputDir) => ipcRenderer.invoke('jobs:deleteRun', outputDir),
    onUpdate: (callback) => subscribe('jobs:update', callback)
  },
  history: {
    setFavorite: (outputDir, favorite) => ipcRenderer.invoke('history:setFavorite', outputDir, favorite),
    delete: (outputDir) => ipcRenderer.invoke('history:delete', outputDir),
    deleteClips: (outputDir, indices) => ipcRenderer.invoke('history:deleteClips', outputDir, indices),
    duplicateClips: (outputDir, indices) => ipcRenderer.invoke('history:duplicateClips', outputDir, indices),
    thumbnail: (outputDir, clipIndex) => ipcRenderer.invoke('history:thumbnail', outputDir, clipIndex),
    setThumbnail: (outputDir, clipIndex, thumb) => ipcRenderer.invoke('history:setThumbnail', outputDir, clipIndex, thumb),
    postingStatus: (outputDir) => ipcRenderer.invoke('history:postingStatus', outputDir),
    postingSummary: (outputDirs) => ipcRenderer.invoke('history:postingSummary', outputDirs),
    setPosted: (outputDir, clipIndex, posted) => ipcRenderer.invoke('history:setPosted', outputDir, clipIndex, posted),
    metadataSource: (outputDir, clipIndex) => ipcRenderer.invoke('history:metadataSource', outputDir, clipIndex),
    enhanceMetadata: (outputDir, clipIndex, options) => ipcRenderer.invoke('history:enhanceMetadata', outputDir, clipIndex, options),
    list: () => ipcRenderer.invoke('history:list'),
    getJob: (outputDir) => ipcRenderer.invoke('history:getJob', outputDir)
  },
  thumbnails: {
    generate: (videoPath, seekSeconds) => ipcRenderer.invoke('thumbnails:generate', videoPath, seekSeconds)
  },
  shell: {
    openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
    showItemInFolder: (path) => ipcRenderer.invoke('shell:showItemInFolder', path)
  },
  dialog: {
    selectVideo: () => ipcRenderer.invoke('dialog:selectVideo'),
    selectImage: () => ipcRenderer.invoke('dialog:selectImage'),
    selectSrt: () => ipcRenderer.invoke('dialog:selectSrt'),
    authorizeDrop: (file: File) => {
      const path = webUtils.getPathForFile(file)
      return path ? ipcRenderer.invoke('dialog:authorizeDrop', path) : Promise.resolve(null)
    }
  },
  clips: {
    bulkExport: (clips) => ipcRenderer.invoke('clips:bulkExport', clips),
    onBulkExportProgress: (cb) => subscribe('clips:bulkExportProgress', cb),
    exportFcpXml: (outputDir, clipIndices) => ipcRenderer.invoke('clips:exportFcpXml', outputDir, clipIndices ?? null)
  },
  system: {
    isPackaged: () => ipcRenderer.invoke('system:isPackaged'),
    checkTools: () => ipcRenderer.invoke('system:checkTools')
  },
  diagnostics: {
    getLogPath: () => ipcRenderer.invoke('diagnostics:getLogPath'),
    openLogFolder: () => ipcRenderer.invoke('diagnostics:openLogFolder')
  },
  update: {
    getState: () => ipcRenderer.invoke('update:getState'),
    onState: (callback) => subscribe('update:state', callback),
    onShow: (callback) => subscribe('update:show', () => callback()),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    moveToApplications: () => ipcRenderer.invoke('update:moveToApplications'),
    openReleaseNotes: () => ipcRenderer.invoke('update:openReleaseNotes')
  },
  changelog: {
    onShow: (callback) => subscribe('changelog:show', () => callback())
  }
}

contextBridge.exposeInMainWorld('bridgeclip', api)
