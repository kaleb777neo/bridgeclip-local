/**
 * Local AI backend orchestration: status checks and one-click offline setup.
 *
 * The setup deploys everything BridgeClip needs to clip without a paid cloud
 * provider, from Settings → Local AI:
 *   1. faster-whisper (+ CUDA libs) into the engine venv,
 *   2. Whisper weights downloaded to the persistent models folder,
 *   3. an Ollama runtime (portable build, no admin install) when none is
 *      already running, started with a planning-sized context,
 *   4. the configured planner model pulled from the Ollama registry.
 *
 * The NVIDIA backend runs planning in NVIDIA's cloud, so its setup stops
 * after the Whisper steps (NIM has no transcription endpoint).
 */
import { execFile, spawn } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { getEnginePath, resolvePythonPath } from './pipeline-runner'
import type { AppSettings } from './settings-store'
import type { LocalAiProgress, LocalAiStatus } from '../shared/local-ai'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type { LocalAiProgress, LocalAiStatus, LocalAiStepId } from '../shared/local-ai'

const OLLAMA_DOWNLOADS: Record<string, string> = {
  win32: 'https://ollama.com/download/ollama-windows-amd64.zip',
  darwin: 'https://ollama.com/download/ollama-darwin.tgz',
  linux: 'https://ollama.com/download/ollama-linux-amd64.tgz'
}

const WHISPER_REPOS: Record<string, string> = {
  'large-v3-turbo': 'Systran/faster-whisper-large-v3-turbo',
  'large-v3': 'Systran/faster-whisper-large-v3',
  'medium': 'Systran/faster-whisper-medium'
}

/** Persistent model folder shared with the engine (BRIDGECLIP_MODELS_DIR). */
export function modelsDir(): string {
  return join(app.getPath('userData'), 'models')
}

function localAiDir(): string {
  return join(app.getPath('userData'), 'local-ai')
}

function ollamaDir(): string {
  return join(localAiDir(), 'ollama')
}

function ollamaBinary(): string {
  return process.platform === 'win32' ? join(ollamaDir(), 'ollama.exe') : join(ollamaDir(), 'bin', 'ollama')
}

export function localOllamaExists(): boolean {
  return existsSync(ollamaBinary())
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function isOllamaReachable(baseUrl: string): Promise<boolean> {
  try {
    await fetchJson(`${normalizeBaseUrl(baseUrl)}/api/version`, 1500)
    return true
  } catch {
    return false
  }
}

async function listOllamaModels(baseUrl: string): Promise<string[]> {
  const tags = await fetchJson(`${normalizeBaseUrl(baseUrl)}/api/tags`, 2500) as { models?: { name?: string, model?: string }[] }
  return (tags.models ?? []).map(m => m.name || m.model || '').filter(Boolean)
}

async function detectGpu(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'],
      { timeout: 4000, windowsHide: true }
    )
    return stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

function engineEnv(): Record<string, string> {
  return {
    ...process.env,
    PYTHONPATH: getEnginePath(),
    BRIDGECLIP_MODELS_DIR: modelsDir(),
    PYTHONUNBUFFERED: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  }
}

/** Import-probe the engine venv for faster-whisper without loading a model. */
async function checkWhisperRuntime(pythonPath: string): Promise<boolean> {
  try {
    await execFileAsync(pythonPath, ['-c', 'import faster_whisper'], {
      timeout: 30000, windowsHide: true, env: engineEnv()
    })
    return true
  } catch {
    return false
  }
}

function whisperWeightsPresent(model: string): boolean {
  const repo = WHISPER_REPOS[model] ?? WHISPER_REPOS['large-v3-turbo']
  const dashed = repo.replace(/\//g, '-')
  // Three on-disk layouts must all count as "weights ready": the dash folder
  // the engine prefers for manual installs, huggingface_hub's cache layout
  // (models--Owner--Repo/snapshots/<rev>/model.bin) written by the setup
  // download, and the raw repo-path layout older installs used.
  const candidates = [
    join(modelsDir(), dashed, 'model.bin'),
    join(modelsDir(), ...repo.split('/'), 'model.bin')
  ]
  if (candidates.some(candidate => existsSync(candidate))) return true
  const cacheRoot = join(modelsDir(), `models--${repo.replace(/\//g, '--')}`, 'snapshots')
  try {
    for (const revision of readdirSync(cacheRoot)) {
      if (existsSync(join(cacheRoot, revision, 'model.bin'))) return true
    }
  } catch { /* no cache folder yet */ }
  return false
}

export async function getLocalAiStatus(settings: AppSettings, pythonPath: string): Promise<LocalAiStatus> {
  const [gpu, whisperRuntime, ollamaRunning] = await Promise.all([
    detectGpu(),
    checkWhisperRuntime(pythonPath),
    isOllamaReachable(settings.localLlmBaseUrl)
  ])
  let ollamaModels: string[] = []
  if (ollamaRunning) {
    try { ollamaModels = await listOllamaModels(settings.localLlmBaseUrl) } catch { /* server answered version but not tags */ }
  }
  const whisperModelReady = whisperWeightsPresent(settings.localWhisperModel)
  const plannerReady = ollamaModels.includes(settings.localPlannerModel)
  // The NVIDIA backend plans in NVIDIA's cloud; only its local transcription
  // stack has to be deployed.
  const ready = settings.aiProvider === 'nvidia'
    ? whisperRuntime && whisperModelReady
    : whisperRuntime && whisperModelReady && plannerReady
  return {
    gpuAvailable: gpu !== null,
    gpuName: gpu,
    whisperRuntime,
    whisperModelReady,
    ollamaRunning,
    ollamaModels,
    plannerReady,
    ready,
    pythonPath,
    enginePath: getEnginePath()
  }
}

// ---------------------------------------------------------------------------
// Setup orchestration
// ---------------------------------------------------------------------------

let activeSetup: AbortController | null = null

export function cancelLocalAiSetup(): void {
  activeSetup?.abort()
  activeSetup = null
}

export function isLocalAiSetupRunning(): boolean {
  return activeSetup !== null
}

export async function setupLocalAi(
  settings: AppSettings,
  onProgress: (progress: LocalAiProgress) => void
): Promise<LocalAiStatus> {
  if (activeSetup) throw new Error('Offline setup is already running')
  const controller = new AbortController()
  activeSetup = controller
  const pythonPath = resolvePythonPath(getEnginePath(), settings.pythonPath)
  try {
    // Every step checks its own completion first, so re-running setup is a
    // fast no-op — and works without any network once everything is deployed.
    if (!await checkWhisperRuntime(pythonPath)) {
      onProgress({ step: 'whisper-runtime', label: 'Installing offline transcription (faster-whisper)', percent: null })
      await runPython(pythonPath, ['-m', 'pip', 'install', '-r', join(getEnginePath(), 'requirements-local.txt')], controller.signal)
    }

    if (!whisperWeightsPresent(settings.localWhisperModel)) {
      onProgress({ step: 'whisper-model', label: `Downloading Whisper ${settings.localWhisperModel} weights`, percent: 0 })
      await downloadWhisperWeights(pythonPath, settings, controller.signal, onProgress)
    }

    // The NVIDIA backend plans through NVIDIA's hosted API; no local chat
    // runtime is needed, so its setup ends after the Whisper steps.
    if (settings.aiProvider !== 'nvidia') {
      if (!await isOllamaReachable(settings.localLlmBaseUrl)) {
        if (!localOllamaExists()) {
          onProgress({ step: 'ollama-runtime', label: 'Downloading the local AI runtime (Ollama)', percent: 0 })
          await deployOllama(controller.signal, onProgress)
        }
        startManagedOllama(settings.localLlmBaseUrl)
        await waitForOllama(settings.localLlmBaseUrl, 30000)
      }

      const installed = await listOllamaModels(settings.localLlmBaseUrl).catch(() => [] as string[])
      if (!installed.includes(settings.localPlannerModel)) {
        onProgress({ step: 'planner-model', label: `Downloading planning model ${settings.localPlannerModel}`, percent: 0 })
        await pullOllamaModel(settings.localLlmBaseUrl, settings.localPlannerModel, controller.signal, onProgress)
      }
    }

    return await getLocalAiStatus(settings, pythonPath)
  } finally {
    activeSetup = null
  }
}

function runPython(pythonPath: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, args, { windowsHide: true, env: engineEnv() })
    const onAbort = (): void => { child.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000) })
    child.on('error', reject)
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new Error('Setup cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(`command failed (exit ${code})${stderr ? `: ${stderr.split('\n').slice(-4).join(' ')}` : ''}`))
    })
  })
}

function downloadWhisperWeights(
  pythonPath: string, settings: AppSettings, signal: AbortSignal,
  onProgress: (progress: LocalAiProgress) => void
): Promise<void> {
  // ensure_model tries huggingface.co and falls back to a public mirror when
  // the hub refuses the network; tqdm/fallback progress lines hit stderr as
  // "... NN%", which this UI forwards as the step percentage.
  const repo = WHISPER_REPOS[settings.localWhisperModel] ?? WHISPER_REPOS['large-v3-turbo']
  const script = (
    'import sys; from clip_engine.services.model_fetch import ensure_model; ' +
    `ensure_model(${JSON.stringify(repo)}, sys.argv[1])`
  )
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, ['-c', script, modelsDir()], { windowsHide: true, env: engineEnv() })
    const onAbort = (): void => { child.kill() }
    signal.addEventListener('abort', onAbort, { once: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr = (stderr + text).slice(-4000)
      // A chunk can carry several progress lines; report the newest one.
      const matches = text.match(/\d+%/g)
      if (matches) onProgress({
        step: 'whisper-model',
        label: `Downloading Whisper ${settings.localWhisperModel} weights`,
        percent: Number.parseInt(matches[matches.length - 1], 10)
      })
    })
    child.on('error', reject)
    child.on('close', code => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) return reject(new Error('Setup cancelled'))
      if (code === 0 && whisperWeightsPresent(settings.localWhisperModel)) return resolve()
      const tail = stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''
      const blocked = /401|unauthorized|gated|invalid username/i.test(stderr)
      const hint = blocked
        ? ' huggingface.co refused the download from this network. Set HF_ENDPOINT=https://hf-mirror.com in the environment and retry, or place the model folder in the BridgeClip models directory.'
        : ''
      reject(new Error(`Whisper weights download failed${tail}${hint}`))
    })
  })
}

async function deployOllama(signal: AbortSignal, onProgress: (progress: LocalAiProgress) => void): Promise<void> {
  if (localOllamaExists()) return
  const url = OLLAMA_DOWNLOADS[process.platform]
  if (!url) throw new Error(`No portable Ollama build for ${process.platform}. Install Ollama from ollama.com, then retry.`)
  mkdirSync(localAiDir(), { recursive: true })
  const archive = join(localAiDir(), basename(url))
  const removeArchive = (): void => { try { unlinkSync(archive) } catch { /* best effort */ } }
  try {
    await downloadOllamaArchive(url, archive, signal, onProgress)
    if (signal.aborted) throw new Error('Setup cancelled')
    onProgress({ step: 'ollama-runtime', label: 'Extracting the local AI runtime', percent: null })
    mkdirSync(ollamaDir(), { recursive: true })
    if (archive.endsWith('.zip')) {
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(ollamaDir())} -Force`
      ], { timeout: 10 * 60 * 1000, windowsHide: true })
    } else {
      await execFileAsync('tar', ['-xzf', archive, '-C', ollamaDir()], { timeout: 10 * 60 * 1000 })
    }
  } catch (error) {
    // Never leave a partial or corrupt archive behind for the next retry.
    removeArchive()
    throw error
  }
  removeArchive()
  if (!localOllamaExists()) throw new Error('The Ollama archive did not contain a runnable binary')
}

async function downloadOllamaArchive(
  url: string, archive: string, signal: AbortSignal,
  onProgress: (progress: LocalAiProgress) => void
): Promise<void> {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) throw new Error(`Could not download Ollama (HTTP ${response.status})`)
  const total = Number(response.headers.get('content-length')) || null
  let copied = 0
  const output = createWriteStream(archive)
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      copied += value.byteLength
      if (total) onProgress({
        step: 'ollama-runtime', label: 'Downloading the local AI runtime (Ollama)',
        percent: Math.min(99, Math.round(100 * copied / total))
      })
      if (!output.write(value)) await new Promise<void>(resolve => output.once('drain', resolve))
    }
  } finally {
    output.end()
    await new Promise<void>((resolve, reject) => { output.on('finish', resolve); output.on('error', reject) })
  }
  // A truncated stream that fetch did not surface as an error would otherwise
  // be extracted as a corrupt archive; the declared size catches that.
  if (total && copied !== total) throw new Error(`The Ollama download ended early (${copied}/${total} bytes)`)
}

let managedOllama: ReturnType<typeof spawn> | null = null

/** Start the app-managed Ollama server (headless) if it is not running. */
export function startManagedOllama(baseUrl: string): void {
  if (managedOllama || !localOllamaExists()) return
  // Listen exactly where the settings point; default 11434.
  let host = '127.0.0.1'
  let port = 11434
  try {
    const url = new URL(baseUrl)
    if (url.hostname) host = url.hostname
    port = url.port ? Number(url.port) : port
  } catch { /* default host:port */ }
  managedOllama = spawn(ollamaBinary(), ['serve'], {
    windowsHide: true,
    detached: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      // Server-wide context ceiling; each engine request also sets num_ctx.
      OLLAMA_CONTEXT_LENGTH: '16384',
      OLLAMA_HOST: `${host}:${port}`
    }
  })
  // Without an error listener a failed spawn (e.g. a corrupt binary) would
  // re-raise as an unhandled event and crash the main process.
  managedOllama.on('error', () => { managedOllama = null })
  managedOllama.on('exit', () => { managedOllama = null })
  app.on('will-quit', () => { managedOllama?.kill() })
}

/**
 * Make sure an Ollama server answers: already reachable, or (re)start the
 * app-managed runtime — e.g. after a reboot. Never downloads; the setup
 * flow owns deployment.
 */
export async function ensureOllamaRunning(baseUrl: string, waitMs = 20000): Promise<boolean> {
  if (await isOllamaReachable(baseUrl)) return true
  if (!localOllamaExists()) return false
  startManagedOllama(baseUrl)
  try {
    await waitForOllama(baseUrl, waitMs)
    return true
  } catch {
    return false
  }
}

async function waitForOllama(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isOllamaReachable(baseUrl)) return
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  throw new Error('The local AI runtime did not start. Start Ollama manually, then retry.')
}

async function pullOllamaModel(
  baseUrl: string, model: string, signal: AbortSignal,
  onProgress: (progress: LocalAiProgress) => void
): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(baseUrl)}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal
  })
  if (!response.ok || !response.body) throw new Error(`Model download failed (HTTP ${response.status})`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let event: { status?: string, error?: string, total?: number, completed?: number }
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.error) throw new Error(event.error)
      const percent = event.total ? Math.round(100 * (event.completed ?? 0) / event.total) : null
      onProgress({ step: 'planner-model', label: `Downloading planning model ${model}`, percent, detail: event.status })
    }
  }
}
