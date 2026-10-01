import { JEV_DEFAULTS, JEV_FEATURE_DEFAULTS, type JevThresholdSettings } from '../shared/jev-settings'
import { app, safeStorage } from 'electron'
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { randomUUID } from 'crypto'

/**
 * BridgeClip is bring-your-own-key: every provider call is made from this
 * machine with the user's own keys. Keys are encrypted with the OS keychain
 * (safeStorage) when it is available.
 */
export interface AppSettings extends JevThresholdSettings {
  openrouterApiKey: string
  /** Free cloud planning through NVIDIA's hosted NIM API (build.nvidia.com). */
  nvidiaApiKey: string
  /** Optional: connects social accounts for posting. Used only by the main process, never sent to the engine. */
  zernioApiKey: string
  /** Opt-in beta: Jev review of automatic clips via the existing OpenRouter key. Review & edit always uses Jev. */
  jevEnabled: string
  /** Additional OpenRouter frame observations, explicitly opt-in. */
  jevVisualContext: string
  /** Opt-in beta: web research of public sources before transcription. */
  sourceContextWebResearch: string
  /**
   * 'cloud' routes all AI through OpenRouter with the user's key. 'nvidia'
   * plans and repairs clips with NVIDIA's free NIM API and transcribes with
   * local faster-whisper. 'local' runs everything on this machine; no key and
   * no internet connection needed.
   */
  aiProvider: 'cloud' | 'nvidia' | 'local'
  /** NVIDIA NIM planner slug (build.nvidia.com model id). */
  nvidiaPlannerModel: string
  /** Ollama base URL for the local backend. Loopback only; the engine's network guard enforces it. */
  localLlmBaseUrl: string
  /** Ollama model tag used for planning in local mode. */
  localPlannerModel: string
  /** faster-whisper size used for transcription in local mode. */
  localWhisperModel: string
  /** '' auto-detects; otherwise an ISO 639-1 code like 'ro' or 'en' pins Whisper's language. */
  transcriptionLanguage: string
  outputDirectory: string
  pythonPath: string
  /** Names and jargon the speech-to-text should spell correctly, one per line. */
  customVocabulary: string
}

export type ApiKeyName = 'openrouterApiKey' | 'nvidiaApiKey' | 'zernioApiKey'
export type PublicSettings = Pick<AppSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary' | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch' | 'aiProvider' | 'nvidiaPlannerModel' | 'localLlmBaseUrl' | 'localPlannerModel' | 'localWhisperModel' | 'transcriptionLanguage' | keyof JevThresholdSettings> & {
  openrouterConfigured: boolean
  nvidiaConfigured: boolean
  zernioConfigured: boolean
}

const SECRET_KEYS = ['openrouterApiKey', 'nvidiaApiKey', 'zernioApiKey'] as const
type SecretKey = (typeof SECRET_KEYS)[number]

export const WHISPER_MODEL_OPTIONS = ['large-v3-turbo', 'large-v3', 'medium'] as const

/** Planner models offered for the NVIDIA backend (build.nvidia.com ids). */
export const NVIDIA_MODEL_OPTIONS = [
  { id: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek V3.1' },
  { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B A22B' },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', label: 'Nemotron Super 49B' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1' }
] as const

const DEFAULT_SETTINGS: AppSettings = {
  ...JEV_DEFAULTS,
  ...JEV_FEATURE_DEFAULTS,
  openrouterApiKey: '',
  nvidiaApiKey: '',
  zernioApiKey: '',
  aiProvider: 'cloud',
  nvidiaPlannerModel: 'deepseek-ai/deepseek-v3.1',
  localLlmBaseUrl: 'http://127.0.0.1:11434',
  localPlannerModel: 'qwen3:8b',
  localWhisperModel: 'large-v3-turbo',
  transcriptionLanguage: '',
  outputDirectory: join(app.getPath('home'), 'BridgeClip'),
  pythonPath: process.platform === 'win32' ? 'python' : 'python3',
  customVocabulary: ''
}

const SETTINGS_VERSION = 14
/**
 * Versions 9-11 (pre-release builds of this feature) saved Jev review and web
 * research as on by default, and older versions drop the fields entirely, so a
 * saved "on" before this version is not an opt-in. Those files load both as off.
 */
const OPT_IN_BETA_VERSION = 12
const SWITCHES = ['off', 'on']

type PersistedSecret = { scheme: 'safeStorage' | 'base64'; value: string } | ''

interface PersistedSettings extends JevThresholdSettings {
  version: number
  openrouterApiKey: PersistedSecret
  nvidiaApiKey: PersistedSecret
  zernioApiKey: PersistedSecret
  jevEnabled: string
  jevVisualContext: string
  sourceContextWebResearch: string
  aiProvider?: string
  nvidiaPlannerModel?: string
  localLlmBaseUrl?: string
  localPlannerModel?: string
  localWhisperModel?: string
  transcriptionLanguage?: string
  outputDirectory: string
  pythonPath: string
  customVocabulary?: string
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

function getSettingsPath(): string {
  return join(ensureDir(app.getPath('userData')), 'settings.json')
}

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  if (!settings || typeof settings !== 'object') throw new Error('Invalid settings')
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || settings[key]!.length > 8192 || settings[key]!.includes('\0'))) throw new Error(`Invalid ${key}`)
  }
  const normalized: AppSettings = {
    jevThreshold: settings.jevThreshold ?? JEV_DEFAULTS.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold ?? JEV_DEFAULTS.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold ?? JEV_DEFAULTS.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold ?? JEV_DEFAULTS.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold ?? JEV_DEFAULTS.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold ?? JEV_DEFAULTS.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold ?? JEV_DEFAULTS.jevCutThreshold,

    openrouterApiKey: (settings.openrouterApiKey ?? DEFAULT_SETTINGS.openrouterApiKey).trim(),
    nvidiaApiKey: (settings.nvidiaApiKey ?? DEFAULT_SETTINGS.nvidiaApiKey).trim(),
    zernioApiKey: (settings.zernioApiKey ?? DEFAULT_SETTINGS.zernioApiKey).trim(),
    jevEnabled: settings.jevEnabled ?? DEFAULT_SETTINGS.jevEnabled,
    jevVisualContext: settings.jevVisualContext ?? DEFAULT_SETTINGS.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch ?? DEFAULT_SETTINGS.sourceContextWebResearch,
    aiProvider: settings.aiProvider === 'local' || settings.aiProvider === 'nvidia' ? settings.aiProvider : 'cloud',
    nvidiaPlannerModel: normalizeNvidiaModel(settings.nvidiaPlannerModel),
    localLlmBaseUrl: normalizeLocalBaseUrl(settings.localLlmBaseUrl),
    localPlannerModel: (settings.localPlannerModel ?? DEFAULT_SETTINGS.localPlannerModel).trim() || DEFAULT_SETTINGS.localPlannerModel,
    localWhisperModel: (WHISPER_MODEL_OPTIONS as readonly string[]).includes(settings.localWhisperModel ?? '')
      ? settings.localWhisperModel as AppSettings['localWhisperModel']
      : DEFAULT_SETTINGS.localWhisperModel,
    transcriptionLanguage: normalizeLanguage(settings.transcriptionLanguage),
    outputDirectory: (settings.outputDirectory || DEFAULT_SETTINGS.outputDirectory).trim(),
    pythonPath: (settings.pythonPath || DEFAULT_SETTINGS.pythonPath).trim(),
    customVocabulary: vocabularyTerms(settings.customVocabulary ?? DEFAULT_SETTINGS.customVocabulary).join('\n')
  }
  for (const key of Object.keys(JEV_DEFAULTS) as (keyof JevThresholdSettings)[]) {
    const value = probability(normalized[key])
    if (value === null) throw new Error(`Invalid Jev threshold: ${key}. Use a probability from 0 to 1.`)
    normalized[key] = value
  }
  normalized.outputDirectory ||= DEFAULT_SETTINGS.outputDirectory
  normalized.pythonPath ||= DEFAULT_SETTINGS.pythonPath
  if (!SWITCHES.includes(normalized.jevEnabled)) throw new Error('Invalid Jev review setting')
  if (!SWITCHES.includes(normalized.jevVisualContext)) throw new Error('Invalid visual context setting')
  if (!SWITCHES.includes(normalized.sourceContextWebResearch)) throw new Error('Invalid source research setting')
  if (!isAbsolute(normalized.outputDirectory)) throw new Error('Settings folders must be absolute paths')
  return normalized
}

/** A canonical probability string from 0 to 1, or null. */
function probability(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed) || !Number.isFinite(Number(trimmed)) || Number(trimmed) > 1) return null
  return String(Number(trimmed))
}

/** Loopback http(s) URL for the local AI runtime; anything else falls back. */
function normalizeLocalBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.localLlmBaseUrl
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    const host = url.hostname.toLowerCase()
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return DEFAULT_SETTINGS.localLlmBaseUrl
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_SETTINGS.localLlmBaseUrl
    return `${url.protocol}//${url.host}`
  } catch {
    return DEFAULT_SETTINGS.localLlmBaseUrl
  }
}

/**
 * NVIDIA NIM model slug ("vendor/model") or a curated option id; anything
 * else falls back to the default planner.
 */
function normalizeNvidiaModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.nvidiaPlannerModel
  const trimmed = value.trim()
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i.test(trimmed)) return DEFAULT_SETTINGS.nvidiaPlannerModel
  return trimmed
}

/** '' (auto) or a lowercase ISO 639-1 code; anything else falls back to auto. */
function normalizeLanguage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().toLowerCase()
  return /^[a-z]{2}$/.test(trimmed) ? trimmed : ''
}

/**
 * Saved Jev fields are optional preferences. One unreadable value falls back to
 * its own default instead of making the whole file (and the saved keys) unreadable.
 */
function savedJevSettings(raw: Record<string, unknown>): Pick<AppSettings, keyof JevThresholdSettings | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch'> {
  const thresholds = Object.fromEntries((Object.keys(JEV_DEFAULTS) as (keyof JevThresholdSettings)[])
    .map((key) => [key, probability(raw[key]) ?? JEV_DEFAULTS[key]])) as JevThresholdSettings
  const switchValue = (value: unknown, fallback: string): string => typeof value === 'string' && SWITCHES.includes(value) ? value : fallback
  const optedIn = typeof raw.version === 'number' && raw.version >= OPT_IN_BETA_VERSION
  return {
    ...thresholds,
    jevEnabled: optedIn ? switchValue(raw.jevEnabled, DEFAULT_SETTINGS.jevEnabled) : 'off',
    jevVisualContext: switchValue(raw.jevVisualContext ?? raw.typesafeVisualContext, DEFAULT_SETTINGS.jevVisualContext),
    sourceContextWebResearch: optedIn ? switchValue(raw.sourceContextWebResearch, DEFAULT_SETTINGS.sourceContextWebResearch) : 'off'
  }
}

function canEncrypt(): boolean {
  return app.isReady() && safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
}

function encodeSecret(value: string): PersistedSecret {
  if (!value) return ''
  if (canEncrypt()) {
    return { scheme: 'safeStorage', value: safeStorage.encryptString(value).toString('base64') }
  }
  throw new Error('Secure key storage is unavailable. Unlock or configure your operating system keychain before saving API keys.')
}

/**
 * Decodes a stored secret. Accepts the current `{scheme, value}` shape and the
 * plain base64 strings written by versions <= 0.1.16. `legacy` reports whether
 * the value should be re-encrypted.
 */
function decodeSecret(value: unknown): { value: string; legacy: boolean } {
  if (!value) return { value: '', legacy: false }
  if (typeof value === 'string') {
    if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
    try {
      return { value: Buffer.from(value, 'base64').toString('utf-8'), legacy: true }
    } catch {
      return { value: '', legacy: false }
    }
  }
  if (typeof value === 'object') {
    const obj = value as { scheme?: string; value?: string }
    if (!obj.value) return { value: '', legacy: false }
    try {
      if (obj.scheme === 'safeStorage') {
        if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
        return { value: safeStorage.decryptString(Buffer.from(obj.value, 'base64')), legacy: false }
      }
      if (obj.scheme === 'base64') {
        if (!canEncrypt()) throw new Error('Secure key storage is unavailable')
        return { value: Buffer.from(obj.value, 'base64').toString('utf-8'), legacy: true }
      }
    } catch {
      throw new Error('Could not decrypt saved API keys. Unlock the system keychain and retry.')
    }
  }
  return { value: '', legacy: false }
}

export function loadSettings(): AppSettings {
  const path = getSettingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    let needsMigration = raw.version !== SETTINGS_VERSION || Object.hasOwn(raw, 'elevenLabsApiKey') || Object.hasOwn(raw, 'typesafeApiKey')
    const secrets = {} as Record<SecretKey, string>
    for (const key of SECRET_KEYS) {
      const decoded = decodeSecret(raw[key])
      secrets[key] = decoded.value
      if (decoded.legacy) needsMigration = true
    }

    const settings = normalizeSettings({
      ...secrets,
      ...savedJevSettings(raw),
      aiProvider: typeof raw.aiProvider === 'string' ? raw.aiProvider : DEFAULT_SETTINGS.aiProvider,
      nvidiaPlannerModel: typeof raw.nvidiaPlannerModel === 'string' ? raw.nvidiaPlannerModel : DEFAULT_SETTINGS.nvidiaPlannerModel,
      localLlmBaseUrl: typeof raw.localLlmBaseUrl === 'string' ? raw.localLlmBaseUrl : DEFAULT_SETTINGS.localLlmBaseUrl,
      localPlannerModel: typeof raw.localPlannerModel === 'string' ? raw.localPlannerModel : DEFAULT_SETTINGS.localPlannerModel,
      localWhisperModel: typeof raw.localWhisperModel === 'string' ? raw.localWhisperModel : DEFAULT_SETTINGS.localWhisperModel,
      transcriptionLanguage: typeof raw.transcriptionLanguage === 'string' ? raw.transcriptionLanguage : DEFAULT_SETTINGS.transcriptionLanguage,
      outputDirectory: typeof raw.outputDirectory === 'string' ? raw.outputDirectory : DEFAULT_SETTINGS.outputDirectory,
      pythonPath: typeof raw.pythonPath === 'string' ? raw.pythonPath : DEFAULT_SETTINGS.pythonPath,
      customVocabulary: typeof raw.customVocabulary === 'string' ? raw.customVocabulary : DEFAULT_SETTINGS.customVocabulary
    })

    if (needsMigration && canEncrypt()) writeSettings(settings)
    return settings
  } catch (error) {
    throw new Error('Could not read saved settings. The settings file was kept for recovery.', { cause: error })
  }
}

function writeSettings(settings: AppSettings): void {
  const path = getSettingsPath()
  const tempPath = `${path}.${randomUUID()}.tmp`

  const persisted: PersistedSettings = {
    version: SETTINGS_VERSION,
    jevThreshold: settings.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold,

    openrouterApiKey: encodeSecret(settings.openrouterApiKey),
    nvidiaApiKey: encodeSecret(settings.nvidiaApiKey),
    zernioApiKey: encodeSecret(settings.zernioApiKey),
    jevEnabled: settings.jevEnabled,
    jevVisualContext: settings.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch,
    aiProvider: settings.aiProvider,
    nvidiaPlannerModel: settings.nvidiaPlannerModel,
    localLlmBaseUrl: settings.localLlmBaseUrl,
    localPlannerModel: settings.localPlannerModel,
    localWhisperModel: settings.localWhisperModel,
    transcriptionLanguage: settings.transcriptionLanguage,
    outputDirectory: settings.outputDirectory,
    pythonPath: settings.pythonPath,
    customVocabulary: settings.customVocabulary
  }

  let fd: number | undefined
  try {
    fd = openSync(tempPath, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(persisted, null, 2), { encoding: 'utf-8' })
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

export function saveSettings(settings: AppSettings): AppSettings {
  writeSettings(normalizeSettings(settings))
  return loadSettings()
}

export function publicSettings(settings: AppSettings): PublicSettings {
  return {
    jevThreshold: settings.jevThreshold,
    jevSelfContainedThreshold: settings.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: settings.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: settings.jevTitleSupportedThreshold,
    jevSponsorThreshold: settings.jevSponsorThreshold,
    jevEvidenceThreshold: settings.jevEvidenceThreshold,
    jevCutThreshold: settings.jevCutThreshold,

    outputDirectory: settings.outputDirectory,
    pythonPath: settings.pythonPath,
    customVocabulary: settings.customVocabulary,
    openrouterConfigured: Boolean(settings.openrouterApiKey),
    nvidiaConfigured: Boolean(settings.nvidiaApiKey),
    zernioConfigured: Boolean(settings.zernioApiKey),
    jevEnabled: settings.jevEnabled,
    jevVisualContext: settings.jevVisualContext,
    sourceContextWebResearch: settings.sourceContextWebResearch,
    aiProvider: settings.aiProvider,
    nvidiaPlannerModel: settings.nvidiaPlannerModel,
    localLlmBaseUrl: settings.localLlmBaseUrl,
    localPlannerModel: settings.localPlannerModel,
    localWhisperModel: settings.localWhisperModel,
    transcriptionLanguage: settings.transcriptionLanguage
  }
}

export function savePublicSettings(update: Pick<PublicSettings, 'outputDirectory' | 'pythonPath' | 'customVocabulary' | 'jevEnabled' | 'jevVisualContext' | 'sourceContextWebResearch' | 'aiProvider' | 'nvidiaPlannerModel' | 'localLlmBaseUrl' | 'localPlannerModel' | 'localWhisperModel' | 'transcriptionLanguage' | keyof JevThresholdSettings>): PublicSettings {
  const current = loadSettings()
  return publicSettings(saveSettings({
    ...current,
    jevThreshold: update.jevThreshold ?? current.jevThreshold,
    jevSelfContainedThreshold: update.jevSelfContainedThreshold ?? current.jevSelfContainedThreshold,
    jevFaithfulToSourceThreshold: update.jevFaithfulToSourceThreshold ?? current.jevFaithfulToSourceThreshold,
    jevTitleSupportedThreshold: update.jevTitleSupportedThreshold ?? current.jevTitleSupportedThreshold,
    jevSponsorThreshold: update.jevSponsorThreshold ?? current.jevSponsorThreshold,
    jevEvidenceThreshold: update.jevEvidenceThreshold ?? current.jevEvidenceThreshold,
    jevCutThreshold: update.jevCutThreshold ?? current.jevCutThreshold,
    outputDirectory: update.outputDirectory,
    pythonPath: update.pythonPath,
    customVocabulary: update.customVocabulary,
    jevEnabled: update.jevEnabled ?? current.jevEnabled,
    jevVisualContext: update.jevVisualContext ?? current.jevVisualContext,
    sourceContextWebResearch: update.sourceContextWebResearch ?? current.sourceContextWebResearch,
    aiProvider: update.aiProvider ?? current.aiProvider,
    nvidiaPlannerModel: update.nvidiaPlannerModel ?? current.nvidiaPlannerModel,
    localLlmBaseUrl: update.localLlmBaseUrl ?? current.localLlmBaseUrl,
    localPlannerModel: update.localPlannerModel ?? current.localPlannerModel,
    localWhisperModel: update.localWhisperModel ?? current.localWhisperModel,
    transcriptionLanguage: update.transcriptionLanguage ?? current.transcriptionLanguage
  }))
}

/**
 * Conservative vocabulary hints for MAI Transcribe 2: one term per line or comma,
 * at most five words and 49 characters each, none of <>{}[]\, deduplicated
 * case-insensitively. These application limits keep phrase hints short and bounded.
 */
export function vocabularyTerms(value: string): string[] {
  const terms: string[] = []
  const seen = new Set<string>()
  for (const line of value.split(/[\n,]/)) {
    const term = line.replace(/\s+/g, ' ').trim()
    if (!term || term.length > 49 || term.split(' ').length > 5 || /[<>{}[\]\\]/.test(term)) continue
    const key = term.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= 200) break
  }
  return terms
}

export function replaceApiKey(key: ApiKeyName, value: string): PublicSettings {
  if (!SECRET_KEYS.includes(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error('Invalid API key update')
  const current = loadSettings()
  return publicSettings(saveSettings({ ...current, [key]: value.trim() }))
}

export function getSettingsForBridge(settings: AppSettings): Record<string, string> {
  return {
    OPENROUTER_API_KEY: settings.aiProvider === 'cloud' ? settings.openrouterApiKey : '',
    NVIDIA_API_KEY: settings.aiProvider === 'nvidia' ? settings.nvidiaApiKey : '',
    AI_BACKEND: settings.aiProvider,
    NVIDIA_PLANNER_MODEL: settings.nvidiaPlannerModel,
    LOCAL_LLM_BASE_URL: settings.localLlmBaseUrl,
    LOCAL_PLANNER_MODEL: settings.localPlannerModel,
    LOCAL_WHISPER_MODEL: settings.localWhisperModel,
    TRANSCRIPTION_LANGUAGE: settings.transcriptionLanguage,
    SOURCE_CONTEXT_WEB_RESEARCH: settings.sourceContextWebResearch !== 'off' ? 'true' : 'false',
    JEV_THRESHOLD: settings.jevThreshold,
    JEV_SELF_CONTAINED_THRESHOLD: settings.jevSelfContainedThreshold,
    JEV_FAITHFUL_TO_SOURCE_THRESHOLD: settings.jevFaithfulToSourceThreshold,
    JEV_TITLE_SUPPORTED_THRESHOLD: settings.jevTitleSupportedThreshold,
    JEV_SPONSOR_THRESHOLD: settings.jevSponsorThreshold,
    JEV_EVIDENCE_THRESHOLD: settings.jevEvidenceThreshold,
    JEV_CUT_THRESHOLD: settings.jevCutThreshold,
    JEV_ENABLED: settings.jevEnabled === 'on' ? 'true' : 'false',
    JEV_VISUAL_CONTEXT: settings.jevVisualContext === 'on' ? 'true' : 'false',
    LOCAL_MODE: 'true',
    LOCAL_OUTPUT_DIR: settings.outputDirectory
  }
}
