import { overlayPositions, parseCaptionStyle, type CaptionStyleOverrides, type OverlayPosition } from './clip-editor'

/** Output formats a brand pack can require; the same ids the job's aspect ratios use. */
export type TemplateFormat = '9:16' | '16:9' | '1:1'
export const templateFormats: readonly TemplateFormat[] = ['9:16', '16:9', '1:1']
/** Engine caption presets: mirrors get_available_presets in engine/clip_engine/config.py. */
export const captionPresetIds = ['pop', 'spotlight', 'impact', 'glow', 'boxed', 'sweep', 'editorial', 'hype', 'punch', 'neon', 'headline', 'paper', 'subtle', 'glitch', 'bounce', 'quake', 'blurswitch', 'highlighter', 'simple', 'ticker', 'retro', 'mono', 'duo', 'karaoke', 'beasty', 'deepdiver', 'popline', 'scale', 'slideleft', 'slideup'] as const
/** Framing styles a pack may allow; the same values as the job's layoutStyle. */
export const templateFramingStyles = ['auto', 'fill', 'fit'] as const
export type TemplateFramingStyle = (typeof templateFramingStyles)[number]
/** Dead-air cutting styles a pack can prefer; the same values as the job's pacing. */
export const templatePacingStyles = ['tight', 'natural'] as const
export type TemplatePacing = (typeof templatePacingStyles)[number]
/** Channel platforms a pack's banner may name; ids match the job's bannerPlatform. */
export const templateBannerPlatforms = ['youtube', 'tiktok', 'instagram', 'twitter', 'facebook', 'linkedin', 'threads'] as const
export type TemplateBannerPlatform = (typeof templateBannerPlatforms)[number]

export interface TemplateLogo { position: OverlayPosition; /** Fraction of output width, 0.05–0.5. */ scale: number; /** 0.1–1. */ opacity: number }
export interface TemplateBadge { kind: 'subscribe' | 'follow'; position: OverlayPosition }
/** Channel banner burned into every clip: the platform id plus the creator's channel URL. */
export interface TemplateBanner { platform: TemplateBannerPlatform; channelUrl: string }

/**
 * A brand pack: logo + CTA badge + caption preset + formats, applied to a job
 * at creation. Snapshot semantics with manual edits winning: the wizard applies
 * a pack's fields to the draft on select, materializeTemplate fills only the
 * fields the request leaves unset, and the resolved job is frozen — later
 * template edits never change a queued job. `templateId` is provenance only.
 * The logo asset is owned by main at userData/templates/<id>/logo.<ext>;
 * a logo config without a stored asset draws nothing. The same model covers
 * the pack's intro/outro videos: `intro`/`outro` hold the uploaded file's
 * display name (presence = enabled), the file lives at intro.<ext>/outro.<ext>
 * in the pack folder, and a name without a stored file materializes nothing.
 */
export interface BrandTemplate {
  version?: 1
  /** Stable slug; built-ins use their slug ids. */
  id: string
  name: string
  /** Shipped read-only; the store file never persists this. */
  builtIn?: boolean
  logo?: TemplateLogo
  badge?: TemplateBadge
  /** Uploaded intro video's display name; the file is main-owned in the pack folder. */
  intro?: string
  /** Uploaded outro video's display name; the file is main-owned in the pack folder. */
  outro?: string
  captionPresetId: string
  /** Caption customisation layered on the preset; absent = the plain preset. */
  captionStyle?: CaptionStyleOverrides
  /** Every clip renders these formats; the primary is [0]. */
  formats: TemplateFormat[]
  /** Per-corner insets as a fraction of output width; overlays place inside them. */
  safeZones?: Partial<Record<OverlayPosition, number>>
  /** Framing styles this pack allows; the first is its default. */
  allowedFraming?: string[]
  /** Channel banner (platform + channel URL) materialized onto every clip. */
  banner?: TemplateBanner
  /** Title card at the top of Automatic clips; absent keeps the app default (shown). */
  includeTitle?: boolean
  /** Dead-air cutting; absent keeps the wizard's current choice. */
  pacing?: TemplatePacing
  /** Preferred framing; absent falls back to allowedFraming's first entry, then the wizard's choice. */
  layoutStyle?: TemplateFramingStyle
}

export function isTemplateId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

const fail = (): never => { throw new Error('Invalid brand template') }
const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail()
const str = (x: unknown, max: number): string => typeof x === 'string' && x.length <= max ? x : fail()
const num = (x: unknown, lo: number, hi: number): number => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : fail()
const arr = (x: unknown, max: number): unknown[] => Array.isArray(x) && x.length <= max ? x : fail()
const bool = (x: unknown): boolean => typeof x === 'boolean' ? x : fail()
const position = (x: unknown): OverlayPosition => { if (!overlayPositions.includes(x as OverlayPosition)) fail(); return x as OverlayPosition }

/** Strict parse that keeps only known fields; unknown fields are dropped, malformed values throw. */
export function parseBrandTemplate(value: unknown): BrandTemplate {
  const v = record(value)
  const id = str(v.id, 64); if (!isTemplateId(id)) fail()
  const name = str(v.name, 80); if (!name.trim()) fail()
  if (v.version !== undefined && v.version !== 1) fail()
  let logo: TemplateLogo | undefined
  if (v.logo !== undefined) {
    const o = record(v.logo)
    logo = { position: position(o.position), scale: num(o.scale, .05, .5), opacity: num(o.opacity, .1, 1) }
  }
  let badge: TemplateBadge | undefined
  if (v.badge !== undefined) {
    const o = record(v.badge)
    const kind = o.kind === 'subscribe' || o.kind === 'follow' ? o.kind : fail()
    badge = { kind, position: position(o.position) }
  }
  const captionPresetId = str(v.captionPresetId, 64)
  if (!(captionPresetIds as readonly string[]).includes(captionPresetId)) fail()
  const formats = arr(v.formats, 3).map((f) => { if (!templateFormats.includes(f as TemplateFormat)) fail(); return f as TemplateFormat })
  if (!formats.length || new Set(formats).size !== formats.length) fail()
  const next: BrandTemplate = { id, name: name.trim(), captionPresetId, formats, ...(v.version === 1 ? { version: 1 } : {}) }
  if (v.captionStyle !== undefined) {
    try { next.captionStyle = parseCaptionStyle(v.captionStyle) } catch { fail() }
  }
  if (v.builtIn !== undefined) { if (v.builtIn !== true) fail(); next.builtIn = true }
  if (logo) next.logo = logo
  if (badge) next.badge = badge
  if (v.intro !== undefined) next.intro = str(v.intro, 200)
  if (v.outro !== undefined) next.outro = str(v.outro, 200)
  if (v.safeZones !== undefined) {
    const zones: Partial<Record<OverlayPosition, number>> = {}
    for (const [key, inset] of Object.entries(record(v.safeZones))) zones[position(key)] = num(inset, 0, .5)
    next.safeZones = zones
  }
  if (v.allowedFraming !== undefined) {
    const framing = arr(v.allowedFraming, 3).map((f) => { if (!(templateFramingStyles as readonly string[]).includes(f as string)) fail(); return f as string })
    if (!framing.length || new Set(framing).size !== framing.length) fail()
    next.allowedFraming = framing
  }
  if (v.banner !== undefined) {
    const o = record(v.banner)
    const platform = str(o.platform, 64)
    if (!(templateBannerPlatforms as readonly string[]).includes(platform)) fail()
    // Non-empty, ≤200 chars, and shaped like an http(s) URL so the materialized job passes validation.
    const channelUrl = str(o.channelUrl, 200)
    if (!/^https?:\/\/\S{2,}$/i.test(channelUrl)) fail()
    next.banner = { platform: platform as TemplateBannerPlatform, channelUrl }
  }
  if (v.includeTitle !== undefined) next.includeTitle = bool(v.includeTitle)
  if (v.pacing !== undefined) { if (!(templatePacingStyles as readonly string[]).includes(v.pacing as string)) fail(); next.pacing = v.pacing as TemplatePacing }
  if (v.layoutStyle !== undefined) { if (!(templateFramingStyles as readonly string[]).includes(v.layoutStyle as string)) fail(); next.layoutStyle = v.layoutStyle as TemplateFramingStyle }
  return next
}

/** The pack's corner inset for an overlay position; undefined keeps the engine's fixed margin. */
export function safeZoneMargin(template: BrandTemplate, position: OverlayPosition): number | undefined {
  return position === 'center' ? undefined : template.safeZones?.[position]
}
