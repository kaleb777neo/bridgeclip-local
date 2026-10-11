import { useCallback, useEffect, useState, type CSSProperties, type ReactNode, type SelectHTMLAttributes } from 'react'
import { ArrowUpLeft, Copy, Film, ImagePlus, Pencil, Plus, Shapes, Trash2, X } from 'lucide-react'
import { cn, errorMessage, localFileUrl } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { useSettingsStore } from '../store/use-settings-store'
import { uniqueTemplateId } from '../lib/template-id'
import { templateBannerPlatforms, templateFramingStyles, templateFormats, templatePacingStyles, type BrandTemplate, type TemplateBannerPlatform, type TemplateFramingStyle, type TemplateFormat, type TemplatePacing } from '../../shared/templates'
import { type OverlayPosition, type CaptionStyleOverrides } from '../../shared/clip-editor'
import type { SavedCaptionStyle } from '../../shared/caption-styles'
import { CaptionPresetPicker, CAPTION_PRESET_NAMES, applyCaptionStyleOverrides, captionPreviewPreset, textShadow } from '../components/CaptionPresetPicker'
import { Page } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { Callout } from '../components/ui/Callout'
import { ConfirmDialog, type ConfirmRequest } from '../components/ui/ConfirmDialog'
import { TextInput } from '../components/ui/Field'
import { SettingRow } from '../components/ui/SettingRow'
import { Switch } from '../components/ui/Switch'

const TITLE = 'Templates'

const FORMAT_INFO: Record<TemplateFormat, { label: string; hint: string }> = {
  '9:16': { label: 'Vertical', hint: 'Shorts, Reels, TikTok' },
  '1:1': { label: 'Square', hint: 'Feed, X, LinkedIn' },
  '16:9': { label: 'Horizontal', hint: 'YouTube, Threads' }
}

const positionLabels: Record<OverlayPosition, string> = {
  'top-left': 'Top left', 'top-right': 'Top right', center: 'Center', 'bottom-left': 'Bottom left', 'bottom-right': 'Bottom right'
}

/** The editable shape of a pack; kept out of BrandTemplate so the logo file pick survives. */
interface LogoDraft { position: OverlayPosition; scale: number; opacity: number }

interface TemplateFormState {
  /** Existing user pack id when editing; null for a new pack (create or duplicate). */
  id: string | null
  name: string
  captionPresetId: string
  /** Customisation layered on the preset; null = the plain preset. */
  captionStyle: CaptionStyleOverrides | null
  /** Ordered, primary first; the click order is the render order. */
  formats: TemplateFormat[]
  logo: LogoDraft | null
  /** Absolute path picked via dialog:selectImage; main copies it on save. */
  logoPath: string | null
  /** Stored intro/outro display names; null when the pack has none. */
  intro: string | null
  outro: string | null
  /** Absolute paths picked via dialog:selectVideo; main copies them on save. */
  introPath: string | null
  outroPath: string | null
  badge: 'none' | 'subscribe' | 'follow'
  badgePosition: OverlayPosition
  /** Percent (0–5) applied to all four corners as safe-zone insets. */
  safeZonePct: number
  /** '' keeps the field unset so the wizard's own choice survives. */
  pacing: '' | TemplatePacing
  layoutStyle: '' | TemplateFramingStyle
  /** Title card at the top of Automatic clips; packs saved from this form always state it. */
  includeTitle: boolean
  /** '' means no channel banner; otherwise platform + URL are saved together. */
  bannerPlatform: '' | TemplateBannerPlatform
  bannerUrl: string
}

const emptyForm = (): TemplateFormState => ({
  id: null,
  name: '',
  captionPresetId: 'pop',
  captionStyle: null,
  formats: ['9:16'],
  logo: null,
  logoPath: null,
  intro: null,
  outro: null,
  introPath: null,
  outroPath: null,
  badge: 'none',
  badgePosition: 'bottom-right',
  safeZonePct: 0,
  pacing: '',
  layoutStyle: '',
  includeTitle: true,
  bannerPlatform: '',
  bannerUrl: ''
})

const formFromTemplate = (template: BrandTemplate, duplicate: boolean): TemplateFormState => {
  const firstMargin = Object.values(template.safeZones ?? {})[0] ?? 0
  return {
    id: duplicate ? null : template.id,
    name: duplicate ? `${template.name} copy` : template.name,
    captionPresetId: template.captionPresetId,
    captionStyle: template.captionStyle ?? null,
    formats: [...template.formats],
    logo: template.logo ? { ...template.logo } : null,
    logoPath: null,
    intro: template.intro ?? null,
    outro: template.outro ?? null,
    introPath: null,
    outroPath: null,
    badge: template.badge?.kind ?? 'none',
    badgePosition: template.badge?.position ?? 'bottom-right',
    safeZonePct: Math.round(firstMargin * 100),
    pacing: template.pacing ?? '',
    layoutStyle: template.layoutStyle ?? '',
    includeTitle: template.includeTitle ?? true,
    bannerPlatform: template.banner?.platform ?? '',
    bannerUrl: template.banner?.channelUrl ?? ''
  }
}

function templateToForm(template: BrandTemplate): Omit<TemplateFormState, 'id' | 'logoPath' | 'introPath' | 'outroPath'> {
  const form = formFromTemplate(template, true)
  return { name: form.name, captionPresetId: form.captionPresetId, captionStyle: form.captionStyle, formats: form.formats, logo: form.logo, intro: form.intro, outro: form.outro, badge: form.badge, badgePosition: form.badgePosition, safeZonePct: form.safeZonePct, pacing: form.pacing, layoutStyle: form.layoutStyle, includeTitle: form.includeTitle, bannerPlatform: form.bannerPlatform, bannerUrl: form.bannerUrl }
}

export function TemplatesPage(): React.JSX.Element {
  const [templates, setTemplates] = useState<BrandTemplate[] | null>(null)
  const [defaultId, setDefaultId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [form, setForm] = useState<TemplateFormState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  /** Saved caption styles, offered in the form's picker. */
  const [captionStyles, setCaptionStyles] = useState<SavedCaptionStyle[]>([])
  const closeConfirm = useCallback(() => setConfirm(null), [])

  useEffect(() => {
    let active = true
    // A renderer hot-reloaded over an older preload has no caption-styles bridge.
    void getApi().captionStyles?.list().then((list) => { if (active) setCaptionStyles(list) }).catch(() => {})
    return () => { active = false }
  }, [reload])

  const refreshCaptionStyles = (): void => {
    void getApi().captionStyles?.list().then(setCaptionStyles).catch(() => {})
  }

  useEffect(() => {
    let active = true
    Promise.all([getApi().templates.list(), getApi().settings.load()])
      .then(([list, settings]) => { if (active) { setTemplates(list); setDefaultId(settings.defaultTemplateId ?? ''); setError(null) } })
      .catch((e: unknown) => { if (active) { setTemplates([]); setError(errorMessage(e)) } })
    return () => { active = false }
  }, [reload])

  const refresh = (): void => setReload((n) => n + 1)

  const remove = (template: BrandTemplate): void => {
    setConfirm({
      title: `Delete “${template.name}”?`,
      body: 'The pack and its uploaded assets (logo, intro, outro) are removed. Jobs already queued keep their snapshot.',
      confirmLabel: 'Delete template',
      confirmAriaLabel: `Confirm delete ${template.name}`,
      onConfirm: () => {
        getApi().templates.delete(template.id)
          .then(() => refresh())
          .catch((e: unknown) => setError(errorMessage(e)))
      }
    })
  }

  const setDefault = async (template: BrandTemplate): Promise<void> => {
    const next = defaultId === template.id ? '' : template.id
    try {
      // The settings store merges partial updates; only the default template changes here.
      const settingsState = useSettingsStore.getState()
      await settingsState.save({ defaultTemplateId: next })
      setDefaultId(next)
    } catch (e) { setError(errorMessage(e)) }
  }

  const builtIn = (templates ?? []).filter((t) => t.builtIn)
  const userTemplates = (templates ?? []).filter((t) => !t.builtIn)

  return (
    <Page width="default">
      <PageHeader
        title={TITLE}
        description="Brand packs apply a logo, CTA badge, caption style and formats to a job when you pick it in Create. Manual edits in the wizard always win."
        actions={!form && templates && templates.length > 0
          ? <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm(emptyForm())}>New template</Button>
          : undefined}
      />
      <div className="mt-4 space-y-3">
        {error && <Callout tone="danger">{error}</Callout>}
        {templates === null ? (
          <Panel><p role="status" className="text-xs text-ink-muted">Loading your brand packs…</p></Panel>
        ) : form ? (
          <TemplateFormPanel
            form={form}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onSaved={() => { setForm(null); refresh() }}
            takenIds={templates.map((t) => t.id)}
            captionStyles={captionStyles}
            onDeleteCaptionStyle={(id) => { void getApi().captionStyles?.delete(id).then(setCaptionStyles).catch(() => {}); refreshCaptionStyles() }}
          />
        ) : (
          <>
            {templates.length === 0 ? (
              <EmptyState
                icon={<Shapes />}
                title="No brand packs yet"
                description="Built-in packs ship read-only; save your own from the Templates form or from the editor's Brand tab."
                action={<Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setForm(emptyForm())}>New template</Button>}
              />
            ) : (
              <>
                {builtIn.length > 0 && (
                  <Panel padded={false} className="overflow-hidden">
                    <PanelHeader className="px-4 pt-4" title="Built-in" description="Shipped with BridgeClip. Duplicate one to make it yours." />
                    <div className="grid gap-3 px-4 pb-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">
                      {builtIn.map((t) => (
                        <TemplateCard key={t.id} template={t} defaultId={defaultId}>
                          <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => setForm(formFromTemplate(t, true))}>Duplicate</Button>
                        </TemplateCard>
                      ))}
                    </div>
                  </Panel>
                )}
                <Panel padded={false} className="overflow-hidden">
                  <PanelHeader className="px-4 pt-4" title="Your templates" description="Editable packs; picking one in Create applies it to the draft." />
                  {userTemplates.length === 0 ? (
                    <p className="px-4 pb-4 pt-3 text-xs text-ink-muted">Nothing saved yet — create one, or duplicate a built-in pack above.</p>
                  ) : (
                    <div className="grid gap-3 px-4 pb-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">
                      {userTemplates.map((t) => (
                        <TemplateCard key={t.id} template={t} defaultId={defaultId}>
                          <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setForm(formFromTemplate(t, false))}>Edit</Button>
                          <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => setForm(formFromTemplate(t, true))}>Duplicate</Button>
                          <Button size="sm" variant={defaultId === t.id ? 'secondary' : 'ghost'} disabled={builtIn.some((b) => b.id === t.id)}
                            onClick={() => { void setDefault(t) }}>{defaultId === t.id ? 'Default' : 'Set as default'}</Button>
                          <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>Delete</Button>
                        </TemplateCard>
                      ))}
                    </div>
                  )}
                </Panel>
              </>
            )}
          </>
        )}
      </div>
      {confirm && <ConfirmDialog request={confirm} onClose={closeConfirm} />}
    </Page>
  )
}

/** One pack tile: a small phone-frame preview plus the pack summary. */
function TemplateCard({ template, children, defaultId }: { template: BrandTemplate; children: ReactNode; defaultId: string }): React.JSX.Element {
  const summary: string[] = [
    `${CAPTION_PRESET_NAMES[template.captionPresetId] ?? template.captionPresetId}${template.captionStyle ? ' (customized)' : ''}`,
    template.formats.join(' + '),
    template.logo ? `Logo ${positionLabels[template.logo.position].toLowerCase()}` : 'No logo',
    template.intro && template.outro ? 'Intro + outro' : template.intro ? 'Intro video' : template.outro ? 'Outro video' : null,
    template.badge ? `${template.badge.kind === 'subscribe' ? 'Subscribe' : 'Follow'} badge` : 'No badge',
    template.banner ? `${BANNER_PLATFORM_LABELS[template.banner.platform]} banner` : 'No banner',
    template.pacing === 'tight' ? 'Tight pacing' : template.pacing === 'natural' ? 'Natural pacing' : null,
    template.includeTitle === false ? 'Title off' : null
  ].filter((item): item is string => item !== null)
  return (
    <div className="glass-tile flex gap-3 rounded-xl p-3">
      <PreviewFrame preview={templateToForm(template)} logoPath={null} storedLogo={Boolean(template.logo)} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-medium text-ink" title={template.name}>
          {template.name}
          {template.builtIn && <Badge tone="neutral">Built-in</Badge>}
          {defaultId === template.id && <Badge tone="neutral">Default</Badge>}
        </p>
        <p className="mt-0.5 truncate text-2xs text-ink-subtle" title={summary.join(' · ')}>{summary.join(' · ')}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">{children}</div>
      </div>
    </div>
  )
}

interface PreviewProps {
  name?: string
  captionPresetId: string
  captionStyle?: CaptionStyleOverrides | null
  formats: TemplateFormat[]
  logo: LogoDraft | null
  badge: 'none' | 'subscribe' | 'follow'
  badgePosition: OverlayPosition
  safeZonePct: number
}

const insetStyle = (position: OverlayPosition, marginPct: number): CSSProperties => {
  const m = `${marginPct + 7}%`
  if (position === 'top-left') return { top: m, left: m }
  if (position === 'top-right') return { top: m, right: m }
  if (position === 'bottom-left') return { bottom: m, left: m }
  if (position === 'bottom-right') return { bottom: m, right: m }
  return { top: '44%', left: '50%', transform: 'translateX(-50%)' }
}

/** Approximate phone-frame preview (CSS only, like the editor's Brand tab). The export is exact. */
function PreviewFrame({ preview, logoPath, storedLogo, className }: {
  preview: PreviewProps
  logoPath: string | null
  /** True when the pack config has a logo but the file lives in main (not previewable here). */
  storedLogo: boolean
  className?: string
}): React.JSX.Element {
  const base = captionPreviewPreset(preview.captionPresetId)
  const preset = preview.captionStyle ? applyCaptionStyleOverrides(base, preview.captionStyle) : base
  const captionStyle: CSSProperties = {
    color: preset.primary,
    fontFamily: preset.font,
    fontWeight: preset.weight,
    fontSize: 10,
    textShadow: textShadow(preset, 0.8),
    textTransform: preset.uppercase ? 'uppercase' : 'none'
  }
  return (
    <div aria-hidden="true" className={cn('relative h-40 w-[86px] shrink-0 overflow-hidden rounded-[14px] border-2 border-white/15 bg-[#14161d] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.6)]', className)}>
      <span className="absolute left-1/2 top-1 h-1 w-8 -translate-x-1/2 rounded-full bg-white/10" />
      {preview.logo && (logoPath || storedLogo) && (
        logoPath
          ? <img src={localFileUrl(logoPath)} alt="" className="absolute rounded" style={{ ...insetStyle(preview.logo.position, preview.safeZonePct), width: `${preview.logo.scale * 100}%`, opacity: preview.logo.opacity }} />
          : <span className="absolute rounded bg-white/15 text-center text-[6px] leading-[1.6] text-ink-muted" style={{ ...insetStyle(preview.logo.position, preview.safeZonePct), width: `${preview.logo.scale * 100}%`, height: `${preview.logo.scale * 60}%`, opacity: preview.logo.opacity }}>LOGO</span>
      )}
      {preview.badge !== 'none' && (
        <span className={cn('absolute rounded-full px-1.5 py-0.5 text-[7px] font-bold tracking-wide', preview.badge === 'subscribe' ? 'bg-danger text-white' : 'bg-accent text-accent-ink')} style={insetStyle(preview.badgePosition, preview.safeZonePct)}>
          {preview.badge.toUpperCase()}
        </span>
      )}
      <span className="absolute inset-x-2 bottom-6 block text-center leading-tight" style={captionStyle}>
        your captions
      </span>
      <span className="absolute inset-x-0 bottom-1 text-center text-[7px] text-ink-faint">{preview.formats[0]}{preview.formats.length > 1 ? ` +${preview.formats.length - 1}` : ''}</span>
    </div>
  )
}

function TemplateFormPanel({ form, onChange, onCancel, onSaved, takenIds, captionStyles = [], onDeleteCaptionStyle }: {
  form: TemplateFormState
  onChange: (form: TemplateFormState) => void
  onCancel: () => void
  onSaved: () => void
  takenIds: string[]
  /** Saved caption styles, offered as picker tiles next to the built-ins. */
  captionStyles?: SavedCaptionStyle[]
  onDeleteCaptionStyle?: (id: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<TemplateFormState>): void => onChange({ ...form, ...patch })

  const toggleFormat = (id: TemplateFormat): void => {
    if (form.formats.includes(id)) {
      const next = form.formats.filter((f) => f !== id)
      set({ formats: next.length ? next : [id] })
    } else set({ formats: [...form.formats, id] })
  }
  const makePrimary = (id: TemplateFormat): void => set({ formats: [id, ...form.formats.filter((f) => f !== id)] })

  const pickLogo = async (): Promise<void> => {
    try {
      const path = await getApi().dialog.selectImage()
      if (!path) return
      set({ logoPath: path, logo: form.logo ?? { position: 'bottom-right', scale: 0.15, opacity: 0.9 } })
    } catch (e) { setError(errorMessage(e)) }
  }

  const pickVideo = async (slot: 'intro' | 'outro'): Promise<void> => {
    try {
      const path = await getApi().dialog.selectVideo()
      if (!path) return
      set(slot === 'intro' ? { introPath: path, intro: path.split(/[\\/]/).pop() ?? path } : { outroPath: path, outro: path.split(/[\\/]/).pop() ?? path })
    } catch (e) { setError(errorMessage(e)) }
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim()) { setError('Give the template a name.'); return }
    if (form.badge !== 'none' && !form.badgePosition) return
    const bannerUrl = form.bannerUrl.trim()
    if (form.bannerPlatform && !bannerUrl) { setError('Add the channel URL for the banner.'); return }
    if (form.bannerPlatform && !/^https?:\/\//i.test(bannerUrl)) { setError('The channel URL must start with http:// or https://.'); return }
    const margin = form.safeZonePct / 100
    const template: BrandTemplate = {
      id: form.id ?? uniqueTemplateId(form.name, takenIds),
      name: form.name.trim(),
      captionPresetId: form.captionPresetId,
      formats: form.formats,
      includeTitle: form.includeTitle,
      ...(form.captionStyle ? { captionStyle: form.captionStyle } : {}),
      ...(form.logo ? { logo: form.logo } : {}),
      ...(form.intro ? { intro: form.intro } : {}),
      ...(form.outro ? { outro: form.outro } : {}),
      ...(form.badge !== 'none' ? { badge: { kind: form.badge, position: form.badgePosition } } : {}),
      ...(margin > 0 ? { safeZones: { 'top-left': margin, 'top-right': margin, 'bottom-left': margin, 'bottom-right': margin } } : {}),
      ...(form.bannerPlatform ? { banner: { platform: form.bannerPlatform, channelUrl: bannerUrl } } : {}),
      ...(form.pacing ? { pacing: form.pacing } : {}),
      ...(form.layoutStyle ? { layoutStyle: form.layoutStyle } : {})
    }
    setSaving(true)
    setError(null)
    try {
      await getApi().templates.save(template, form.logoPath, form.introPath, form.outroPath)
      onSaved()
    } catch (e) { setError(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <Panel className="space-y-5">
      <PanelHeader
        title={form.id ? `Edit “${form.name || 'template'}”` : 'New brand pack'}
        description="Picking this pack in Create applies the settings below; you can still change any field per job."
        action={<Button size="sm" variant="ghost" iconOnly icon={<X className="h-3.5 w-3.5" />} aria-label="Cancel" onClick={onCancel} />}
      />
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex flex-wrap items-start gap-5">
        <div className="min-w-[260px] flex-1 space-y-5">
          <div>
            <p className="eyebrow mb-1.5">Name</p>
            <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Studio brand" aria-label="Template name" maxLength={80} />
          </div>

          <Section title="Brand">
            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-muted">Logo</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" icon={<ImagePlus className="h-3.5 w-3.5" />} onClick={() => { void pickLogo() }}>{form.logo ? 'Replace logo' : 'Choose logo'}</Button>
                {form.logo && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => set({ logo: null, logoPath: null })}>Remove</Button>}
                {form.logoPath && <span className="max-w-40 truncate text-2xs text-ink-subtle" title={form.logoPath}>{form.logoPath.split(/[\\/]/).pop()}</span>}
              </div>
              {!form.logo && <p className="mt-1.5 text-2xs text-ink-subtle">PNG, JPG or WebP up to 5 MB. Without a file the pack keeps its position settings but draws nothing.</p>}
              {form.logo && (
                <div className="mt-2 space-y-2.5 rounded-xl border border-white/[0.07] p-3">
                  <PositionGrid label="Logo position" value={form.logo.position} onChange={(position) => set({ logo: { ...form.logo!, position } })} />
                  <label className="block text-xs text-ink-muted">Size <span className="float-right font-mono text-2xs">{Math.round(form.logo.scale * 100)}%</span>
                    <input type="range" aria-label="Logo size" min={5} max={50} value={Math.round(form.logo.scale * 100)} className="mt-1 w-full accent-accent"
                      onChange={(e) => set({ logo: { ...form.logo!, scale: Number(e.target.value) / 100 } })} /></label>
                  <label className="block text-xs text-ink-muted">Opacity <span className="float-right font-mono text-2xs">{Math.round(form.logo.opacity * 100)}%</span>
                    <input type="range" aria-label="Logo opacity" min={10} max={100} value={Math.round(form.logo.opacity * 100)} className="mt-1 w-full accent-accent"
                      onChange={(e) => set({ logo: { ...form.logo!, opacity: Number(e.target.value) / 100 } })} /></label>
                </div>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-muted">Intro & outro</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <VideoSlot slot="Intro" label="intro" name={form.intro} picked={form.introPath !== null} onPick={() => { void pickVideo('intro') }} onRemove={() => set({ intro: null, introPath: null })} />
                <VideoSlot slot="Outro" label="outro" name={form.outro} picked={form.outroPath !== null} onPick={() => { void pickVideo('outro') }} onRemove={() => set({ outro: null, outroPath: null })} />
              </div>
              <p className="mt-1.5 text-2xs text-ink-subtle">MP4, MOV or WebM up to 250 MB. Appended around every clip of jobs using this pack — new projects and single clips alike. Only one video per slot.</p>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-muted">CTA badge</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Badge kind">
                {([['none', 'No badge'], ['subscribe', 'SUBSCRIBE'], ['follow', 'FOLLOW']] as const).map(([kind, label]) => (
                  <button key={kind} type="button" role="radio" aria-checked={form.badge === kind} onClick={() => set({ badge: kind })}
                    className={cn('glass-tile glass-tile-hover rounded-full px-3 py-1 text-xs', form.badge === kind ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                    {label}
                  </button>
                ))}
              </div>
              {form.badge !== 'none' && <div className="mt-2"><PositionGrid label="Badge position" value={form.badgePosition} onChange={(badgePosition) => set({ badgePosition })} /></div>}
            </div>

            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-muted">Safe-zone margin <span className="float-right font-mono text-2xs text-ink-subtle">{form.safeZonePct}%</span></p>
              <input type="range" aria-label="Safe-zone margin" min={0} max={5} step={0.5} value={form.safeZonePct} className="w-full accent-accent"
                onChange={(e) => set({ safeZonePct: Number(e.target.value) })} />
              <p className="mt-1 text-2xs text-ink-subtle">Keeps the logo and badge this far from every edge, as a share of the output width.</p>
            </div>
          </Section>

          <Section title="Captions">
            <CaptionPresetPicker value={form.captionPresetId} onChange={(captionPresetId) => set({ captionPresetId, captionStyle: null })}
              customStyles={captionStyles} styleValue={form.captionStyle}
              onSelectCustom={(saved) => set({ captionPresetId: saved.preset, captionStyle: saved.style })}
              onDeleteCustom={onDeleteCaptionStyle} />
          </Section>

          <Section title="Format">
            <div>
              <p className="mb-1.5 text-xs font-medium text-ink-muted">Formats</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Formats">
                {templateFormats.map((id) => {
                  const selected = form.formats.includes(id)
                  return (
                    <button key={id} type="button" aria-pressed={selected} onClick={() => toggleFormat(id)}
                      className={cn('glass-tile glass-tile-hover rounded-full px-3 py-1 text-xs', selected ? 'glass-selected text-ink' : 'text-ink-muted hover:text-ink')}>
                      {FORMAT_INFO[id].label} <span className="font-mono text-2xs text-ink-subtle">{id}</span>
                    </button>
                  )
                })}
              </div>
              {form.formats.length > 1 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-ink-subtle">
                  <ArrowUpLeft className="h-3 w-3" /> Primary:
                  {form.formats.map((id) => (
                    <button key={id} type="button" aria-pressed={form.formats[0] === id} disabled={form.formats[0] === id}
                      onClick={() => makePrimary(id)}
                      className={cn('rounded-full px-2 py-0.5', form.formats[0] === id ? 'bg-accent text-accent-ink' : 'bg-white/[0.07] text-ink-muted hover:text-ink')}>
                      {FORMAT_INFO[id].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-ink-muted">Framing
                <FormSelect aria-label="Framing style" className="mt-1" value={form.layoutStyle} onChange={(layoutStyle) => set({ layoutStyle: layoutStyle as TemplateFormState['layoutStyle'] })}
                  options={[['', 'No preference'], ...templateFramingStyles.map((s) => [s, FRAMING_LABELS[s]] as [string, string])]} />
              </label>
              <label className="block text-xs text-ink-muted">Pacing
                <FormSelect aria-label="Pacing" className="mt-1" value={form.pacing} onChange={(pacing) => set({ pacing: pacing as TemplateFormState['pacing'] })}
                  options={[['', 'No preference'], ...templatePacingStyles.map((p) => [p, p === 'tight' ? 'Tight — cut dead air' : 'Natural — keep pauses'] as [string, string])]} />
              </label>
            </div>
          </Section>

          <Section title="Channel">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-ink-muted">Banner platform
                <FormSelect aria-label="Banner platform" className="mt-1" value={form.bannerPlatform} onChange={(bannerPlatform) => set({ bannerPlatform: bannerPlatform as TemplateFormState['bannerPlatform'] })}
                  options={[['', 'No banner'], ...templateBannerPlatforms.map((p) => [p, BANNER_PLATFORM_LABELS[p]] as [string, string])]} />
              </label>
              <label className="block text-xs text-ink-muted">Channel URL
                <TextInput className="mt-1" value={form.bannerUrl} onChange={(e) => set({ bannerUrl: e.target.value })} placeholder="https://youtube.com/@yours" aria-label="Channel URL" maxLength={200} disabled={!form.bannerPlatform} />
              </label>
            </div>
            <p className="mt-1 text-2xs text-ink-subtle">Burns your channel URL as a banner on every clip of jobs that use this pack.</p>
            <SettingRow
              title="Show title card"
              description="The clip title at the top of Automatic clips. Packs saved here always state this."
              control={<Switch label="Show title card" checked={form.includeTitle} onChange={(includeTitle) => set({ includeTitle })} />}
            />
          </Section>
        </div>

        <div className="space-y-2">
          <p className="eyebrow">Preview</p>
          <PreviewFrame preview={form} logoPath={form.logoPath} storedLogo={false} className="mx-auto" />
          <p className="max-w-[120px] text-center text-2xs text-ink-subtle">Approximate; the export is exact.</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] pt-4">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" onClick={() => { void save() }} loading={saving} disabled={saving || !form.name.trim()}>
          {form.id ? 'Save template' : 'Create template'}
        </Button>
      </div>
    </Panel>
  )
}

const FRAMING_LABELS: Record<TemplateFramingStyle, string> = { auto: 'Smart — per-shot framing', fill: 'Full frame — follows the speaker', fit: 'Classic — whole frame, blurred' }
const BANNER_PLATFORM_LABELS: Record<TemplateBannerPlatform, string> = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram', twitter: 'X', facebook: 'Facebook', linkedin: 'LinkedIn', threads: 'Threads' }

/** Labeled form block inside the template editor. */
function Section({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section aria-label={`${title} settings`} className="space-y-4 border-t border-white/[0.06] pt-4">
      <p className="eyebrow">{title}</p>
      {children}
    </section>
  )
}

/** One intro/outro upload slot: pick replaces the stored video, remove disables it. */
function VideoSlot({ slot, label, name, picked, onPick, onRemove }: {
  slot: string
  label: 'intro' | 'outro'
  name: string | null
  picked: boolean
  onPick: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-white/[0.07] p-3" aria-label={`${slot} video`}>
      <div className="flex items-center gap-2">
        <Film className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
        <p className="flex-1 truncate text-xs font-medium text-ink" title={picked ? undefined : name ?? undefined}>
          {picked ? name ?? '' : name ? `${slot}: ${name}` : `No ${label}`}
        </p>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ImagePlus className="h-3.5 w-3.5" />} aria-label={name ? `Replace ${label} video` : `Upload ${label} video`} onClick={onPick}>
          {name ? 'Replace' : 'Upload'}
        </Button>
        {name && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} aria-label={`Remove ${label} video`} onClick={onRemove}>Remove</Button>}
      </div>
    </div>
  )
}

/** Minimal native select in the page's glass styling. */
function FormSelect({ value, onChange, options, ...rest }: {
  value: string
  onChange: (value: string) => void
  options: readonly (readonly [string, string])[]
} & SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}
      className={cn('w-full rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-sm text-ink outline-none focus:border-accent/60', rest.className)}>
      {options.map(([id, label]) => <option key={id || '__unset'} value={id} className="bg-canvas">{label}</option>)}
    </select>
  )
}

const gridCells: (OverlayPosition | null)[] = ['top-left', null, 'top-right', null, 'center', null, 'bottom-left', null, 'bottom-right']

/** Same 5-cell picker as the editor's Brand tab, in page styling. */
function PositionGrid({ label, value, onChange }: { label: string; value: OverlayPosition; onChange: (position: OverlayPosition) => void }): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="grid w-28 grid-cols-3 gap-1.5">
      {gridCells.map((cell, i) => cell === null
        ? <span key={i} aria-hidden="true" className="h-6" />
        : <button key={i} type="button" role="radio" aria-checked={value === cell} aria-label={positionLabels[cell]} title={positionLabels[cell]}
            onClick={() => onChange(cell)}
            className={cn('h-6 rounded-md border border-white/10 bg-white/[0.04] transition-colors hover:border-white/25', value === cell && 'border-accent bg-accent/30')} />)}
    </div>
  )
}
