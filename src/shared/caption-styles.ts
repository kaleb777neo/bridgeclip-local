import { parseCaptionStyle, type CaptionStyleOverrides } from './clip-editor'
import { captionPresetIds } from './templates'

/**
 * A user-saved caption style: a name over a base preset plus the editor's
 * customisation. Picking it sets both the preset and the overrides, so the
 * tile previews, the editor panel and the engine all resolve the same look.
 */
export interface SavedCaptionStyle {
  version: 1
  /** Stable slug, unique in the store. */
  id: string
  name: string
  /** The engine preset the overrides layer on top of. */
  preset: string
  style: CaptionStyleOverrides
}

export function isCaptionStyleId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
}

const fail = (): never => { throw new Error('Invalid caption style') }
const record = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : fail()
const str = (x: unknown, max: number): string => typeof x === 'string' && x.length <= max ? x : fail()

/** Strict parse; unknown fields are dropped, malformed values throw. */
export function parseSavedCaptionStyle(value: unknown): SavedCaptionStyle {
  const v = record(value)
  if (v.version !== 1) fail()
  const id = str(v.id, 64); if (!isCaptionStyleId(id)) fail()
  const name = str(v.name, 40); if (!name.trim()) fail()
  const preset = str(v.preset, 64)
  if (!(captionPresetIds as readonly string[]).includes(preset)) fail()
  return { version: 1, id, name: name.trim(), preset, style: parseCaptionStyle(v.style) }
}

/** Slug plus random tail; the store guarantees uniqueness. */
export function captionStyleIdFromName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'style'
  return `${slug}-${Math.random().toString(16).slice(2, 6)}`
}
