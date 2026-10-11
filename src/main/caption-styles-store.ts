import { isCaptionStyleId, parseSavedCaptionStyle, type SavedCaptionStyle } from '../shared/caption-styles'
import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

/** Versioned JSON store for the user's saved caption styles, next to settings.json. */
export const CAPTION_STYLE_STORE_VERSION = 1

function storePath(): string {
  return join(app.getPath('userData'), 'caption-styles.json')
}

function parseStore(raw: unknown): SavedCaptionStyle[] {
  if (!Array.isArray(raw)) return []
  const styles: SavedCaptionStyle[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    try {
      const style = parseSavedCaptionStyle(entry)
      if (seen.has(style.id)) continue
      seen.add(style.id)
      styles.push(style)
    } catch { /* One bad entry must not hide the rest. */ }
  }
  return styles
}

/** The user's saved styles; a missing or unreadable file reads as empty. */
export function listCaptionStyles(): SavedCaptionStyle[] {
  const path = storePath()
  if (!existsSync(path)) return []
  try {
    return parseStore(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return []
  }
}

function persist(styles: SavedCaptionStyle[]): void {
  const path = storePath()
  const staging = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(staging, JSON.stringify(styles, null, 2), { mode: 0o600 })
  renameSync(staging, path)
}

/** Insert or replace by id; returns the updated list. */
export function saveCaptionStyle(style: unknown): SavedCaptionStyle[] {
  const next = parseSavedCaptionStyle(style)
  if (!isCaptionStyleId(next.id)) throw new Error('Invalid caption style id')
  const styles = listCaptionStyles().filter((existing) => existing.id !== next.id)
  styles.push(next)
  persist(styles)
  return styles
}

export function deleteCaptionStyle(id: unknown): SavedCaptionStyle[] {
  if (!isCaptionStyleId(id)) throw new Error('Invalid caption style id')
  const styles = listCaptionStyles().filter((existing) => existing.id !== id)
  persist(styles)
  return styles
}
