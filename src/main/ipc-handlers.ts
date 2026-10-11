import { openEditor, saveEditor, runEditor, cancelEditor, createEditorProject, replaceEditorSource, addEditorAsset, assetKinds, importEditorAudio, attachEditorAudio, listEditorVoices, previewEditorVoiceover, renderMotionClip } from './clip-editor'
import { listAudioLibrary, removeAudioTrack } from './audio-library'
import { planMotionShots } from './motion-studio'
import { editorCloseReady, editorOperationProgress, editorWaveform, freeEditorMedia, readEditorProgress } from './clip-editor'
import { generateEditorHook, generateEditorEnhance, detectBadTakes, generateTitleByStyle, type TitleStyle } from './editor-ai'
import { exportRunFcpXml } from './export-fcpxml'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, lstatSync, realpathSync } from 'fs'
import { extname, isAbsolute } from 'path'
import { addVocabularyTerm, loadSettings, publicSettings, replaceApiKey, savePublicSettings, type ApiKeyName, type PublicSettings } from './settings-store'
import { autoImportStatus, initAutoImport, pollAutoImport } from './auto-import'
import { ensureOutputDir, getJobHistory, getJobOutput, generateThumbnail } from './file-manager'
import { measureOutputStorage } from './output-storage'
import { inspectEdits } from './edit-inspector'
import {
  getEnginePath,
  getBridgeRunnerPath,
  resolvePythonPath,
  validatePython,
  preflightCheck,
  type ClipJobConfig
} from './pipeline-runner'
import { createRunRecord, finishRunRecord } from './run-history'
import { cancelTrackedJob, dismissJob, enqueueJob, initJobManager, listJobs, liveJobIds } from './job-manager'
import { logger, getLogFilePath } from './logger'
import { assertAbsolutePath, assertMediaPath, assertTrustedSender, authorizeMedia, isTrustedExternalUrl, isWebUrl, isWithinDirectory, openAuthorizedMedia } from './security'
import { assertPublicWebUrl } from './network-policy'
import { validateJobConfig } from './validation'
import { deleteTemplate, listTemplates, saveTemplate } from './templates-store'
import { deleteCaptionStyle, listCaptionStyles, saveCaptionStyle } from './caption-styles-store'
import { applyTemplateSnapshot } from './template-resolve'
import { getModelCatalog, resolveAdvancedModels } from './openrouter-models'
import { cancelLocalAiSetup, ensureOllamaRunning, getLocalAiStatus, setupLocalAi } from './local-ai'
import { getYouTubePreview } from './youtube-preview'
import { randomUUID } from 'crypto'
import { resolveBinary, supportsCaptionFilter } from './tools'
import { automationEnhancementGroups, enhanceAutomationBatch, automationContentSource, enhanceAutomationContent, resolveAutomationMetadataDraft, addAutomationContent, addLibraryClipsToAutomation, createAutomation, deleteAutomation, isAutomationMedia, listAutomations, removeAutomationContent, runAutomation, updateAutomation, updateAutomationContent, approveAutomationTikTokReview, prepareAutomationTikTokReview } from './automations'
import { acknowledgeAutomationWarnings, retryAutomationContent, dismissAutomationMetadataError, automationLibraryClip, reorderAutomationContent, reviewAutomationContent, showAutomationContentInFolder } from './automations'
import { libraryPostingStatus, libraryMetadataSource, enhanceLibraryMetadata } from './library-posting'
import { libraryPostingSummary } from './library-posting'
import { clipThumbnail, deleteJobRun, deleteClipArtifacts, duplicateClipArtifacts, deleteLibraryRun, setClipThumbnail, setLibraryFavorite, setLibraryPosted } from './library-management'
import {
  cancelZernioConnect,
  connectZernioAccount,
  createZernioProfile,
  disconnectZernioAccount,
  getPendingZernioConnect,
  getZernioOverview,
  readCachedOverview,
  resetZernioState,
  syncZernioAccounts,
  checkZernioStatus
} from './zernio/service'
import { analyticsBestTime, analyticsDashboard } from './zernio/analytics'
import {
  calendarPosts,
  cancelPost,
  cancelUpload,
  dismissPost,
  editScheduledPost,
  getTikTokCreatorInfo,
  listPosts,
  openCalendarPostLink,
  openPostLink,
  openTikTokLegal,
  probeClipForPosting,
  sourceVideoLinkFor,
  publishClip,
  refreshPosts,
  reschedulePost,
  retryPost
} from './zernio/posts'

/** A passing engine check is reused briefly, so queuing several videos stays quick. */
const ENGINE_CHECK_TTL_MS = 5 * 60 * 1000

export function registerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  const selectedOutputDirectories = new Set<string>()
  let lastEngineCheck: { key: string; at: number } | null = null
  initJobManager(getMainWindow)
  const handle: typeof ipcMain.handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event, getMainWindow())
    return listener(event, ...args)
  })
  handle('settings:load', () => {
    return publicSettings(loadSettings())
  })
  handle('settings:storageUsage', (_event, fresh: unknown = false) => measureOutputStorage(loadSettings().outputDirectory, { fresh: fresh === true }))
  handle('models:list', (_event, refresh: unknown = false) => getModelCatalog(refresh))
  handle('source:youtubePreview', (_event, source: unknown, details: unknown = false) => getYouTubePreview(source, details))

  // Offline AI backend: readiness checks and one-click deployment.
  handle('localai:status', async () => {
    const settings = loadSettings()
    const pythonPath = resolvePythonPath(getEnginePath(), settings.pythonPath)
    return getLocalAiStatus(settings, pythonPath)
  })
  handle('localai:setup', (event) => setupLocalAi(loadSettings(), (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('localai:progress', progress)
  }))
  handle('localai:cancel', () => {
    cancelLocalAiSetup()
    return true
  })

  /** Brand Vocabulary: one proper noun from the editor's transcript, merged into the saved terms. */
  handle('settings:addVocabularyTerm', (_event, term: unknown) => addVocabularyTerm(term))
  handle('settings:save', (_event, settings: PublicSettings) => {
    const current = loadSettings()
    if (!settings || typeof settings !== 'object') throw new Error('Invalid settings')
    if (typeof settings.outputDirectory !== 'string' || typeof settings.pythonPath !== 'string' || typeof settings.customVocabulary !== 'string') throw new Error('Invalid settings')
    if (settings.outputDirectory !== current.outputDirectory && !selectedOutputDirectories.has(settings.outputDirectory)) throw new Error('Choose the output folder with the folder picker')
    if (app.isPackaged && settings.pythonPath !== current.pythonPath) throw new Error('Runtime paths cannot be changed in packaged builds')
    return savePublicSettings(settings)
  })

  // Brand templates: read-only built-ins plus the user's saved packs.
  handle('templates:list', () => listTemplates())
  handle('templates:save', (_event, template: unknown, logoPath: unknown = null, introPath: unknown = null, outroPath: unknown = null) => saveTemplate(template, logoPath, introPath, outroPath))
  handle('templates:delete', (_event, id: unknown) => deleteTemplate(id))

  // Saved caption styles: named customisation over an engine preset.
  handle('captionStyles:list', () => listCaptionStyles())
  handle('captionStyles:save', (_event, style: unknown) => saveCaptionStyle(style))
  handle('captionStyles:delete', (_event, id: unknown) => deleteCaptionStyle(id))

  handle('settings:replaceApiKey', (_event, key: ApiKeyName, value: string) => {
    const previousZernioKey = key === 'zernioApiKey' ? loadSettings().zernioApiKey : null
    const saved = replaceApiKey(key, value)
    // A different Zernio key may be a different workspace; drop the old one's accounts.
    if (previousZernioKey !== null && loadSettings().zernioApiKey !== previousZernioKey) resetZernioState(getMainWindow)
    return saved
  })

  // Social accounts via the user's own Zernio key (main process only).
  handle('zernio:overview', () => getZernioOverview())
  handle('zernio:profiles:create', (_event, name: unknown) => createZernioProfile(name))
  handle('zernio:sync', () => syncZernioAccounts())
  handle('zernio:checkStatus', () => checkZernioStatus())
  handle('zernio:cachedOverview', () => readCachedOverview())
  handle('zernio:pendingConnect', () => getPendingZernioConnect())
  handle('zernio:connect', (_event, platform: unknown, profileId: unknown, options: unknown) => connectZernioAccount(platform, profileId, options, getMainWindow))
  handle('zernio:cancelConnect', () => cancelZernioConnect())
  handle('zernio:disconnect', (_event, accountId: unknown) => disconnectZernioAccount(accountId))

  // Posting clips through Zernio. Uploads and post links stay in the main process.
  handle('zernio:posts:probe', (_event, clipPath: unknown, durationMs: unknown) => probeClipForPosting(clipPath, durationMs))
  /** Whether the clip's run has a source video link (drives the YouTube "full video link" checkbox). */
  handle('zernio:posts:sourceVideoLink', (_event, clipPath: unknown) => sourceVideoLinkFor(clipPath))
  handle('zernio:posts:tiktokCreatorInfo', (_event, accountId: unknown) => getTikTokCreatorInfo(accountId))
  handle('zernio:posts:publish', (event, request: unknown) => publishClip(request, (progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('zernio:postProgress', progress)
  }))
  handle('zernio:posts:cancelUpload', (_event, attemptId: unknown) => cancelUpload(attemptId))
  handle('zernio:posts:list', () => listPosts())
  handle('zernio:posts:calendar', (_event, from: unknown, to: unknown) => calendarPosts(from, to))
  handle('zernio:posts:openCalendarLink', (_event, platform: unknown, url: unknown) => openCalendarPostLink(platform, url))
  handle('zernio:posts:refresh', (_event, force: unknown) => refreshPosts(force))
  handle('zernio:posts:cancel', (_event, postId: unknown) => cancelPost(postId))
  handle('zernio:posts:reschedule', (_event, postId: unknown, scheduledFor: unknown, timezone: unknown) => reschedulePost(postId, scheduledFor, timezone))
  handle('zernio:posts:edit', (_event, postId: unknown, patch: unknown) => editScheduledPost(postId, patch))
  handle('zernio:posts:retry', (_event, postId: unknown) => retryPost(postId))
  handle('zernio:posts:dismiss', (_event, postId: unknown) => dismissPost(postId))
  handle('zernio:posts:open', (_event, postId: unknown, targetIndex: unknown) => openPostLink(postId, targetIndex))
  handle('zernio:posts:openTikTokLegal', (_event, key: unknown) => openTikTokLegal(key))

  // Read-only Zernio analytics for the Analytics page.
  handle('zernio:analytics:dashboard', (_event, from: unknown, to: unknown) => analyticsDashboard(from, to))
  handle('zernio:analytics:bestTime', () => analyticsBestTime())

  handle('automations:enhancementGroups', (_event, id: unknown) => automationEnhancementGroups(id))
  handle('automations:enhanceBatch', (_event, id: unknown, ids: unknown, key: unknown, guidance: unknown) => enhanceAutomationBatch(id, ids, key, guidance))
  handle('automations:source', (_event, id: unknown, contentId: unknown) => automationContentSource(id, contentId))
  handle('automations:enhance', (_event, id: unknown, contentId: unknown, options: unknown) => enhanceAutomationContent(id, contentId, options))
  handle('automations:resolveDraft', (_event, id: unknown, contentId: unknown, draftId: unknown, apply: unknown) => resolveAutomationMetadataDraft(id, contentId, draftId, apply))
  handle('automations:list', () => listAutomations())
  handle('automations:acknowledgeWarnings', (_event, id: unknown, contentId: unknown) => acknowledgeAutomationWarnings(id, contentId))
  handle('automations:dismissMetadataError', (_event, id: unknown, contentId: unknown) => dismissAutomationMetadataError(id, contentId))
  handle('automations:reviewContent', (_event, id: unknown, contentId: unknown, returnToQueue: unknown) => reviewAutomationContent(id, contentId, returnToQueue))
  handle('automations:libraryClip', (_event, id: unknown, contentId: unknown) => automationLibraryClip(id, contentId))
  handle('automations:showInFolder', (_event, id: unknown, contentId: unknown) => showAutomationContentInFolder(id, contentId))
  handle('automations:reorder', (_event, id: unknown, contentId: unknown, beforeId: unknown) => reorderAutomationContent(id, contentId, beforeId))
  handle('automations:create', (_event, name: unknown) => createAutomation(name))
  handle('automations:update', (_event, id: unknown, update: unknown) => updateAutomation(id, update))
  handle('automations:delete', (_event, id: unknown) => deleteAutomation(id))
  handle('automations:retryContent', (_event, id: unknown, contentId: unknown) => retryAutomationContent(id, contentId))
  handle('automations:run', (_event, id: unknown) => runAutomation(id))
  handle('automations:addLibraryClips', (_event, id: unknown, outputDir: unknown, clipIndices: unknown) => addLibraryClipsToAutomation(id, outputDir, clipIndices))
  handle('automations:updateContent', (_event, id: unknown, contentId: unknown, update: unknown) => updateAutomationContent(id, contentId, update))
  handle('automations:prepareTikTokReview', (_event, id: unknown, contentId: unknown) => prepareAutomationTikTokReview(id, contentId))
  handle('automations:approveTikTokReview', (_event, id: unknown, contentId: unknown, update: unknown) => approveAutomationTikTokReview(id, contentId, update))
  handle('automations:removeContent', (_event, id: unknown, contentId: unknown) => removeAutomationContent(id, contentId))
  handle('automations:addContent', async (_event, id: unknown) => {
    const window = getMainWindow()
    if (!window) return listAutomations()
    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile', 'multiSelections'],
      title: 'Add clips to automation',
      filters: [{ name: 'Postable videos', extensions: ['mp4', 'mov', 'm4v', 'webm'] }]
    })
    if (result.canceled) return listAutomations()
    for (const path of result.filePaths) authorizeMedia(path)
    return addAutomationContent(id, result.filePaths)
  })

  handle('settings:selectOutputDir', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Output Folder'
    })

    if (result.canceled || result.filePaths.length === 0) return null
    selectedOutputDirectories.add(result.filePaths[0])
    return result.filePaths[0]
  })

  handle('job:start', async (_event, config: ClipJobConfig) => {
    const window = getMainWindow()
    if (!window) {
      logger.warn('job.start.noWindow')
      return { error: 'No window' }
    }

    try {
      config = validateJobConfig(config)
      // Brand-template snapshot: materialize the pack, then revalidate the run.
      config = applyTemplateSnapshot(config)
      // The Advanced-mode catalog is OpenRouter's; the other backends serve
      // their own models and would also fail the catalog fetch.
      if (config.clippingMode === 'advanced' && loadSettings().aiProvider === 'cloud') {
        config.plannerCapabilities = await resolveAdvancedModels(config.plannerModel!, config.transcriptionModel!)
      }
      if (isWebUrl(config.videoUrl)) await assertPublicWebUrl(config.videoUrl)
      else assertMediaPath(config.videoUrl, loadSettings().outputDirectory)
      if (config.bannerChannelUrl) await assertPublicWebUrl(config.bannerChannelUrl)
      if (config.srtPath !== undefined) {
        if (typeof config.srtPath !== 'string' || !isAbsolute(config.srtPath) || config.srtPath.includes('\0') ||
            extname(config.srtPath).toLowerCase() !== '.srt') throw new Error('Choose a valid .srt subtitle file')
        const srtStat = lstatSync(config.srtPath)
        if (!srtStat.isFile() || srtStat.isSymbolicLink() || srtStat.size > 5 * 1024 * 1024) throw new Error('The .srt file could not be read (5 MB limit).')
      }
    } catch (error) { return { error: error instanceof Error ? error.message : 'Invalid job options' } }
    const settings = loadSettings()

    if (settings.aiProvider === 'local') {
      // Offline mode: no cloud key needed, but the local stack must be ready.
      // The managed runtime is auto-started here, so a reboot needs no click.
      await ensureOllamaRunning(settings.localLlmBaseUrl)
      const status = await getLocalAiStatus(settings, resolvePythonPath(getEnginePath(), settings.pythonPath))
      if (!status.whisperRuntime) {
        return { error: 'Offline transcription is not installed yet. Open Settings → Local AI and run the offline setup first.' }
      }
      if (!status.whisperModelReady) {
        return { error: `Whisper ${settings.localWhisperModel} weights are missing. Open Settings → Local AI and run the offline setup first.` }
      }
      if (!status.ollamaRunning) {
        return { error: 'The local AI runtime (Ollama) is not running. Start Ollama or open Settings → Local AI and run the offline setup.' }
      }
      if (!status.plannerReady) {
        return { error: `The local model ${settings.localPlannerModel} is not installed. Open Settings → Local AI and run the offline setup.` }
      }
    } else if (settings.aiProvider === 'nvidia') {
      // Free NVIDIA planning: the key pays for chat, while transcription runs
      // on the local Whisper stack, so only that part must be installed.
      if (!settings.nvidiaApiKey) {
        logger.warn('job.start.missingKey', { key: 'NVIDIA_API_KEY' })
        return { error: 'A NVIDIA API key is required for free cloud planning. Create one at build.nvidia.com and add it in Settings, or choose another provider in Settings → Local AI.' }
      }
      const status = await getLocalAiStatus(settings, resolvePythonPath(getEnginePath(), settings.pythonPath))
      if (!status.whisperRuntime) {
        return { error: 'Free transcription is not installed yet. Open Settings → Local AI and run the offline setup first.' }
      }
      if (!status.whisperModelReady) {
        return { error: `Whisper ${settings.localWhisperModel} weights are missing. Open Settings → Local AI and run the offline setup first.` }
      }
    } else if (!settings.openrouterApiKey) {
      logger.warn('job.start.missingKey', { key: 'OPENROUTER_API_KEY' })
      return { error: 'OpenRouter API key is required for AI clip planning. Go to Settings to add it, or switch to the local offline mode in Settings → Local AI.' }
    }

    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const pythonPath = resolvePythonPath(enginePath, settings.pythonPath)

    const preflight = preflightCheck({ pythonPath, bridgePath, enginePath })
    if (!preflight.ok) {
      const message = preflight.hint
        ? `${preflight.error}\n\n${preflight.hint}`
        : preflight.error!
      logger.error('job.start.preflight.failed', {
        error: preflight.error,
        hint: preflight.hint,
        pythonPath,
        bridgePath,
        enginePath
      })
      return { error: message }
    }
    const engineKey = `${pythonPath}\0${enginePath}`
    if (!lastEngineCheck || lastEngineCheck.key !== engineKey || Date.now() - lastEngineCheck.at > ENGINE_CHECK_TTL_MS) {
      const pythonValidation = await validatePython(pythonPath, enginePath)
      if (!pythonValidation.ok) {
        lastEngineCheck = null
        return { error: 'The clipping engine is incomplete or incompatible. Open Settings → System check, then repair the BridgeClip installation before starting.' }
      }
      lastEngineCheck = { key: engineKey, at: Date.now() }
    }
    if (config.includeCaptions && !(await supportsCaptionFilter())) {
      return { error: 'FFmpeg cannot render captions because its ass filter is missing. Install an FFmpeg build with libass, or turn captions off.' }
    }

    ensureOutputDir(settings.outputDirectory)

    const jobId = randomUUID()
    logger.info('job.start.request', { jobId, sourceType: isWebUrl(config.videoUrl) ? 'remote' : 'local', aspectRatio: config.aspectRatio })
    try {
      createRunRecord(settings.outputDirectory, jobId, config.videoUrl)
    } catch {
      try { finishRunRecord(settings.outputDirectory, jobId, 'failed', 'Could not start this run.') } catch { /* Output folder may be unavailable. */ }
      return { error: 'Could not create the clipping run. Check the output folder and retry.' }
    }
    // Starts now when a slot is free; otherwise waits its turn in the queue.
    const job = enqueueJob(jobId, config, settings.outputDirectory)
    return { jobId, queued: job.status === 'queued', job }
  })

  handle('job:cancel', (_event, jobId: unknown) => {
    if (typeof jobId !== 'string') return false
    logger.info('job.cancel.request', { jobId })
    return cancelTrackedJob(jobId)
  })

  handle('jobs:list', () => listJobs())
  handle('jobs:dismiss', (_event, jobId: unknown) => typeof jobId === 'string' && dismissJob(jobId))
  handle('jobs:deleteRun', (_event, outputDir: unknown) => deleteJobRun(outputDir))

  handle('diagnostics:getLogPath', () => {
    return getLogFilePath()
  })

  handle('diagnostics:openLogFolder', () => {
    const logFile = getLogFilePath()
    if (existsSync(logFile)) {
      shell.showItemInFolder(logFile)
      return true
    }
    return false
  })

  handle('history:list', () => {
    const settings = loadSettings()
    return getJobHistory(settings.outputDirectory, liveJobIds())
  })

  handle('history:postingStatus', (_event, outputDir: unknown) => libraryPostingStatus(outputDir))
  handle('history:postingSummary', (_event, outputDirs: unknown) => libraryPostingSummary(outputDirs))
  handle('history:setPosted', (_event, outputDir: unknown, clipIndex: unknown, posted: unknown) => setLibraryPosted(outputDir, clipIndex, posted))
  handle('history:setFavorite', (_event, outputDir: unknown, favorite: unknown) => setLibraryFavorite(outputDir, favorite))
  handle('history:delete', (_event, outputDir: unknown) => deleteLibraryRun(outputDir))
  handle('history:deleteClips', (_event, outputDir: unknown, indices: unknown) => deleteClipArtifacts(outputDir, indices))
  handle('history:duplicateClips', (_event, outputDir: unknown, indices: unknown) => duplicateClipArtifacts(outputDir, indices))
  /** The clip's canonical cover: frame time or uploaded image, applied to every post of the clip. */
  handle('history:thumbnail', (_event, outputDir: unknown, clipIndex: unknown) => clipThumbnail(outputDir, clipIndex))
  /** Auto Import: status, settings update and a manual poll. */
  handle('autoImport:status', () => autoImportStatus())
  handle('autoImport:set', (_event, patch: unknown) => {
    const request = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
    const current = loadSettings()
    const playlists = typeof request.playlists === 'string' ? request.playlists : current.autoImportPlaylists
    const enabled = typeof request.enabled === 'boolean' ? request.enabled : current.autoImportEnabled
    const interval = typeof request.intervalMinutes === 'number' && Number.isFinite(request.intervalMinutes) && request.intervalMinutes >= 15
      ? Math.min(Math.floor(request.intervalMinutes), 1440) : current.autoImportIntervalMinutes
    return savePublicSettings({ ...current, autoImportPlaylists: playlists, autoImportEnabled: enabled, autoImportIntervalMinutes: interval })
  })
  handle('autoImport:pollNow', async () => {
    const before = autoImportStatus()
    if (!before.config.enabled || !before.config.playlists.length) return { queued: [], errors: ['Auto Import is off or has no playlists.'] }
    return pollAutoImport()
  })
  handle('history:setThumbnail', (_event, outputDir: unknown, clipIndex: unknown, thumb: unknown) => setClipThumbnail(outputDir, clipIndex, thumb))
  handle('history:metadataSource', (_event, outputDir: unknown, clipIndex: unknown) => libraryMetadataSource(outputDir, clipIndex))
  handle('history:enhanceMetadata', (_event, outputDir: unknown, clipIndex: unknown, options: unknown) => enhanceLibraryMetadata(outputDir, clipIndex, options))
  handle('history:getJob', (_event, outputDir: string) => {
    assertAbsolutePath(outputDir)
    if (!isWithinDirectory(outputDir, loadSettings().outputDirectory)) throw new Error('Job is outside the library')
    return getJobOutput(outputDir, loadSettings().outputDirectory)
  })

  handle('editor:open', (_event, path: unknown) => openEditor(path))
  handle('editor:createProject', (_event, path: unknown, mediaPath?: unknown, focusClipIndex?: unknown, allowDownload?: unknown) =>
    createEditorProject(path, mediaPath, focusClipIndex, allowDownload))
  handle('editor:save', (_event, path: unknown, revision: unknown, edits: unknown, speakerNames: unknown) => saveEditor(path, revision, edits, speakerNames))
  handle('editor:addAsset', async (_event, path: unknown, kind: unknown) => {
    const window = getMainWindow()
    if (!window) return null
    const pickers: Record<string, { title: string; filters: { name: string; extensions: string[] }[] }> = {
      image: { title: 'Choose an Image', filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] },
      video: { title: 'Choose a Video', filters: [{ name: 'Video Files', extensions: ['mp4', 'm4v', 'mov', 'mkv', 'webm'] }] },
      audio: { title: 'Choose an Audio Track', filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }] }
    }
    const picker = typeof kind === 'string' ? pickers[kind] : undefined
    if (!picker) throw new Error('Invalid asset kind')
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: picker.title, filters: [...picker.filters, { name: 'All Files', extensions: ['*'] }] })
    if (result.canceled || result.filePaths.length === 0) return null
    return addEditorAsset(path, kind, authorizeMedia(result.filePaths[0]))
  })
  /** Import tab: a dropped media file — main infers image/video/audio from its extension. */
  handle('editor:addAssetDropped', async (_event, path: unknown, file: unknown) => {
    const source = typeof file === 'string' ? authorizeMedia(file) : null
    if (!source) throw new Error('That is not a supported media file.')
    const ext = extname(source).slice(1).toLowerCase()
    const kind = Object.entries(assetKinds).find(([, spec]) => spec.exts.includes(ext))?.[0]
    if (!kind) throw new Error("That file type can't be used here. Choose a png, jpg, webp, mp4, mov, mkv, webm, mp3, wav, m4a, aac, ogg or flac file.")
    return addEditorAsset(path, kind, source)
  })
  /** "Add audio": a dropped file's path, a picked file, or a pasted link — the engine extracts the audio track. */
  handle('editor:importAudio', async (_event, path: unknown, payload: unknown) => {
    const request = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    if (request?.mode === 'link') {
      if (typeof request.url !== 'string') throw new Error('Paste the link to the audio or video')
      return importEditorAudio(path, { kind: 'link', url: request.url })
    }
    if (request?.mode === 'file') {
      let picked: string
      if (typeof request.path === 'string') picked = authorizeMedia(request.path)
      else {
        const window = getMainWindow()
        if (!window) throw new Error('The window is unavailable')
        const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Choose an Audio or Video File',
          filters: [{ name: 'Audio & Video', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'm4v', 'mov', 'webm'] }, { name: 'All Files', extensions: ['*'] }] })
        if (result.canceled || result.filePaths.length === 0) return null
        picked = authorizeMedia(result.filePaths[0])
      }
      return importEditorAudio(path, { kind: 'file', path: picked })
    }
    throw new Error('Invalid audio import')
  })
  handle('audioLibrary:list', () => listAudioLibrary())
  handle('audioLibrary:remove', (_event, id: unknown) => removeAudioTrack(id))
  handle('audioLibrary:attach', (_event, path: unknown, id: unknown) => attachEditorAudio(path, id))
  /** Motion Studio: plan shots for an idea via the configured AI provider. */
  handle('editor:motionPlan', async (_event, payload: unknown) => {
    const request = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    if (!request || typeof request.idea !== 'string' || !Array.isArray(request.references)) throw new Error('Describe the idea first.')
    const references = request.references.flatMap((r) => (r && typeof r === 'object' && typeof (r as { asset?: unknown }).asset === 'string' &&
        /^[a-f0-9]{32}\.[a-z0-9]{2,4}$/.test((r as { asset: string }).asset)
      ? [{ asset: (r as { asset: string }).asset,
           name: typeof (r as { name?: unknown }).name === 'string' ? (r as { name: string }).name : '',
           kind: (r as { kind?: unknown }).kind === 'video' ? 'video' as const : (r as { kind?: unknown }).kind === 'audio' ? 'audio' as const : 'image' as const }]
      : []))
    const style = ['auto', 'clean', 'dynamic', 'cinematic'].includes(request.style as string) ? request.style as 'auto' : 'auto'
    const lengthMs = request.lengthMs === 4000 || request.lengthMs === 8000 ? request.lengthMs : 6000
    return planMotionShots({ idea: request.idea, references, style, lengthMs })
  })
  /** Motion Studio: render a reviewed shot plan with the local generator. */
  handle('editor:motionRender', (_event, path: unknown, plan: unknown, audioAsset: unknown) => renderMotionClip(path, plan, audioAsset))
  handle('editor:run', (_event, path: unknown, revision: unknown, id: unknown, action: unknown, subject: unknown) => runEditor(path, revision, id, action, subject))
  handle('editor:cancel', (_event, path: unknown) => cancelEditor(path))
  /** Editor AI tools: thin wrappers, all prompt building and validation live in editor-ai. */
  handle('editor:titleStyle', async (_event, payload: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    const title = typeof input?.title === 'string' ? input.title : ''
    const caption = typeof input?.caption === 'string' ? input.caption : ''
    const style = input?.style
    if (!title.trim() || style !== 'interesting' && style !== 'catchy' && style !== 'serious' && style !== 'question') throw new Error('Invalid title regeneration request')
    return generateTitleByStyle({ title, caption }, style as TitleStyle)
  })
  handle('editor:aiHook', async (_event, path: unknown, candidateId: unknown) => {
    const { project } = await openEditor(path)
    return generateEditorHook(project, typeof candidateId === 'string' ? candidateId.slice(0, 100) : '')
  })
  handle('editor:aiBadTakes', async (_event, path: unknown, candidateId: unknown) => {
    const { project } = await openEditor(path)
    return detectBadTakes(project, typeof candidateId === 'string' ? candidateId.slice(0, 100) : '')
  })
  handle('editor:aiEnhance', async (_event, path: unknown, candidateId: unknown) => {
    const { project } = await openEditor(path)
    return generateEditorEnhance(project, typeof candidateId === 'string' ? candidateId.slice(0, 100) : '')
  })
  handle('editor:replaceSource', (_event, path: unknown, revision: unknown, replacement: unknown) => replaceEditorSource(path, revision, replacement))
  handle('editor:progress', (_event, path: unknown) => readEditorProgress(path))
  handle('editor:operationProgress', (_event, path: unknown) => editorOperationProgress(path))
  handle('editor:waveform', (_event, path: unknown) => editorWaveform(path))
  handle('editor:freeMedia', (_event, path: unknown, revision: unknown) => freeEditorMedia(path, revision))
  /** Voiceover Studio: installed Windows voices + scratch preview synthesis. */
  handle('editor:voiceVoices', (_event, path: unknown) => listEditorVoices(path))
  handle('editor:voicePreview', (_event, path: unknown, config: unknown) => previewEditorVoiceover(path, config))
  handle('editor:closeReady', (_event, saved: unknown) => editorCloseReady(saved))

  handle('edits:inspect', (_event, outputDir: string) => inspectEdits(outputDir, loadSettings().outputDirectory))

  handle('dialog:selectSrt', async () => {
    const window = getMainWindow()
    if (!window) return null
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], title: 'Choose a Subtitle File', filters: [{ name: 'Subtitles', extensions: ['srt'] }, { name: 'All Files', extensions: ['*'] }] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  handle('thumbnails:generate', async (_event, videoPath: string, seekSeconds?: number) => {
    if (isAutomationMedia(videoPath)) authorizeMedia(videoPath)
    else assertMediaPath(videoPath, loadSettings().outputDirectory)
    if (seekSeconds !== undefined && (!Number.isFinite(seekSeconds) || seekSeconds < 0 || seekSeconds > 6 * 60 * 60)) throw new Error('Invalid thumbnail time')
    const thumbnail = await generateThumbnail(videoPath, seekSeconds)
    if (thumbnail) authorizeMedia(thumbnail)
    return thumbnail
  })

  handle('shell:openPath', async (_event, path: unknown) => {
    if (isWebUrl(path)) {
      if (!isTrustedExternalUrl(path)) throw new Error('This external link is not supported')
      await shell.openExternal(path)
      return true
    }
    assertAbsolutePath(path)
    if (!existsSync(path)) return false
    // Check and open the same canonical name: an alias can hide a .app suffix.
    const canonical = realpathSync(path)
    if (!isWithinDirectory(canonical, loadSettings().outputDirectory)) assertMediaPath(canonical, loadSettings().outputDirectory)
    const { statSync } = await import('fs')
    if (statSync(canonical).isDirectory()) {
      // macOS opens these directory packages with Installer, System Settings,
      // Automator or the bundle itself instead of showing a folder.
      if (canonical.split(/[\\/]+/).some((part) => /\.(app|bundle|pkg|mpkg|prefpane|saver|workflow|action|xpc|appex|plugin|kext|framework|qlgenerator|wdgt)$/i.test(part))) throw new Error('Application bundles cannot be opened from the library')
    } else {
      assertMediaPath(canonical, loadSettings().outputDirectory)
    }
    return (await shell.openPath(canonical)) === ''
  })

  handle('shell:showItemInFolder', (_event, path: string) => {
    assertAbsolutePath(path)
    if (!isWithinDirectory(path, loadSettings().outputDirectory)) assertMediaPath(path, loadSettings().outputDirectory)
    if (!existsSync(path)) return false
    shell.showItemInFolder(path)
    return true
  })

  handle('dialog:selectVideo', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Choose a Video',
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'flv'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return authorizeMedia(result.filePaths[0])
  })

  // Brand-pack logo picker: the templates store re-checks the picked path (real file,
  // image extension, size cap) before copying it into the pack's asset folder.
  handle('dialog:selectImage', async () => {
    const window = getMainWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ['openFile'],
      title: 'Choose a Logo',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // A file dropped on the calendar's upload zone arrives as an absolute path; authorizeMedia
  // rejects anything that isn't a real supported media file, same gate the picker uses.
  handle('dialog:authorizeDrop', (_event, path: unknown) => {
    if (typeof path !== 'string') return null
    try {
      return authorizeMedia(path)
    } catch {
      return null
    }
  })

  handle('clips:bulkExport', async (_event, clips: { path: string; name: string }[]) => {
    const window = getMainWindow()
    if (!Array.isArray(clips) || clips.length > 500) throw new Error('Invalid export selection')
    for (const clip of clips) {
      if (!clip || typeof clip.name !== 'string' || clip.name.length > 500) throw new Error('Invalid export selection')
      assertMediaPath(clip.path, loadSettings().outputDirectory)
    }
    if (!window || clips.length === 0) return { success: false, count: 0, failedCount: clips.length }

    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Export Clips To…'
    })
    if (result.canceled || result.filePaths.length === 0) return { success: false, count: 0, failedCount: 0 }

    const destDir = result.filePaths[0]
    const { rm } = await import('fs/promises')
    const { createWriteStream } = await import('fs')
    const { pipeline } = await import('stream/promises')
    const { Transform } = await import('stream')
    const { extname, join } = await import('path')
    let count = 0
    const failures: string[] = []
    // Live per-clip progress for the Bulk download dialog; integer percent so a
    // big file emits one event per percent, not one per chunk.
    const report = (index: number, name: string, percent: number, status: 'copying' | 'done' | 'failed'): void => {
      window.webContents.send('clips:bulkExportProgress', { total: clips.length, index, name, percent, status })
    }

    for (const [index, clip] of clips.entries()) {
      report(index, clip.name, 0, 'copying')
      const ext = extname(clip.path) || '.mp4'
      const safeName = Array.from(clip.name).filter((char) => char.charCodeAt(0) >= 32).join('').replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'clip'
      let suffix = 0
      try {
        while (true) {
          const dest = join(destDir, `${safeName}${suffix ? ` (${suffix})` : ''}${ext}`)
          // A fresh authorized open per attempt: a pipeline destroyed mid-copy
          // (the name collision surfaces as the write stream's first error)
          // leaves the FileHandle's read state unusable, so retries re-open.
          let source: Awaited<ReturnType<typeof openAuthorizedMedia>> | undefined
          try {
            source = await openAuthorizedMedia(clip.path, loadSettings().outputDirectory)
            const total = source.size
            // The write stream must own its close (autoClose default): a
            // FileHandle write stream with autoClose:false never signals
            // completion to pipeline. Reads stay pinned to the authorized
            // inode via the source handle.
            let copied = 0
            let lastPercent = -1
            const meter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                copied += chunk.length
                const percent = total > 0 ? Math.min(99, Math.floor((copied * 100) / total)) : 100
                if (percent !== lastPercent) {
                  lastPercent = percent
                  report(index, clip.name, percent, 'copying')
                }
                cb(null, chunk)
              }
            })
            await pipeline(source.handle.createReadStream({ autoClose: false }), meter, createWriteStream(dest, { flags: 'wx', mode: 0o600 }))
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              // The name is taken — never touch that file, take the next suffix.
              if (++suffix > 10000) throw error
              continue
            }
            await rm(dest, { force: true }) // A partial copy is ours to remove.
            throw error
          } finally {
            await source?.handle.close()
          }
        }
        count++
        report(index, clip.name, 100, 'done')
      } catch {
        failures.push(clip.name)
        report(index, clip.name, 0, 'failed')
      }
    }

    return { success: count > 0, count, failedCount: clips.length - count, destDir, failures }
  })

  handle('clips:exportFcpXml', async (_event, outputDir: string, clipIndices: unknown) => {
    assertAbsolutePath(outputDir)
    if (!isWithinDirectory(outputDir, loadSettings().outputDirectory)) throw new Error('Invalid run folder')
    if (clipIndices !== null && clipIndices !== undefined &&
        (!Array.isArray(clipIndices) || clipIndices.length > 500 || !clipIndices.every((index) => Number.isSafeInteger(index) && (index as number) >= 0))) {
      throw new Error('Invalid clip selection')
    }
    const indices = Array.isArray(clipIndices) && clipIndices.length > 0 ? (clipIndices as number[]) : null
    return exportRunFcpXml(getMainWindow(), outputDir, indices, loadSettings())
  })

  handle('system:isPackaged', () => {
    return app.isPackaged
  })

  handle('system:checkTools', async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const execFileAsync = promisify(execFile)
    const { join } = await import('path')
    const settings = loadSettings()
    const enginePath = getEnginePath()
    const bridgePath = getBridgeRunnerPath()
    const resolvedPython = resolvePythonPath(enginePath, settings.pythonPath)

    // ffmpeg/ffprobe only accept `-version`; `--version` exits non-zero and
    // made the check report them missing even when installed.
    const check = async (cmd: string, flag = '--version'): Promise<boolean> => {
      try {
        await execFileAsync(cmd, [flag], { timeout: 5000 })
        return true
      } catch {
        return false
      }
    }

    const [pythonValidation, python, ffmpeg, ffmpegCaptions, ffprobe, ytdlp] = await Promise.all([
      validatePython(resolvedPython, enginePath),
      check(resolvedPython),
      check(resolveBinary('ffmpeg'), '-version'),
      supportsCaptionFilter(),
      check(resolveBinary('ffprobe'), '-version'),
      check(resolveBinary('yt-dlp'))
    ])

    const result = {
      python,
      pythonDeps: pythonValidation.ok,
      pythonPath: resolvedPython,
      pythonError: pythonValidation.error,
      pythonHint: pythonValidation.hint,
      pythonRepairCommand: pythonValidation.repairCommand,
      ffmpeg,
      ffmpegCaptions,
      ffprobe,
      ytdlp,
      engine: existsSync(join(enginePath, 'clip_engine', 'bridge_contract.py')),
      enginePath,
      bridgeRunner: existsSync(bridgePath),
      bridgePath
    }
    logger.info('system.checkTools', result)
    return result
  })
}
