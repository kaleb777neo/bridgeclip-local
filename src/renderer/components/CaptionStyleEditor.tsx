import { useState } from 'react'
import { Save } from 'lucide-react'
import { Button } from './ui/Button'
import { Switch } from './ui/Switch'
import { CAPTION_FONTS, accentOf, captionPreviewPreset, engineFontOf } from './CaptionPresetPicker'
import { captionStyleIdFromName, type SavedCaptionStyle } from '../../shared/caption-styles'
import type { CaptionStyleOverrides } from '../../shared/clip-editor'

/**
 * The caption style panel: standard customisation (text and accent colours,
 * font, size, case, position) layered on the picked preset. First touch
 * materialises the full override set from what is on screen, so every well
 * opens on the viewer's current look; Reset drops back to the plain preset.
 */
export function CaptionStyleEditor({ presetId, style, onChange, onReset, captionY, captionX, onMovePosition, onSaveStyle, disabled }: {
  presetId: string
  style: CaptionStyleOverrides | undefined
  onChange: (style: CaptionStyleOverrides) => void
  onReset: () => void
  /** Null keeps the preset's own placement. */
  captionY: number | null
  captionX: number | null
  onMovePosition: (x: number, y: number) => void
  onSaveStyle: (style: SavedCaptionStyle) => Promise<void> | void
  disabled?: boolean
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const preset = captionPreviewPreset(presetId)
  const base: CaptionStyleOverrides = style ?? {
    primaryColor: preset.primary,
    highlightColor: accentOf(preset),
    font: engineFontOf(preset),
    sizeScale: 1,
    uppercase: preset.uppercase
  }
  const edit = (patch: Partial<CaptionStyleOverrides>): void => onChange({ ...base, ...patch })
  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    void Promise.resolve(onSaveStyle({ version: 1, id: captionStyleIdFromName(trimmed), name: trimmed, preset: presetId, style: base }))
      .catch(() => {})
      .finally(() => { setSaving(false); setName('') })
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink">Customize style{style ? <span className="text-accent"> · edited</span> : null}</span>
        {style && <Button size="sm" variant="ghost" disabled={disabled} onClick={onReset}>Reset</Button>}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="editor-label">Text color
          <input type="color" aria-label="Caption text color" disabled={disabled} value={base.primaryColor} onChange={(e) => edit({ primaryColor: e.target.value })} className="caption-color-input" />
        </label>
        <label className="editor-label">Accent color
          <input type="color" aria-label="Caption accent color" disabled={disabled} value={base.highlightColor} onChange={(e) => edit({ highlightColor: e.target.value })} className="caption-color-input" />
        </label>
      </div>
      <label className="editor-label">Font
        <select aria-label="Caption font" disabled={disabled} value={base.font} onChange={(e) => edit({ font: e.target.value })}>
          {CAPTION_FONTS.map((font) => <option key={font.face} value={font.face}>{font.label}</option>)}
        </select>
      </label>
      <label className="editor-label">Size <span className="float-right">{Math.round(base.sizeScale * 100)}%</span>
        <input type="range" aria-label="Caption size" min={0.5} max={2} step={0.05} disabled={disabled} value={base.sizeScale} onChange={(e) => edit({ sizeScale: Number(e.target.value) })} />
      </label>
      <div className="flex items-center justify-between text-xs">
        <span>UPPERCASE</span>
        <Switch label="Uppercase captions" checked={base.uppercase ?? preset.uppercase} disabled={disabled} onChange={(uppercase) => edit({ uppercase })} />
      </div>
      <div className="space-y-2 border-t border-white/10 pt-2">
        <label className="editor-label">Vertical position <span className="float-right">{captionY == null ? 'Automatic' : `${Math.round(captionY * 100)}%`}</span>
          <input type="range" aria-label="Caption vertical position" min={0.1} max={0.9} step={0.01} disabled={disabled} value={captionY ?? 0.8} onChange={(e) => onMovePosition(captionX ?? 0.5, Number(e.target.value))} />
        </label>
        <label className="editor-label">Horizontal position <span className="float-right">{captionX == null ? 'Centered' : `${Math.round(captionX * 100)}%`}</span>
          <input type="range" aria-label="Caption horizontal position" min={0.1} max={0.9} step={0.01} disabled={disabled} value={captionX ?? 0.5} onChange={(e) => onMovePosition(Number(e.target.value), captionY ?? 0.8)} />
        </label>
      </div>
      <div className="flex gap-2 border-t border-white/10 pt-2">
        <input className="caption-style-name" aria-label="Style name" placeholder="Name this style" maxLength={40} value={name} disabled={disabled || saving} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save() }} />
        <Button size="sm" icon={<Save size={13} />} disabled={disabled || !name.trim() || saving} onClick={save}>Save style</Button>
      </div>
    </div>
  )
}
