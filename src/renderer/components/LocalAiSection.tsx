import { useCallback, useEffect, useState } from 'react'
import { Check, CloudOff, Loader2, RefreshCw, X } from 'lucide-react'
import type { LocalAiProgress, LocalAiStepId, LocalAiStatus } from '../../shared/local-ai'
import { useSettingsStore } from '../store/use-settings-store'
import { getApi } from '../lib/ipc'
import { cn, errorMessage, formatTimecode } from '../lib/utils'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { IconTile } from '../components/ui/IconTile'

const WHISPER_OPTIONS = [
  { id: 'large-v3-turbo', label: 'Whisper Turbo', hint: 'Best speed/quality balance' },
  { id: 'large-v3', label: 'Whisper Large V3', hint: 'Most accurate, ~5× slower' },
  { id: 'medium', label: 'Whisper Medium', hint: 'Smallest, lower accuracy' }
] as const

/** Curated NVIDIA NIM planner models (build.nvidia.com ids). */
const NVIDIA_PLANNER_OPTIONS = [
  { id: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek V3.1' },
  { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' },
  { id: 'qwen/qwen3-235b-a22b', label: 'Qwen3 235B A22B' },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', label: 'Nemotron Super 49B' },
  { id: 'mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1' }
] as const

const LANGUAGES = [
  { id: '', label: 'Auto-detect' },
  { id: 'ro', label: 'Română' },
  { id: 'en', label: 'English' }
] as const

/**
 * AI provider picker plus one-click deployment of the local stack. The
 * NVIDIA backend plans in NVIDIA's free cloud and only needs the Whisper
 * transcription steps; local mode deploys everything offline.
 */
export function LocalAiSection(): React.JSX.Element {
  const aiProvider = useSettingsStore((s) => s.aiProvider)
  const localWhisperModel = useSettingsStore((s) => s.localWhisperModel)
  const localPlannerModel = useSettingsStore((s) => s.localPlannerModel)
  const nvidiaPlannerModel = useSettingsStore((s) => s.nvidiaPlannerModel)
  const nvidiaConfigured = useSettingsStore((s) => s.nvidiaConfigured)
  const transcriptionLanguage = useSettingsStore((s) => s.transcriptionLanguage)
  const save = useSettingsStore((s) => s.save)

  const [status, setStatus] = useState<LocalAiStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [settingUp, setSettingUp] = useState(false)
  const [progress, setProgress] = useState<LocalAiProgress | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [stepStart, setStepStart] = useState<{ step: LocalAiStepId; at: number; firstPercentAt: number | null; firstPercent: number } | null>(null)
  const [now, setNow] = useState(Date.now)

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      setStatus(await getApi().localai.status())
    } catch { /* surfaced by the empty checklist */ }
    finally { setChecking(false) }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => getApi().localai.onProgress((update) => {
    setProgress(update)
    setStepStart((previous) => {
      if (previous?.step !== update.step) return { step: update.step, at: Date.now(), firstPercentAt: null, firstPercent: 0 }
      // Anchor the rate estimate once the step is past its first few percents.
      if (previous.firstPercentAt === null && update.percent != null && update.percent >= 2) {
        return { ...previous, firstPercentAt: Date.now(), firstPercent: update.percent }
      }
      return previous
    })
  }), [])
  useEffect(() => {
    if (!settingUp) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [settingUp])

  const runSetup = async (): Promise<void> => {
    setSettingUp(true)
    setSetupError(null)
    setStepStart(null)
    try {
      setStatus(await getApi().localai.setup())
    } catch (err) {
      setSetupError(errorMessage(err, 'The offline setup failed. Check the connection and retry.'))
    } finally {
      setSettingUp(false)
      setProgress(null)
    }
  }

  const local = aiProvider === 'local'
  const nvidia = aiProvider === 'nvidia'
  const rows: { label: string; ok: boolean | null; detail: string }[] = [
    {
      label: 'GPU (optional)',
      ok: status ? (status.gpuAvailable ? true : null) : null,
      detail: status?.gpuName ?? 'CUDA not detected; transcription runs on CPU'
    },
    {
      label: 'Offline transcription runtime',
      ok: status?.whisperRuntime ?? null,
      detail: status ? (status.whisperRuntime ? 'faster-whisper installed' : 'faster-whisper missing') : 'Checking…'
    },
    {
      label: `Whisper ${labelFor(localWhisperModel)} weights`,
      ok: status?.whisperModelReady ?? null,
      detail: status ? (status.whisperModelReady ? 'Downloaded' : 'Not downloaded') : 'Checking…'
    }
  ]
  if (nvidia) {
    rows.push({
      label: 'NVIDIA API key',
      ok: nvidiaConfigured,
      detail: nvidiaConfigured ? 'Added in the API keys section' : 'Add it in the API keys section of Settings'
    })
  }
  if (local) {
    rows.push(
      {
        label: 'Local AI runtime (Ollama)',
        ok: status?.ollamaRunning ?? null,
        detail: status ? (status.ollamaRunning ? 'Running' : 'Not running') : 'Checking…'
      },
      {
        label: `Planning model ${localPlannerModel}`,
        ok: status?.plannerReady ?? null,
        detail: status ? (status.plannerReady ? 'Installed' : 'Not installed') : 'Checking…'
      }
    )
  }
  const ready = status?.ready === true

  const stepElapsedMs = settingUp && progress && stepStart?.step === progress.step ? Math.max(0, now - stepStart.at) : 0
  let stepEtaMs: number | null = null
  if (stepElapsedMs > 0 && stepStart?.firstPercentAt != null && progress?.percent != null && progress.percent < 100) {
    const gained = progress.percent - stepStart.firstPercent
    const took = now - stepStart.firstPercentAt
    if (gained > 0 && took > 0) stepEtaMs = Math.round(took * (100 - progress.percent) / gained)
  }

  const nvidiaModelOptions = [
    ...NVIDIA_PLANNER_OPTIONS,
    ...(NVIDIA_PLANNER_OPTIONS.some((option) => option.id === nvidiaPlannerModel) ? [] : [{ id: nvidiaPlannerModel, label: nvidiaPlannerModel }])
  ]

  return (
    <section id="settings-localai" className="scroll-mt-14">
      <Panel>
      <PanelHeader
        icon={<IconTile tone="accent"><CloudOff /></IconTile>}
        title="Local AI"
        description="Choose where clip planning and transcription run: the OpenRouter cloud, NVIDIA's free tier, or your own machine."
      />
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="AI provider">
        {([
          { id: 'cloud', label: 'Cloud (OpenRouter)', hint: 'Best quality · needs a paid key' },
          { id: 'nvidia', label: 'NVIDIA (free cloud)', hint: 'Free tier · key + one-time Whisper setup' },
          { id: 'local', label: 'Local (offline)', hint: 'Free and private · needs one-time setup' }
        ] as const).map((option) => {
          const selected = aiProvider === option.id
          return (
            <button key={option.id} type="button" role="radio" aria-checked={selected}
              onClick={() => void save({ aiProvider: option.id })}
              className={cn('glass-tile glass-tile-hover rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}>
              <span className="block text-sm font-medium text-ink">{option.label}</span>
              <span className="block text-2xs text-ink-subtle">{option.hint}</span>
            </button>
          )
        })}
      </div>

      {(local || nvidia) && (
        <>
          <div className="mt-4 space-y-1.5">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 glass-tile">
                {row.ok == null
                  ? <span className="h-2 w-2 shrink-0 rounded-full bg-ink-faint" aria-hidden />
                  : row.ok
                    ? <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
                    : <X className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">{row.label}</span>
                  <span className="block truncate text-2xs text-ink-subtle">{row.detail}</span>
                </span>
              </div>
            ))}
          </div>

          {(checking || !ready) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={settingUp || checking} onClick={() => void runSetup()}>
                {settingUp ? <Loader2 className="animate-spin" aria-hidden /> : <CloudOff aria-hidden />}
                {settingUp
                  ? nvidia ? 'Preparing free transcription…' : 'Setting up offline mode…'
                  : nvidia ? 'Prepare free transcription' : 'Prepare offline mode'}
              </Button>
              <Button variant="ghost" disabled={settingUp} onClick={() => void refresh()}>
                <RefreshCw aria-hidden /> Check again
              </Button>
              {settingUp && (
                <Button variant="ghost" onClick={() => void getApi().localai.cancel().then(refresh)}>
                  Cancel
                </Button>
              )}
            </div>
          )}

          {settingUp && progress && (
            <div className="mt-3 rounded-xl px-3 py-2.5 glass-tile">
              <div className="flex items-center justify-between gap-2 text-sm text-ink">
                <span className="min-w-0 truncate">{progress.label}</span>
                {progress.percent != null && <span className="shrink-0 font-mono text-2xs tabular text-ink-muted">{progress.percent}%</span>}
              </div>
              {progress.percent != null && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${progress.percent}%` }} />
                </div>
              )}
              {progress.detail && <p className="mt-1.5 truncate text-2xs text-ink-subtle">{progress.detail}</p>}
              {stepElapsedMs > 0 && (
                <p className="mt-1.5 font-mono text-2xs tabular text-ink-subtle">
                  {formatTimecode(stepElapsedMs)} elapsed{stepEtaMs !== null && <> · about {formatTimecode(stepEtaMs)} left</>}
                </p>
              )}
            </div>
          )}

          {setupError && (
            <p className="mt-3 text-2xs text-danger">{setupError}</p>
          )}

          {ready && nvidia && nvidiaConfigured && (
            <div className="mt-3 flex items-center gap-2 text-2xs text-success">
              <Check aria-hidden /> Free NVIDIA clipping is ready. Planning runs on NVIDIA's free tier (about 40 requests per minute); transcription stays on this machine. Jev review, web research and vision-based framing are skipped.
            </div>
          )}
          {ready && local && (
            <div className="mt-3 flex items-center gap-2 text-2xs text-success">
              <Check aria-hidden /> Offline clipping is ready. Jev review, web research and vision-based framing stay cloud-only and are skipped offline.
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Transcription model</span>
              <select
                value={localWhisperModel}
                disabled={settingUp}
                onChange={(event) => { void save({ localWhisperModel: event.target.value }).then(refresh) }}
                className="glass-tile w-full rounded-xl px-3 py-2 text-sm text-ink outline-none"
              >
                {WHISPER_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label} — {option.hint}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Spoken language</span>
              <select
                value={transcriptionLanguage}
                disabled={settingUp}
                onChange={(event) => void save({ transcriptionLanguage: event.target.value })}
                className="glass-tile w-full rounded-xl px-3 py-2 text-sm text-ink outline-none"
              >
                {LANGUAGES.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            {local ? (
              <label className="block">
                <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Planning model</span>
                <select
                  value={localPlannerModel}
                  disabled={settingUp}
                  onChange={(event) => void save({ localPlannerModel: event.target.value })}
                  className="glass-tile w-full rounded-xl px-3 py-2 text-sm text-ink outline-none"
                >
                  {(status?.ollamaModels.length ? status.ollamaModels : [localPlannerModel]).map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
                <span className="mt-1 block text-2xs text-ink-subtle">Any Ollama model works; qwen3:8b is a fast Romanian + English all-rounder.</span>
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">Planning model</span>
                <select
                  value={nvidiaPlannerModel}
                  disabled={settingUp}
                  onChange={(event) => void save({ nvidiaPlannerModel: event.target.value })}
                  className="glass-tile w-full rounded-xl px-3 py-2 text-sm text-ink outline-none"
                >
                  {nvidiaModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
                <span className="mt-1 block text-2xs text-ink-subtle">Served free on build.nvidia.com; DeepSeek V3.1 is the strongest all-rounder.</span>
              </label>
            )}
          </div>
        </>
      )}
      </Panel>
    </section>
  )
}

function labelFor(model: string): string {
  return WHISPER_OPTIONS.find((option) => option.id === model)?.label ?? model
}
