import { isTemplateId, parseBrandTemplate, type BrandTemplate } from '../shared/templates'
import { builtinTemplates, isBuiltInTemplateId } from '../shared/templates-builtin'
import { app } from 'electron'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { isAbsolute, extname, join } from 'path'
import { randomUUID } from 'crypto'

/** Versioned JSON store for brand templates, next to settings.json. */
export const TEMPLATE_STORE_VERSION = 1

const LOGO_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']
const LOGO_FILE = /^logo\.(png|jpe?g|webp)$/
const MAX_LOGO_BYTES = 5 * 1024 * 1024
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm']
const PACK_VIDEO_FILES = { intro: /^intro\.(mp4|mov|webm)$/, outro: /^outro\.(mp4|mov|webm)$/ } as const
const MAX_VIDEO_BYTES = 250 * 1024 * 1024

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function userDataDir(): string {
  return ensureDir(app.getPath('userData'))
}

function getTemplatesPath(): string {
  return join(userDataDir(), 'templates.json')
}

/** One directory per pack, holding its logo asset; ids are slugs, so paths stay contained. */
export function templateAssetDir(id: string): string {
  if (!isTemplateId(id)) throw new Error('Invalid template id')
  return join(userDataDir(), 'templates', id)
}

/**
 * Parse the stored array, skipping bad entries and anything that could
 * shadow a built-in. Only known fields survive: parseBrandTemplate drops the
 * rest, so the renderer's shape never reaches the engine directly.
 */
export function normalizeTemplates(raw: unknown): BrandTemplate[] {
  if (!Array.isArray(raw)) return []
  const templates: BrandTemplate[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    try {
      const template = parseBrandTemplate(entry)
      if (template.builtIn !== undefined || isBuiltInTemplateId(template.id) || seen.has(template.id)) continue
      seen.add(template.id)
      templates.push(template)
    } catch { /* One bad entry must not hide the rest of the file. */ }
  }
  return templates
}

/** The user's saved packs (without the built-ins). */
export function loadTemplates(): BrandTemplate[] {
  const path = getTemplatesPath()
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return normalizeTemplates(Array.isArray(raw) ? raw : raw?.templates)
  } catch (error) {
    throw new Error('Could not read saved templates. The templates file was kept for recovery.', { cause: error })
  }
}

/** Built-in packs first, then the user's saved ones. */
export function listTemplates(): BrandTemplate[] {
  return [...builtinTemplates.map((template) => ({ ...template })), ...loadTemplates()]
}

export function getTemplate(id: unknown): BrandTemplate | null {
  if (typeof id !== 'string') return null
  return listTemplates().find((template) => template.id === id) ?? null
}

function writeTemplates(templates: BrandTemplate[]): void {
  const path = getTemplatesPath()
  const tempPath = `${path}.${randomUUID()}.tmp`
  const persisted = { version: TEMPLATE_STORE_VERSION, templates }
  try {
    writeFileSync(tempPath, JSON.stringify(persisted, null, 2), { encoding: 'utf-8', mode: 0o600 })
    renameSync(tempPath, path)
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

/** Copy a picked image into the pack's asset folder, replacing any previous logo. */
function importLogoAsset(id: string, source: unknown): void {
  if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0')) throw new Error('Choose the logo file with the file picker')
  let stat
  try { stat = lstatSync(source) } catch { throw new Error('The logo file could not be read') }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LOGO_BYTES) throw new Error('The logo must be an image file under 5 MB')
  const ext = extname(source).slice(1).toLowerCase()
  if (!LOGO_EXTENSIONS.includes(ext)) throw new Error('Choose a PNG, JPG or WebP logo')
  const dir = ensureDir(templateAssetDir(id))
  for (const entry of readdirSync(dir)) if (LOGO_FILE.test(entry)) unlinkSync(join(dir, entry))
  copyFileSync(source, join(dir, `logo.${ext}`))
}

/** The pack's stored logo file, or null when none was uploaded. */
export function logoAssetPath(id: string): string | null {
  if (!isTemplateId(id)) return null
  try {
    for (const entry of readdirSync(join(userDataDir(), 'templates', id)).sort()) {
      if (LOGO_FILE.test(entry)) return join(userDataDir(), 'templates', id, entry)
    }
  } catch { /* No asset folder means no logo. */ }
  return null
}

/** Copy a picked video into the pack's asset folder, replacing any previous one in the slot. */
function importVideoAsset(id: string, slot: 'intro' | 'outro', source: unknown): void {
  if (typeof source !== 'string' || !isAbsolute(source) || source.includes('\0')) throw new Error(`Choose the ${slot} file with the file picker`)
  let stat
  try { stat = lstatSync(source) } catch { throw new Error(`The ${slot} file could not be read`) }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VIDEO_BYTES) throw new Error(`The ${slot} must be a video file under 250 MB`)
  const ext = extname(source).slice(1).toLowerCase()
  if (!VIDEO_EXTENSIONS.includes(ext)) throw new Error('Choose an MP4, MOV or WebM video')
  const dir = ensureDir(templateAssetDir(id))
  for (const entry of readdirSync(dir)) if (PACK_VIDEO_FILES[slot].test(entry)) unlinkSync(join(dir, entry))
  copyFileSync(source, join(dir, `${slot}.${ext}`))
}

/** The pack's stored intro/outro file, or null when none was uploaded. */
export function packVideoPath(id: string, slot: 'intro' | 'outro'): string | null {
  if (!isTemplateId(id)) return null
  try {
    for (const entry of readdirSync(join(userDataDir(), 'templates', id)).sort()) {
      if (PACK_VIDEO_FILES[slot].test(entry)) return join(userDataDir(), 'templates', id, entry)
    }
  } catch { /* No asset folder means no video. */ }
  return null
}

/**
 * Insert or replace a pack; built-in ids are read-only, so edits save a copy.
 * `logoPath`/`introPath`/`outroPath` are the renderer's freshly picked files:
 * null keeps the stored asset, a path imports it. Removing the field from the
 * template config is enough to stop the asset materializing; the stale file in
 * the pack folder is unreachable, like a dropped logo.
 */
export function saveTemplate(input: unknown, logoPath: unknown = null, introPath: unknown = null, outroPath: unknown = null): BrandTemplate {
  const template = parseBrandTemplate(input)
  if (isBuiltInTemplateId(template.id)) throw new Error('Built-in templates cannot be edited. Save a copy instead.')
  const next: BrandTemplate = { ...template, version: 1 }
  const current = loadTemplates()
  const index = current.findIndex((saved) => saved.id === next.id)
  if (logoPath !== null) importLogoAsset(next.id, logoPath)
  if (introPath !== null) importVideoAsset(next.id, 'intro', introPath)
  if (outroPath !== null) importVideoAsset(next.id, 'outro', outroPath)
  if (index === -1) current.push(next)
  else current[index] = next
  writeTemplates(current)
  return next
}

export function deleteTemplate(id: unknown): boolean {
  if (!isTemplateId(id)) throw new Error('Invalid template id')
  if (isBuiltInTemplateId(id)) throw new Error('Built-in templates cannot be deleted. Save a copy instead.')
  const current = loadTemplates()
  const next = current.filter((template) => template.id !== id)
  if (next.length === current.length) return false
  writeTemplates(next)
  try { rmSync(templateAssetDir(id), { recursive: true, force: true }) } catch { /* An asset folder that survives is unreachable anyway. */ }
  return true
}
