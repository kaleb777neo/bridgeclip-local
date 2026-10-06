import { normalizeVideoSource, twitchSourceError } from '../../shared/video-source'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, CheckCircle2, Clock3, ListVideo, Minus, Plus, Sparkles } from 'lucide-react'
import { cn, basename, MOD_KEY, parseTimecode, sourceLabel } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { useDraftStore, type ClipDraft, type WizardAspectRatio, type WizardStep } from '../store/use-draft-store'
import { useActiveJobs } from '../store/use-job-store'
import type { BrandTemplate } from '../../shared/templates'
import type { ClipJobRequest } from '../../shared/jobs'
import { MAX_PARALLEL_JOBS } from '../../shared/jobs'
import { CaptionPresetPicker, CAPTION_PRESET_NAMES } from './CaptionPresetPicker'
import { SourcePicker } from './SourcePicker'
import { Panel } from './ui/Panel'
import { Switch } from './ui/Switch'
import { Button } from './ui/Button'
import { TextArea, TextInput } from './ui/Field'
import { IconTile } from './ui/IconTile'
import { SettingRow } from './ui/SettingRow'
import { onRadioKeyDown } from './ui/Segmented'
import { CLIP_REQUEST_MAX_CHARS, DURATION_OPTIONS, VIDEO_SPEED_OPTIONS } from '../../shared/job-contract'
import { isModelId } from '../../shared/openrouter-models'
import { useModelStore } from '../store/use-model-store'
import { useSettingsStore } from '../store/use-settings-store'
import { ModelPicker } from './ModelPicker'
import { WorkflowPicker } from './WorkflowPicker'

const DURATIONS = DURATION_OPTIONS

const FORMATS = [
  { id: '9:16', label: 'Vertical', hint: 'Shorts, Reels, TikTok', w: 12, h: 21 },
  { id: '1:1', label: 'Square', hint: 'Feed, X, LinkedIn', w: 18, h: 18 },
  { id: '16:9', label: 'Horizontal', hint: 'YouTube, Threads', w: 24, h: 14 }
] as const

const LAYOUT_STYLES = [
  { id: 'auto', label: 'Smart', hint: 'Auto frames each shot' },
  { id: 'fill', label: 'Full frame', hint: 'Follows the speaker' },
  { id: 'fit', label: 'Classic', hint: 'Whole frame, blurred' }
] as const

const MAX_CLIPS = 100

export const WIZARD_STEPS: { id: WizardStep; label: string; title: string; description: string }[] = [
  { id: 'video', label: 'Video', title: 'Choose a video', description: 'A local file, YouTube link or Twitch VOD link. Optionally suggest where to find clips.' },
  { id: 'format', label: 'Format', title: 'Format, framing and speed', description: 'Choose the look and pace of every clip in this job.' },
  { id: 'clips', label: 'Clips', title: 'What to clip, length and count', description: 'Optionally describe the moments you want. Pick one or more lengths, or none for any length.' },
  { id: 'captions', label: 'Captions', title: 'Captions', description: 'Word-by-word captions burned into each clip. Silent videos are clipped without them.' },
  { id: 'review', label: 'Review', title: 'Review and generate', description: 'Check the run, then generate. You can queue another video right after.' }
]

export function parseTrimRange(enabled: boolean, startText: string, endText: string): {
  start: number | null
  end: number | null
  error: string | null
} {
  const start = enabled ? parseTimecode(startText) : null
  const end = enabled ? parseTimecode(endText) : null
  let error: string | null = null
  if (Number.isNaN(start) || Number.isNaN(end)) error = 'Use seconds (90) or a timecode (1:30).'
  else if (end != null && end <= (start ?? 0)) error = 'End must be after the start.'
  return { start, end, error }
}

/** The run request for the current draft. */
export function buildJobRequest(draft: ClipDraft, trim: { start: number | null; end: number | null }): ClipJobRequest {
  if (!draft.workflow) throw new Error('Choose a workflow before creating clips.')
  // Review & edit exports one format, vertical or horizontal, from the editor.
  const ratios: WizardAspectRatio[] = draft.workflow === 'review'
    ? (draft.aspectRatios[0] === '1:1' ? ['9:16'] : [draft.aspectRatios[0]])
    : draft.aspectRatios
  return {
    videoUrl: normalizeVideoSource(draft.source),
    workflow: draft.workflow,
    clippingMode: draft.clippingMode,
    ...(draft.clippingMode === 'advanced' ? { plannerModel: draft.plannerModel, transcriptionModel: draft.transcriptionModel } : {}),
    ...(draft.clipRequest?.trim() ? { clipRequest: draft.clipRequest.trim() } : {}),
    maxClips: draft.autoClipCount ? null : draft.maxClips,
    autoClipCount: draft.autoClipCount,
    durationRanges: draft.durations.length > 0 ? draft.durations : null,
    aspectRatio: ratios[0],
    // With a pack selected the full format list always travels with the job: main only fills
    // unset fields, so sending the user's current choice is what keeps manual edits winning.
    ...(ratios.length > 1 || draft.templateId ? { aspectRatios: [...ratios] } : {}),
    layoutStyle: draft.layoutStyle,
    layoutVision: draft.clippingMode !== 'economy' && ratios[0] !== '16:9' && draft.layoutStyle === 'auto' && draft.layoutVision,
    pacing: draft.pacing,
    videoSpeed: draft.videoSpeed ?? 1,
    includeCaptions: draft.includeCaptions,
    captionPreset: draft.captionPreset,
    ...(draft.srtPath ? { srtPath: draft.srtPath } : {}),
    includeTitle: draft.includeTitle,
    startTimeSeconds: trim.start,
    endTimeSeconds: trim.end,
    bannerPlatform: draft.bannerPlatform ?? null,
    bannerChannelUrl: draft.bannerChannelUrl ?? null,
    ...(draft.templateId ? { templateId: draft.templateId } : {})
  }
}

/**
 * Applying a pack writes its preset and formats into the draft; they stay
 * manually editable, and a later manual edit beats the pack (main fills only
 * unset request fields). `None` clears the pack but keeps the derived values.
 */
export function draftPatchForTemplate(template: BrandTemplate | null): Partial<ClipDraft> {
  if (!template) return { templateId: null }
  return {
    templateId: template.id,
    captionPreset: template.captionPresetId,
    aspectRatios: [...template.formats] as WizardAspectRatio[],
    // Per-channel render settings: the same fill-only-what-the-pack-carries rule,
    // so later manual edits in the wizard still win at submit time.
    ...(template.pacing !== undefined ? { pacing: template.pacing } : {}),
    ...(template.layoutStyle !== undefined ? { layoutStyle: template.layoutStyle } : {}),
    ...(template.includeTitle !== undefined ? { includeTitle: template.includeTitle } : {}),
    ...(template.banner ? { bannerPlatform: template.banner.platform, bannerChannelUrl: template.banner.channelUrl } : {})
  }
}

/** "None" + one chip per pack; shown above the wizard steps once templates exist. */
export function TemplateSelector({ templates, selectedId, onSelect }: {
  templates: BrandTemplate[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  return (
    <section aria-label="Brand template" className="flex flex-wrap items-center gap-1.5">
      <span className="eyebrow mr-1 text-2xs text-ink-subtle">Brand template</span>
      {[{ id: null as string | null, name: 'None' }, ...templates].map((t) => (
        <button
          key={t.id ?? '__none'}
          type="button"
          aria-pressed={selectedId === t.id}
          title={t.id ? undefined : 'No brand template'}
          onClick={() => onSelect(t.id)}
          className={cn('glass-tile glass-tile-hover rounded-full px-3 py-1 text-xs', selectedId === t.id ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}
        >
          {t.name}
          {t.id && templates.find((x) => x.id === t.id)?.builtIn ? <span className="ml-1 text-2xs text-ink-faint">built-in</span> : null}
        </button>
      ))}
    </section>
  )
}

interface JobFormProps {
  onSubmit: (config: ClipJobRequest) => void
  /** Opens a queued job on the Jobs page. */
  onViewJob?: (jobId: string) => void
  /** Why the job can't start yet (missing keys, tools); disables submit. */
  blockedReason?: ReactNode
  submitting?: boolean
  className?: string
}

type Update = (patch: Partial<ClipDraft>) => void

/**
 * The Create wizard: Video → Format → Clips → Captions → Review. Each step is
 * one compact panel with Back/Next pinned below it. After Generate the job is
 * queued and the wizard offers the next video, so several runs can go at once.
 */
export function JobForm({ onSubmit, onViewJob, blockedReason, submitting, className }: JobFormProps): React.JSX.Element {
  const draft = useDraftStore()
  const { update, step, setStep } = draft
  const [templates, setTemplates] = useState<BrandTemplate[]>([])

  // Brand packs load once per mount; the page keeps no separate copy.
  useEffect(() => {
    let active = true
    // Brand packs load once per mount; a configured default pack pre-applies
    // to fresh drafts (no pack chosen yet). Manual edits in the wizard still win.
    try {
      void Promise.all([getApi().templates.list(), getApi().settings.load()]).then(([list, settings]) => {
        if (!active) return
        setTemplates(list)
        if (settings.defaultTemplateId && !draft.templateId) {
          const pack = list.find((tpl) => tpl.id === settings.defaultTemplateId)
          if (pack) update(draftPatchForTemplate(pack))
        }
      }).catch(() => {})
    } catch { /* no bridge (tests) */ }
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trim = useMemo(
    () => parseTrimRange(draft.trimOpen, draft.trimStart, draft.trimEnd),
    [draft.trimOpen, draft.trimStart, draft.trimEnd]
  )

  const index = WIZARD_STEPS.findIndex((s) => s.id === step)
  const meta = WIZARD_STEPS[index]
  const sourceError = twitchSourceError(draft.source)
  const hasSource = Boolean(draft.source.trim()) && !sourceError
  const videoValid = hasSource && draft.workflow !== null && !trim.error
  const modelsValid = draft.clippingMode !== 'advanced' || (isModelId(draft.plannerModel) && isModelId(draft.transcriptionModel))
  const stepValid = videoValid && (step !== 'clips' || modelsValid)
  const canSubmit = videoValid && modelsValid && !blockedReason && !submitting && !draft.started

  const submit = (): void => {
    if (canSubmit) onSubmit(buildJobRequest(draft, trim))
  }

  // ⌘↵ / Ctrl+↵ generates only once a video and workflow are chosen.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (draft.started) {
    return <StartedPanel className={className} onViewJob={onViewJob} />
  }

  const goTo = (target: WizardStep): void => {
    setStep(target)
    document.getElementById('page-scroll')?.scrollTo({ top: 0 })
  }
  const next = WIZARD_STEPS[index + 1]
  const back = WIZARD_STEPS[index - 1]

  return (
    <div className={cn('space-y-3', className)}>
      {templates.length > 0 && (
        <TemplateSelector
          templates={templates}
          selectedId={draft.templateId}
          onSelect={(id) => update(draftPatchForTemplate(id === null ? null : templates.find((t) => t.id === id) ?? null))}
        />
      )}
      <Stepper current={step} reachable={videoValid ? WIZARD_STEPS.length - 1 : 0} onSelect={goTo} />

      {step === 'captions' && draft.workflow === 'review' && (
        <aside aria-labelledby="caption-editor-note" className="rounded-2xl border border-accent/20 bg-accent/5 p-4 xl:p-5">
          <span className="eyebrow text-accent">Review &amp; edit</span>
          <h2 id="caption-editor-note" className="mt-1.5 text-sm font-semibold text-ink">Adjust captions in the editor</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Choose a starting style below. Before exporting, you can change how captions look, reposition them, or hide them from selected parts of each clip.
          </p>
        </aside>
      )}

      <Panel className="p-4 xl:p-5">
        {step !== 'video' && <div className="mb-3">
          <h2 className="text-sm font-semibold text-ink">{step === 'review' && draft.workflow === 'review' ? 'Ready to find candidates' : meta.title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{step === 'review' && draft.workflow === 'review' ? 'Jev reviews each candidate before the editor opens for your final cut.' : meta.description}</p>
        </div>}
        {sourceError && <p role="alert" className="text-sm text-danger">{sourceError}</p>}
        {step === 'video' && <VideoStep draft={draft} update={update} trimError={trim.error} disabled={submitting} />}
        {step === 'format' && <FormatStep draft={draft} update={update} />}
        {step === 'clips' && <ClipsStep draft={draft} update={update} />}
        {step === 'captions' && <CaptionsStep draft={draft} update={update} />}
        {step === 'review' && <ReviewStep draft={draft} trim={trim} onEdit={goTo} />}
      </Panel>

      {/* Actions stay pinned to the bottom edge on a solid strip. */}
      <div className="sticky bottom-0 z-10 -mb-3 flex items-center gap-3 bg-canvas pb-3 pt-2">
        {back ? (
          <Button variant="ghost" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => goTo(back.id)}>
            Back
          </Button>
        ) : <span />}
        <p className="min-w-0 flex-1 truncate text-center text-2xs text-ink-subtle">
          {blockedReason ?? (!draft.workflow ? 'Choose a workflow to continue.' : !modelsValid ? 'Choose both models in Advanced mode.' : step === 'video' && !hasSource ? 'Add a video to continue.' : `${MOD_KEY}↵ generates from any step`)}
        </p>
        {next && step !== 'review' ? (
          <div className="flex items-center gap-2">
            {step !== 'video' && (
              <Button variant="ghost" onClick={submit} disabled={!canSubmit} loading={submitting} className="max-sm:hidden">
                {draft.workflow === 'review' ? 'Find candidates' : 'Generate now'}
              </Button>
            )}
            <Button variant="primary" trailingIcon={<ArrowRight className="h-3.5 w-3.5" />} onClick={() => goTo(next.id)} disabled={!stepValid}>
              Next: {next.label}
            </Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={submit} disabled={!canSubmit} loading={submitting}>
            {draft.workflow === 'review' ? 'Find candidates' : 'Generate clips'}
          </Button>
        )}
      </div>
    </div>
  )
}

function Stepper({ current, reachable, onSelect }: { current: WizardStep; reachable: number; onSelect: (step: WizardStep) => void }): React.JSX.Element {
  const currentIndex = WIZARD_STEPS.findIndex((s) => s.id === current)
  return (
    <nav aria-label="Create steps">
      <ol className="flex items-center gap-1.5">
        {WIZARD_STEPS.map((s, i) => {
          const active = i === currentIndex
          const done = i < currentIndex
          const enabled = i <= reachable
          return (
            <li key={s.id} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none">
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                disabled={!enabled}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'group flex min-w-0 items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-xs transition-colors duration-200',
                  active ? 'bg-white/[0.08] font-medium text-ink' : enabled ? 'text-ink-muted hover:bg-white/[0.05] hover:text-ink' : 'text-ink-faint'
                )}
              >
                <span
                  className={cn(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-2xs tabular',
                    active ? 'bg-accent text-accent-ink' : done ? 'bg-ink text-canvas' : 'bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]'
                  )}
                >
                  {done ? <Check className="h-3 w-3" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn('truncate', !active && 'max-md:hidden')}>{s.label}</span>
              </button>
              {i < WIZARD_STEPS.length - 1 && (
                <span aria-hidden className={cn('h-px min-w-3 flex-1', done ? 'bg-ink/40' : 'bg-white/[0.08]')} />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function VideoStep({ draft, update, trimError, disabled }: { draft: ClipDraft; update: Update; trimError: string | null; disabled?: boolean }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <WorkflowPicker value={draft.workflow} onChange={(workflow) => update({ workflow })} disabled={disabled} />
      <section aria-labelledby="video-source-heading" className="space-y-3 border-t border-white/[0.06] pt-4">
        <div>
          <h2 id="video-source-heading" className="text-sm font-semibold text-ink">{WIZARD_STEPS[0].title}</h2>
          <p className="mt-0.5 text-xs text-ink-muted">{WIZARD_STEPS[0].description}</p>
        </div>
        <SourcePicker value={draft.source} onChange={(source) => update({ source })} disabled={disabled} />
      </section>
      <SettingRow
        title="Preferred part of the video"
        description="Suggest where to find clips. The full source is transcribed; boundaries may expand to preserve complete ideas."
        control={<Switch label="Prefer a source range" checked={draft.trimOpen} onChange={(trimOpen) => update({ trimOpen })} />}
      />
      {draft.trimOpen && (
        <div className="animate-fade-in">
          <div className="grid grid-cols-2 gap-2">
            <TextInput
              mono
              placeholder="Start 0:00"
              value={draft.trimStart}
              onChange={(e) => update({ trimStart: e.target.value })}
              aria-label="Start time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
            <TextInput
              mono
              placeholder="End"
              value={draft.trimEnd}
              onChange={(e) => update({ trimEnd: e.target.value })}
              aria-label="End time"
              aria-invalid={Boolean(trimError)}
              aria-describedby="trim-help"
            />
          </div>
          <p id="trim-help" role={trimError ? 'alert' : undefined} className={cn('mt-1.5 text-2xs', trimError ? 'text-danger' : 'text-ink-subtle')}>
            {trimError ?? 'Use seconds (90) or mm:ss (1:30).'}
          </p>
        </div>
      )}
    </div>
  )
}

/** Format, framing and pacing. Exported for the keyboard-navigation test. */
export function FormatStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const review = draft.workflow === 'review'
  const formats = review ? FORMATS.filter((f) => f.id !== '1:1') : FORMATS
  const toggleFormat = (id: WizardAspectRatio): void => {
    if (review || draft.aspectRatios.includes(id)) {
      const next = draft.aspectRatios.filter((r) => r !== id)
      if (review || next.length === 0) update({ aspectRatios: [id] })
      else update({ aspectRatios: next })
    } else update({ aspectRatios: [...draft.aspectRatios, id] })
  }
  return (
    <div className="space-y-4">
      <Group label="Format" aside={!review && draft.aspectRatios.length > 1 ? `${draft.aspectRatios.length} formats · ${draft.aspectRatios.join(' + ')}` : undefined}>
        <div className={cn('grid gap-2', review ? 'grid-cols-2' : 'grid-cols-3')} role="group" aria-label="Format">
          {formats.map((f) => {
            const selected = draft.aspectRatios.includes(f.id)
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleFormat(f.id)}
                className={cn('glass-tile glass-tile-hover flex items-center gap-3 rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}
              >
                <span className="flex h-6 w-7 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      'rounded-[4px] border-[1.5px] transition-colors duration-200',
                      selected ? 'border-accent bg-accent/25' : 'border-ink-subtle bg-white/[0.04]'
                    )}
                    style={{ width: f.w, height: f.h }}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">
                    {f.label} <span className="font-mono text-2xs font-normal text-ink-subtle">{f.id}</span>
                  </span>
                  <span className="block truncate text-2xs text-ink-subtle">{f.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
        {!review && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={draft.aspectRatios.join() === '9:16,1:1'}
              onClick={() => update({ aspectRatios: ['9:16', '1:1'] })}
            >
              Auto for my platforms
            </Button>
            {draft.aspectRatios.length > 1 && (
              <p className="text-2xs text-ink-subtle">Extra formats reuse each clip's framing and edits — two formats roughly double render time, with no extra AI cost.</p>
            )}
          </div>
        )}
      </Group>

      {draft.aspectRatios.some((ratio) => ratio !== '16:9') && (
        <Group label="Framing">
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Framing">
            {LAYOUT_STYLES.map((style) => {
              const selected = draft.layoutStyle === style.id
              return (
                <button
                  key={style.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  onKeyDown={onRadioKeyDown}
                  onClick={() => update({ layoutStyle: style.id })}
                  className={cn(
                    'glass-tile glass-tile-hover flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left',
                    selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                  )}
                >
                  <FramingGlyph style={style.id} selected={selected} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">{style.label}</span>
                    <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{style.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          {draft.layoutStyle === 'auto' && draft.clippingMode === 'economy' && (
            <p className="mt-2 text-2xs text-ink-subtle">AI vision checks are off in Economy mode.</p>
          )}
          {draft.layoutStyle === 'auto' && draft.clippingMode !== 'economy' && (
            <SettingRow
              className="mt-2"
              title="Check tricky shots with AI vision"
              description="Checks uncertain shots. May add OpenRouter charges."
              control={<Switch label="AI vision for smart framing" checked={draft.layoutVision} onChange={(layoutVision) => update({ layoutVision })} />}
            />
          )}
        </Group>
      )}

      <Group label="Pacing">
        <SettingRow
          title="Cut dead air"
          description="Proposes pause and filler cuts. When enabled, Jev checks each removal."
          control={
            <Switch label="Cut dead air and filler words" checked={draft.pacing === 'tight'} onChange={(on) => update({ pacing: on ? 'tight' : 'natural' })} />
          }
        />
      </Group>

      <Group label="Video speed" aside="All clips in this job">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" role="radiogroup" aria-label="Video speed" aria-describedby="video-speed-help">
          {VIDEO_SPEED_OPTIONS.map((speed) => {
            const selected = (draft.videoSpeed ?? 1) === speed
            return (
              <button key={speed} type="button" role="radio" aria-checked={selected}
                aria-label={`${speed}×${speed === 1 ? ' (Normal)' : ''}`}
                tabIndex={selected ? 0 : -1} onKeyDown={onRadioKeyDown}
                onClick={() => update({ videoSpeed: speed })}
                className={cn('glass-tile glass-tile-hover rounded-xl px-2 py-2 text-center', selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                <span className="block font-mono text-sm tabular">{speed}×</span>
                <span className="block text-2xs text-ink-subtle">{speed === 1 ? 'Normal' : `${Math.round(60 / speed)}s per minute`}</span>
              </button>
            )
          })}
        </div>
        <p id="video-speed-help" className="mt-2 text-2xs text-ink-subtle">Speeds up every exported clip, keeping voice pitch natural and captions in sync. Faster clips are shorter.</p>
      </Group>
    </div>
  )
}

export function ClipsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const jevEnabled = useSettingsStore((s) => s.jevEnabled === 'on')
  const localProvider = useSettingsStore((s) => s.aiProvider === 'local')
  const nvidiaProvider = useSettingsStore((s) => s.aiProvider === 'nvidia')
  const localPlannerModel = useSettingsStore((s) => s.localPlannerModel)
  const nvidiaPlannerModel = useSettingsStore((s) => s.nvidiaPlannerModel)
  const localWhisperModel = useSettingsStore((s) => s.localWhisperModel)
  const toggleDuration = (id: string): void => {
    update({ durations: draft.durations.includes(id) ? draft.durations.filter((d) => d !== id) : [...draft.durations, id] })
  }
  return (
    <div className="space-y-4">
      <Group label="What to clip" aside="Optional">
        <TextArea
          rows={3}
          maxLength={CLIP_REQUEST_MAX_CHARS}
          value={draft.clipRequest ?? ''}
          onChange={(e) => update({ clipRequest: e.target.value })}
          aria-label="What to clip"
          aria-describedby="clip-request-help"
          placeholder="e.g. every time they talk about pricing, or the funniest reactions"
        />
        <p id="clip-request-help" className="mt-2 text-2xs text-ink-subtle">Only matching moments are clipped, so you may get fewer clips, or none. Leave blank for the best moments.</p>
      </Group>
      <Group label="Clipping mode">
        {localProvider ? (
          <div className="glass-tile rounded-xl px-3 py-2.5" aria-label="Offline clipping mode">
            <span className="block text-sm font-medium text-ink">Offline · {localPlannerModel} planning · Whisper {localWhisperModel} transcription</span>
            <span className="block text-2xs text-ink-subtle">Runs entirely on this computer. Change models in Settings → Local AI; Jev review and web research are skipped offline.</span>
          </div>
        ) : nvidiaProvider ? (
          <div className="glass-tile rounded-xl px-3 py-2.5" aria-label="Free NVIDIA clipping mode">
            <span className="block text-sm font-medium text-ink">Free · {nvidiaPlannerModel} planning · Whisper {localWhisperModel} transcription</span>
            <span className="block text-2xs text-ink-subtle">Planning runs on NVIDIA’s free cloud tier (about 40 requests per minute); transcription runs on this computer. Change models in Settings → AI provider; Jev review and web research are skipped.</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Clipping mode">
              {([
                { id: 'quality', label: 'Quality', hint: `GPT-6 Sol planning · ${draft.workflow === 'review' ? 'Jev review required' : `Jev review & repairs ${jevEnabled ? 'enabled' : 'off'}`} · MAI Transcribe 2` },
                { id: 'economy', label: 'Economy', hint: 'GLM 5.3 Flash planning · Whisper Turbo' },
                { id: 'advanced', label: 'Advanced', hint: 'Choose your OpenRouter models' }
              ] as const).map((mode) => {
                const selected = draft.clippingMode === mode.id
                return <button key={mode.id} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1}
                  onKeyDown={onRadioKeyDown} onClick={() => update({ clippingMode: mode.id })}
                  className={cn('glass-tile glass-tile-hover rounded-xl px-3 py-2.5 text-left', selected && 'glass-selected')}>
                  <span className="block text-sm font-medium text-ink">{mode.label}</span>
                  <span className="block text-2xs text-ink-subtle">{mode.hint}</span>
                </button>
              })}
            </div>
            {draft.clippingMode === 'advanced' && <AdvancedModels draft={draft} update={update} />}
          </>
        )}
      </Group>
      <Group label="Clip length" aside={draft.durations.length === 0 ? 'Any length' : `${draft.durations.length} selected`}>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7" role="group" aria-label="Clip length options">
          {DURATIONS.map((d) => {
            const selected = draft.durations.includes(d.id)
            return (
              <button
                key={d.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleDuration(d.id)}
                className={cn(
                  'glass-tile glass-tile-hover rounded-xl px-1 py-1.5 text-center',
                  selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink'
                )}
              >
                <span className="block font-mono text-xs tabular">{d.range}</span>
                <span className={cn('block truncate text-2xs', selected ? 'text-ink-muted' : 'text-ink-subtle')}>{d.label}</span>
              </button>
            )
          })}
        </div>
        {(draft.videoSpeed ?? 1) > 1 && <p className="mt-2 text-2xs text-ink-subtle">Lengths refer to the original footage. At {draft.videoSpeed}×, 60 seconds becomes about {Math.round(60 / draft.videoSpeed)} seconds before dead-air cuts.</p>}
      </Group>

      <Group label="Number of clips">
        <SettingRow
          title="Let AI decide"
          description="Every moment worth posting."
          control={<Switch label="Let AI decide how many clips" checked={draft.autoClipCount} onChange={(autoClipCount) => update({ autoClipCount })} />}
        />
        {!draft.autoClipCount && (
          <div className="mt-2 flex max-w-xs items-center gap-2 animate-fade-in">
            <Button
              iconOnly
              aria-label="Fewer clips"
              onClick={() => update({ maxClips: Math.max(1, draft.maxClips - 1) })}
              disabled={draft.maxClips <= 1}
              icon={<Minus className="h-3.5 w-3.5" />}
            />
            <TextInput
              className="flex-1 rounded-full [&_input]:text-center"
              inputMode="numeric"
              value={String(draft.maxClips)}
              onChange={(e) => {
                const n = parseInt(e.target.value.replace(/\D/g, ''), 10)
                update({ maxClips: Number.isFinite(n) ? Math.min(MAX_CLIPS, Math.max(1, n)) : 1 })
              }}
              aria-label="Maximum clips"
              mono
            />
            <Button
              iconOnly
              aria-label="More clips"
              onClick={() => update({ maxClips: Math.min(MAX_CLIPS, draft.maxClips + 1) })}
              disabled={draft.maxClips >= MAX_CLIPS}
              icon={<Plus className="h-3.5 w-3.5" />}
            />
          </div>
        )}
      </Group>
    </div>
  )
}

export function CaptionsStep({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {draft.workflow !== 'review' && (
        <SettingRow
          title="Show title at the top"
          description="Each clip's title over the video. Turn off to leave it out."
          control={<Switch label="Title at the top" checked={draft.includeTitle} onChange={(includeTitle) => update({ includeTitle })} />}
        />
      )}
      <SettingRow
        title="Burn in captions"
        description="Turn off for clips without word-by-word captions."
        control={<Switch label="Captions" checked={draft.includeCaptions} onChange={(includeCaptions) => update({ includeCaptions })} />}
      />
      <SettingRow
        title="Use your own .srt transcript"
        description={draft.srtName ? `Uploaded: ${draft.srtName}. AI transcription is skipped for this video.` : 'Optional. Perfectly timed captions for difficult speech, branded content, or videos that already have clean subtitles.'}
        control={
          <div className="flex items-center gap-2">
            {draft.srtName && (
              <Button size="sm" variant="ghost" aria-label="Remove the uploaded .srt" onClick={() => update({ srtPath: null, srtName: null })}>Remove</Button>
            )}
            <Button size="sm" disabled={!draft.includeCaptions} onClick={async () => {
              const picked = await getApi().dialog.selectSrt()
              if (picked) {
                update({ srtPath: picked, srtName: basename(picked) })
              }
            }}>{draft.srtName ? 'Change .srt' : 'Upload .srt'}</Button>
          </div>
        }
      />
      <div className={cn('transition-opacity duration-300 ease-out', !draft.includeCaptions && 'opacity-80')}>
        <CaptionPresetPicker
          showPreview
          value={draft.captionPreset}
          onChange={(captionPreset) => update({ captionPreset, includeCaptions: true })}
          allowNone
          noneSelected={!draft.includeCaptions}
          onSelectNone={() => update({ includeCaptions: false })}
        />
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-ink">
        <span>Only add caption without clipping <span className="text-ink-subtle">Beta</span> — caption the whole video as one clip</span>
        <input type="checkbox" aria-label="Only add caption without clipping" checked={draft.captionsOnly}
          onChange={(e) => update({ captionsOnly: e.target.checked, includeCaptions: true })} />
      </label>
    </div>
  )
}

function ReviewStep({ draft, trim, onEdit }: {
  draft: ClipDraft
  trim: { start: number | null; end: number | null }
  onEdit: (step: WizardStep) => void
}): React.JSX.Element {
  const active = useActiveJobs()
  const aiProvider = useSettingsStore((s) => s.aiProvider)
  const runningCount = active.filter((job) => job.status !== 'queued').length
  const lengths = draft.durations.length === 0
    ? 'Any length'
    : DURATIONS.filter((d) => draft.durations.includes(d.id)).map((d) => d.range).join(', ')
  const review = draft.workflow === 'review'
  const ratios: WizardAspectRatio[] = review
    ? (draft.aspectRatios[0] === '1:1' ? ['9:16'] : draft.aspectRatios.slice(0, 1))
    : draft.aspectRatios
  const framing = ratios.some((ratio) => ratio !== '16:9')
    ? `${LAYOUT_STYLES.find((s) => s.id === draft.layoutStyle)?.label ?? 'Smart'} framing${draft.clippingMode !== 'economy' && draft.layoutStyle === 'auto' && draft.layoutVision ? ' · AI vision' : ''}`
    : 'Whole frame'
  const formatNames = ratios.map((r) => `${FORMATS.find((f) => f.id === r)?.label ?? r} ${r}`).join(' + ')
  const trimLabel = draft.trimOpen && (trim.start != null || trim.end != null)
    ? ` · ${trim.start != null ? formatSeconds(trim.start) : 'start'} to ${trim.end != null ? formatSeconds(trim.end) : 'end'}`
    : ''

  const rows: { step: WizardStep; label: string; value: string }[] = [
    { step: 'video', label: 'Workflow', value: draft.workflow === 'review' ? 'Review & edit · export when ready' : 'Automatic' },
    { step: 'video', label: 'Video', value: `${sourceLabel(draft.source)}${trimLabel}` },
    { step: 'format', label: 'Format', value: `${formatNames} · ${framing}` },
    { step: 'format', label: 'Pacing', value: draft.workflow === 'review' ? 'Manual · choose your own cuts in the editor' : draft.pacing === 'tight' ? 'Cut dead air' : 'Keep pauses' },
    { step: 'format', label: 'Speed', value: `${draft.videoSpeed ?? 1}×${(draft.videoSpeed ?? 1) === 1 ? ' · Normal' : ' · All exported clips'}` },
    { step: 'clips', label: 'Mode', value: draft.clippingMode === 'advanced' ? 'Advanced · custom models' : draft.clippingMode === 'economy' ? 'Economy · lower cost' : 'Quality · higher accuracy' },
    { step: 'clips', label: 'Clips', value: `${lengths}${(draft.videoSpeed ?? 1) > 1 && draft.durations.length > 0 ? ' of source footage' : ''} · ${draft.autoClipCount ? 'AI decides how many' : `Up to ${draft.maxClips}`}` },
    { step: 'clips', label: 'What to clip', value: draft.clipRequest?.trim() || 'The best moments' },
    { step: 'captions', label: 'Captions', value: draft.includeCaptions ? CAPTION_PRESET_NAMES[draft.captionPreset] ?? draft.captionPreset : 'Off' }
  ]
  if (draft.workflow !== 'review') rows.push({ step: 'captions', label: 'Title', value: draft.includeTitle ? 'Shown at the top' : 'Off' })
  if (draft.bannerPlatform && draft.bannerChannelUrl) rows.push({ step: 'format', label: 'Banner', value: `${draft.bannerPlatform} · ${draft.bannerChannelUrl}` })
  if (draft.clippingMode === 'advanced') rows.splice(5, 0,
    { step: 'clips', label: 'Transcribe', value: draft.transcriptionModel || 'Choose a model' },
    { step: 'clips', label: 'Plan', value: draft.plannerModel || 'Choose a model' })

  return (
    <div className="space-y-3">
      <dl className="glass-well divide-y divide-white/[0.05] overflow-hidden rounded-xl">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3 px-3 py-2">
            <dt className="w-20 shrink-0 text-xs text-ink-subtle">{row.label}</dt>
            <dd className="min-w-0 flex-1 truncate text-sm text-ink" title={row.value}>{row.value}</dd>
            <Button size="sm" variant="ghost" onClick={() => onEdit(row.step)} aria-label={`Edit ${row.label.toLowerCase()}`}>
              Edit
            </Button>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 text-2xs text-ink-subtle">
        <Clock3 className="mt-px h-3.5 w-3.5 shrink-0" />
        {runningCount >= MAX_PARALLEL_JOBS
          ? `${runningCount} jobs are running. This one waits in the queue and starts automatically.`
          : active.length > 0
            ? `Runs alongside ${active.length} other job${active.length === 1 ? '' : 's'}. Up to ${MAX_PARALLEL_JOBS} run at once.`
            : aiProvider === 'local'
              ? 'Runs on this computer; nothing leaves the machine.'
              : aiProvider === 'nvidia'
                ? 'Runs on this computer. Planning uses NVIDIA’s free tier; transcription stays local.'
                : 'Runs on this computer. Transcription and clip planning bill your OpenRouter account.'}
      </p>
    </div>
  )
}

function StartedPanel({ className, onViewJob }: { className?: string; onViewJob?: (jobId: string) => void }): React.JSX.Element | null {
  const started = useDraftStore((s) => s.started)
  const startAnother = useDraftStore((s) => s.startAnother)
  if (!started) return null
  return (
    <Panel className={cn('flex flex-col items-center px-5 py-8 text-center animate-fade-in', className)}>
      <IconTile tone="success" size="lg">
        <CheckCircle2 />
      </IconTile>
      <h2 className="mt-3 text-base font-semibold text-ink">{started.queued ? 'Queued' : 'Clipping started'}</h2>
      <p className="mt-1 max-w-md truncate text-sm text-ink-muted" title={started.source}>{sourceLabel(started.source)}</p>
      <p className="mt-1 max-w-md text-xs text-ink-subtle">
        {started.queued
          ? `Up to ${MAX_PARALLEL_JOBS} jobs run at once. This one starts as soon as a slot frees up.`
          : 'It keeps running while you queue more videos or use the rest of BridgeClip.'}
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={startAnother}>
          Clip another video
        </Button>
        {onViewJob && (
          <Button icon={<ListVideo className="h-3.5 w-3.5" />} onClick={() => onViewJob(started.jobId)}>
            View job
          </Button>
        )}
      </div>
    </Panel>
  )
}

function AdvancedModels({ draft, update }: { draft: ClipDraft; update: Update }): React.JSX.Element {
  const { catalog, loading, error, load } = useModelStore()
  useEffect(() => { void load() }, [load])
  return <div className="mt-3 space-y-4 rounded-xl border border-white/10 p-3">
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-ink-muted">Search OpenRouter’s live model catalog.</p>
      <Button size="sm" variant="ghost" loading={loading} disabled={loading} onClick={() => void load(true)}>Refresh models</Button>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    <ModelPicker task="transcription" models={catalog?.transcription ?? []} value={draft.transcriptionModel} loading={loading}
      onChange={(transcriptionModel) => update({ transcriptionModel })} />
    <ModelPicker task="planning" models={catalog?.planning ?? []} value={draft.plannerModel} loading={loading}
      onChange={(plannerModel) => update({ plannerModel })} />
    <p className="text-2xs text-ink-subtle">Temporary errors are retried with your selected models. No automatic model switching. Usage bills your OpenRouter account. Optional AI framing checks use Gemini and can be changed in Format.</p>
  </div>
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60)
  const s = Math.floor(total % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Tiny 9:16 diagram of a framing style: split panels, full bleed, or letterbox. */
function FramingGlyph({ style, selected }: { style: 'auto' | 'fill' | 'fit'; selected: boolean }): React.JSX.Element {
  const fill = selected ? 'bg-accent' : 'bg-ink-subtle/60'
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[24px] w-[14px] shrink-0 flex-col gap-px overflow-hidden rounded-[4px] border-[1.5px] p-px transition-colors duration-200',
        selected ? 'border-accent' : 'border-ink-subtle'
      )}
    >
      {style === 'auto' && (
        <>
          <span className={cn('flex-1 rounded-[1px]', fill)} />
          <span className={cn('flex-1 rounded-[1px] opacity-60', fill)} />
        </>
      )}
      {style === 'fill' && <span className={cn('flex-1 rounded-[1px]', fill)} />}
      {style === 'fit' && <span className={cn('my-auto h-[6px] rounded-[1px]', fill)} />}
    </span>
  )
}

function Group({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {aside && <span className="text-2xs text-ink-subtle">{aside}</span>}
      </div>
      {children}
    </div>
  )
}
