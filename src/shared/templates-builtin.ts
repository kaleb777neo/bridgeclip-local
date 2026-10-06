import type { BrandTemplate } from './templates'

/**
 * Read-only packs shipped with the app; the store file can never reuse these
 * ids, and deleting or editing one means saving a copy (TemplatesPage).
 */
export const builtinTemplates: readonly BrandTemplate[] = [
  { version: 1, id: 'clean', name: 'Clean', builtIn: true, captionPresetId: 'pop', formats: ['9:16'], pacing: 'natural' },
  { version: 1, id: 'boxed-brand', name: 'Boxed brand', builtIn: true, captionPresetId: 'boxed', formats: ['9:16', '1:1'],
    logo: { position: 'bottom-right', scale: .15, opacity: .9 } },
  { version: 1, id: 'platform-cta', name: 'Platform CTA', builtIn: true, captionPresetId: 'pop', formats: ['9:16'],
    badge: { kind: 'subscribe', position: 'top-right' }, safeZones: { 'top-right': .12 }, pacing: 'tight' }
]

export function isBuiltInTemplateId(id: unknown): boolean {
  return typeof id === 'string' && builtinTemplates.some((template) => template.id === id)
}
