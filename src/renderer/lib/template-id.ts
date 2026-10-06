import { isTemplateId } from '../../shared/templates'

/**
 * Brand pack ids are store slugs (see shared/templates isTemplateId). Names are
 * free text, so slugify and de-duplicate against ids already in the store —
 * built-in ids included, since main rejects a save that would shadow one.
 */
export function slugifyTemplateName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-]+/, '')
    .replace(/[-]+$/, '')
    .slice(0, 64)
  return isTemplateId(slug) ? slug : 'brand-pack'
}

/** A pack id for `name` that no existing template uses. */
export function uniqueTemplateId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugifyTemplateName(name)
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 58)}-${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base.slice(0, 48)}-${Date.now()}`
}
