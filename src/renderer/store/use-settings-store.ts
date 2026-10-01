import { JEV_DEFAULTS, JEV_FEATURE_DEFAULTS } from '../../shared/jev-settings'
import { create } from 'zustand'
import { errorMessage } from '../lib/utils'
import { getApi } from '../lib/ipc'
import type { ClipSettings, ToolStatus } from '../../preload/index'

interface SettingsState extends ClipSettings {
  loaded: boolean
  saving: boolean
  toolStatus: ToolStatus | null
  checkingTools: boolean
  toolError: string | null
  load: () => Promise<void>
  save: (settings: Partial<ClipSettings>) => Promise<void>
  replaceApiKey: (key: 'openrouterApiKey' | 'nvidiaApiKey' | 'zernioApiKey', value: string) => Promise<void>
  checkTools: () => Promise<void>
}

// Queue writes so each partial update merges with the last successful save.
let saveQueue: Promise<void> = Promise.resolve()
let pendingSaves = 0
let latestToolCheck = 0

export const useSettingsStore = create<SettingsState>((set, get) => ({
  openrouterConfigured: false,
  nvidiaConfigured: false,
  zernioConfigured: false,
  ...JEV_DEFAULTS,
  ...JEV_FEATURE_DEFAULTS,
  aiProvider: 'cloud',
  nvidiaPlannerModel: 'deepseek-ai/deepseek-v3.1',
  localLlmBaseUrl: 'http://127.0.0.1:11434',
  localPlannerModel: 'qwen3:8b',
  localWhisperModel: 'large-v3-turbo',
  transcriptionLanguage: '',
  outputDirectory: '',
  pythonPath: 'python3',
  customVocabulary: '',
  loaded: false,
  saving: false,
  toolStatus: null,
  checkingTools: false,
  toolError: null,

  load: async () => {
    const settings = await getApi().settings.load()
    set({ ...pickSettings(settings), loaded: true })
  },

  save: (updates) => {
    const patch = { ...updates }
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const merged: ClipSettings = { ...pickSettings(get()), ...patch }
      const saved = await getApi().settings.save(merged)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  replaceApiKey: (key, value) => {
    pendingSaves += 1
    set({ saving: true })
    const task = saveQueue.then(async () => {
      const saved = await getApi().settings.replaceApiKey(key, value)
      set({ ...pickSettings(saved), loaded: true })
    })
    saveQueue = task.catch(() => {})
    return task.finally(() => {
      pendingSaves -= 1
      set({ saving: pendingSaves > 0 })
    })
  },

  checkTools: async () => {
    const request = ++latestToolCheck
    set({ checkingTools: true, toolError: null })
    try {
      const status = await getApi().system.checkTools()
      if (request === latestToolCheck) set({ toolStatus: status })
    } catch (err) {
      if (request === latestToolCheck) {
        set({ toolStatus: null, toolError: errorMessage(err, 'Could not check required tools. Try again in Settings.') })
      }
    } finally {
      if (request === latestToolCheck) set({ checkingTools: false })
    }
  }
}))

function pickSettings(s: ClipSettings): ClipSettings {
  return {
    jevThreshold: s.jevThreshold ?? JEV_DEFAULTS.jevThreshold,
    jevSelfContainedThreshold: s.jevSelfContainedThreshold ?? JEV_DEFAULTS.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: s.jevFaithfulToSourceThreshold ?? JEV_DEFAULTS.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: s.jevTitleSupportedThreshold ?? JEV_DEFAULTS.jevTitleSupportedThreshold,
    jevSponsorThreshold: s.jevSponsorThreshold ?? JEV_DEFAULTS.jevSponsorThreshold,
    jevEvidenceThreshold: s.jevEvidenceThreshold ?? JEV_DEFAULTS.jevEvidenceThreshold,
    jevCutThreshold: s.jevCutThreshold ?? JEV_DEFAULTS.jevCutThreshold,
    openrouterConfigured: s.openrouterConfigured,
    jevEnabled: s.jevEnabled ?? JEV_FEATURE_DEFAULTS.jevEnabled,
    jevVisualContext: s.jevVisualContext ?? JEV_FEATURE_DEFAULTS.jevVisualContext,
    sourceContextWebResearch: s.sourceContextWebResearch ?? JEV_FEATURE_DEFAULTS.sourceContextWebResearch,
    aiProvider: s.aiProvider ?? 'cloud',
    nvidiaConfigured: s.nvidiaConfigured,
    nvidiaPlannerModel: s.nvidiaPlannerModel ?? 'deepseek-ai/deepseek-v3.1',
    localLlmBaseUrl: s.localLlmBaseUrl ?? 'http://127.0.0.1:11434',
    localPlannerModel: s.localPlannerModel ?? 'qwen3:8b',
    localWhisperModel: s.localWhisperModel ?? 'large-v3-turbo',
    transcriptionLanguage: s.transcriptionLanguage ?? '',
    zernioConfigured: s.zernioConfigured,
    outputDirectory: s.outputDirectory,
    pythonPath: s.pythonPath,
    customVocabulary: s.customVocabulary
  }
}

export type SetupState = { ready: boolean; missingKeys: string[]; toolsOk: boolean | null }

/** Whether a clip job can start: a usable AI provider (a cloud key for the
 *  selected provider, or the offline stack) and, once the system check has
 *  run, every required tool. */
export function useSetupState(): SetupState {
  const openrouter = useSettingsStore((s) => s.openrouterConfigured)
  const nvidia = useSettingsStore((s) => s.aiProvider === 'nvidia')
  const nvidiaConfigured = useSettingsStore((s) => s.nvidiaConfigured)
  const localProvider = useSettingsStore((s) => s.aiProvider === 'local')
  const tools = useSettingsStore((s) => s.toolStatus)
  const toolError = useSettingsStore((s) => s.toolError)
  const checkingTools = useSettingsStore((s) => s.checkingTools)
  const missingKeys = [
    ...(!openrouter && !nvidia && !localProvider ? ['OpenRouter'] : []),
    ...(nvidia && !nvidiaConfigured ? ['NVIDIA'] : [])
  ]
  const toolsOk = toolError ? false : tools
    ? tools.python && tools.pythonDeps && tools.ffmpeg && tools.ffprobe && tools.ytdlp && tools.engine && tools.bridgeRunner
    : null
  return { ready: missingKeys.length === 0 && toolsOk === true && !checkingTools, missingKeys, toolsOk }
}
