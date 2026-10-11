import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Ban, Check, Pause, Play, RotateCcw, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/Button'
import type { CaptionStyleOverrides } from '../../shared/clip-editor'
import type { SavedCaptionStyle } from '../../shared/caption-styles'

/**
 * Mirrors the caption presets in engine/clip_engine/config.py closely
 * enough to preview them: typeface, colours, stroke, shadow, glow, pill,
 * plate and karaoke sweep. BridgeClip engine renders with its bundled fonts; the preview
 * uses the same bundled faces, with a system fallback while they load.
 */
interface CaptionPreset {
  id: string
  name: string
  description: string
  font: string
  weight: number
  italic?: boolean
  size: number
  primary: string
  highlight: string
  stroke: number
  shadow: 'soft' | 'hard' | 'halo' | 'none'
  uppercase: boolean
  /** Rounded pill behind the active word. */
  pill?: string
  /** Blurred bloom around the active word. */
  glow?: string
  /** Translucent plate behind the whole line. */
  plate?: string
  karaoke?: boolean
  /** Fly the line in from a side. */
  slide?: 'left' | 'up'
  /** How unspoken words look. */
  future?: 'show' | 'dim' | 'hide'
  maxWords?: number
  entrancePop?: boolean
  colorTransition?: boolean
  dimOpacity?: number
  words: [string, string, string]
}

const PRESETS: CaptionPreset[] = [
  {
    id: 'pop',
    name: 'Pop',
    description: 'The all-rounder',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#FFE234',
    stroke: 6,
    shadow: 'soft',
    uppercase: true,
    words: ['this', 'changed', 'everything']
  },
  {
    id: 'spotlight',
    name: 'Spotlight',
    description: 'Word on a pill',
    font: '"Poppins", "Poppins Black", system-ui, sans-serif',
    weight: 900,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    pill: '#7C5CFF',
    words: ['the', 'real', 'secret']
  },
  {
    id: 'impact',
    name: 'Impact',
    description: 'Tall, two words at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 21,
    primary: '#FFFFFF',
    highlight: '#FFD60A',
    stroke: 7,
    shadow: 'hard',
    uppercase: true,
    future: 'hide',
    maxWords: 2,
    words: ['ten', 'million', 'views']
  },
  {
    id: 'glow',
    name: 'Glow',
    description: 'Cyan bloom, tech & gaming',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 15,
    primary: '#FFFFFF',
    highlight: '#7DF9FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#00C8FF',
    words: ['level', 'up', 'now']
  },
  {
    id: 'boxed',
    name: 'Boxed',
    description: 'Readable on any footage',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFD23F',
    stroke: 0,
    shadow: 'none',
    uppercase: true,
    plate: 'rgb(0 0 0 / 0.62)',
    words: ['ship it', 'faster', 'today']
  },
  {
    id: 'sweep',
    name: 'Sweep',
    description: 'Colour follows the voice',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF5FA2',
    stroke: 5,
    shadow: 'soft',
    uppercase: true,
    karaoke: true,
    maxWords: 4,
    entrancePop: false,
    words: ['sing', 'along', 'now']
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Serif for podcasts & stories',
    font: '"Instrument Serif", "Georgia", serif',
    weight: 400,
    italic: true,
    size: 20,
    primary: '#FFFFFF',
    highlight: '#FFE6B8',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    maxWords: 4,
    entrancePop: false,
    dimOpacity: 0.6,
    words: ['and that is', 'why', 'it works']
  },
  {
    id: 'hype',
    colorTransition: true,
    name: 'Hype',
    description: 'Heavy stroke, high energy',
    font: '"Montserrat", "Montserrat Black", system-ui, sans-serif',
    weight: 900,
    size: 16,
    primary: '#FFFFFF',
    highlight: '#39FF6A',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['let’s', 'go', 'now']
  },
  {
    id: 'punch',
    maxWords: 1,
    name: 'Punch',
    description: 'One huge word at a time',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif',
    weight: 400,
    size: 28,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 8,
    shadow: 'hard',
    uppercase: true,
    words: ['', 'boom', '']
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Magenta bloom, music & lifestyle',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 14,
    primary: '#FFFFFF',
    highlight: '#FF9CEB',
    stroke: 0,
    shadow: 'halo',
    uppercase: true,
    glow: '#FF2EC4',
    words: ['feel', 'the', 'beat']
  },
  {
    id: 'headline',
    name: 'Headline',
    description: 'Word on a red news tag',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif',
    weight: 400,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#FFFFFF',
    stroke: 4,
    shadow: 'soft',
    uppercase: true,
    pill: '#E5202E',
    words: ['this', 'just', 'in']
  },
  {
    id: 'paper',
    maxWords: 4,
    entrancePop: false,
    name: 'Paper',
    description: 'Dark type on a white card',
    font: '"Poppins", "Poppins ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#111111',
    highlight: '#6D28D9',
    stroke: 0,
    shadow: 'none',
    uppercase: false,
    plate: 'rgb(255 255 255 / 0.94)',
    words: ['here is', 'how', 'it works']
  },
  {
    id: 'glitch', name: 'Glitch', description: 'Dense cyan pops, tight tracking',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif', weight: 400, size: 19,
    primary: '#FFFFFF', highlight: '#00E5FF', stroke: 7, shadow: 'hard', uppercase: true,
    maxWords: 2, words: ['system', 'overload', 'now']
  },
  {
    id: 'bounce', name: 'Bounce', description: 'Sunny pill under dark type',
    font: '"Poppins", "Poppins Black", system-ui, sans-serif', weight: 900, size: 14,
    primary: '#111111', highlight: '#111111', stroke: 4, shadow: 'soft', uppercase: true,
    pill: '#FFD60A', words: ['ready', 'to', 'move']
  },
  {
    id: 'quake', name: 'Quake', description: 'One huge red-hot word',
    font: '"Anton", "Impact", "Arial Narrow", sans-serif', weight: 400, size: 26,
    primary: '#FFFFFF', highlight: '#FF4D4D', stroke: 8, shadow: 'hard', uppercase: true,
    maxWords: 1, words: ['', 'impact', '']
  },
  {
    id: 'blurswitch', name: 'Blur Switch', description: 'Airy cyan highlights',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif', weight: 800, size: 14,
    primary: '#FFFFFF', highlight: '#9BE7FF', stroke: 0, shadow: 'soft', uppercase: true,
    maxWords: 4, words: ['focus', 'switches', 'fast']
  },
  {
    id: 'highlighter', name: 'Highlighter', description: 'Dark type on marker yellow',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif', weight: 400, size: 13,
    primary: '#111111', highlight: '#111111', stroke: 0, shadow: 'none', uppercase: false,
    plate: '#FFE011', maxWords: 4, words: ['mark', 'this', 'down']
  },
  {
    id: 'simple', name: 'Simple', description: 'Clean lowercase, whisper shadow',
    font: '"Plus Jakarta Sans", system-ui, sans-serif', weight: 700, size: 14,
    primary: '#FFFFFF', highlight: '#C4F1FF', stroke: 0, shadow: 'soft', uppercase: false,
    maxWords: 4, words: ['keep', 'it', 'simple']
  },
  {
    id: 'ticker', name: 'Ticker', description: 'White on a dark news band',
    font: '"Archivo Black", "Arial Black", system-ui, sans-serif', weight: 400, size: 12,
    primary: '#FFFFFF', highlight: '#FFFFFF', stroke: 0, shadow: 'none', uppercase: true,
    plate: '#0F172A', maxWords: 5, words: ['this', 'just', 'happened']
  },
  {
    id: 'retro', name: 'Retro', description: 'Italic serif, warm glow',
    font: '"Instrument Serif", "Georgia", serif', weight: 400, italic: true, size: 20,
    primary: '#FFFFFF', highlight: '#FFB347', stroke: 0, shadow: 'halo', uppercase: false,
    maxWords: 4, words: ['back', 'in', 'style']
  },
  {
    id: 'mono', name: 'Mono', description: 'Spaced capitals, no outline',
    font: '"Plus Jakarta Sans", system-ui, sans-serif', weight: 700, size: 13,
    primary: '#FFFFFF', highlight: '#C4F1FF', stroke: 0, shadow: 'none', uppercase: true,
    maxWords: 4, words: ['clean', 'and', 'modern']
  },
  {
    id: 'duo', name: 'Duo', description: 'Active word flips to green',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif', weight: 800, size: 15,
    primary: '#FFFFFF', highlight: '#39FF6A', stroke: 6, shadow: 'soft', uppercase: true,
    words: ['double', 'the', 'energy']
  },
  {
    id: 'karaoke', name: 'Karaoke', description: 'Sweep colors each word as spoken',
    font: '"Poppins ExtraBold", "Poppins", system-ui, sans-serif', weight: 800, size: 16,
    primary: '#FFFFFF', highlight: '#FF3D6E', stroke: 5, shadow: 'soft', uppercase: true,
    karaoke: true, maxWords: 3, words: ['sing', 'every', 'word']
  },
  {
    id: 'beasty', name: 'Beasty', description: 'Beast-mode type on a black slab',
    font: '"Anton", "Arial Black", system-ui, sans-serif', weight: 400, size: 22,
    primary: '#FFFFFF', highlight: '#FFE01B', stroke: 0, shadow: 'hard', uppercase: true,
    pill: '#0B0B0D', maxWords: 2, words: ['total', 'beast', 'mode']
  },
  {
    id: 'deepdiver', name: 'Deep Diver', description: 'Clean minimal, whisper outline',
    font: '"Montserrat", system-ui, sans-serif', weight: 500, size: 13,
    primary: '#FFFFFF', highlight: '#9AE6FF', stroke: 2, shadow: 'soft', uppercase: false,
    maxWords: 5, words: ['calm', 'and', 'clear']
  },
  {
    id: 'popline', name: 'Pop Line', description: 'The whole line pops in',
    font: '"Poppins ExtraBold", "Poppins", system-ui, sans-serif', weight: 800, size: 16,
    primary: '#FFFFFF', highlight: '#FF8A3D', stroke: 5, shadow: 'soft', uppercase: true,
    maxWords: 4, words: ['whole', 'line', 'pops']
  },
  {
    id: 'scale', name: 'Scale', description: 'Active words scale up',
    font: '"Montserrat Black", "Montserrat", system-ui, sans-serif', weight: 900, size: 16,
    primary: '#FFFFFF', highlight: '#7C5CFF', stroke: 5, shadow: 'soft', uppercase: true,
    maxWords: 3, words: ['grows', 'on', 'beat']
  },
  {
    id: 'slideleft', name: 'Slide Left', description: 'Flies in from the right',
    font: '"Poppins ExtraBold", "Poppins", system-ui, sans-serif', weight: 800, size: 15,
    primary: '#FFFFFF', highlight: '#3DFF8B', stroke: 5, shadow: 'soft', uppercase: true,
    slide: 'left', maxWords: 4, words: ['slides', 'in', 'clean']
  },
  {
    id: 'slideup', name: 'Slide Up', description: 'Rises into place',
    font: '"Poppins ExtraBold", "Poppins", system-ui, sans-serif', weight: 800, size: 15,
    primary: '#FFFFFF', highlight: '#4AC7FF', stroke: 5, shadow: 'soft', uppercase: true,
    slide: 'up', maxWords: 4, words: ['rises', 'into', 'place']
  },
  {
    id: 'subtle',
    maxWords: 4,
    entrancePop: false,
    colorTransition: true,
    dimOpacity: 0.55,
    name: 'Subtle',
    description: 'Light touch for interviews & vlogs',
    font: '"Montserrat", "Montserrat ExtraBold", system-ui, sans-serif',
    weight: 800,
    size: 13,
    primary: '#FFFFFF',
    highlight: '#C4F1FF',
    stroke: 0,
    shadow: 'halo',
    uppercase: false,
    future: 'dim',
    words: ['I think', 'that’s', 'fair']
  }
]

/** Display names by preset id, for summaries outside the picker. */
export const CAPTION_PRESET_NAMES: Record<string, string> = Object.fromEntries(PRESETS.map((preset) => [preset.id, preset.name]))

/** The editor's font choices: engine face names mapped to their preview CSS. */
export interface CaptionFontOption { face: string; label: string; css: string; weight: number; italic?: boolean }
export const CAPTION_FONTS: CaptionFontOption[] = [
  { face: 'Montserrat Black', label: 'Montserrat Black', css: '"Montserrat", system-ui, sans-serif', weight: 900 },
  { face: 'Montserrat ExtraBold', label: 'Montserrat ExtraBold', css: '"Montserrat", system-ui, sans-serif', weight: 800 },
  { face: 'Poppins Black', label: 'Poppins Black', css: '"Poppins", system-ui, sans-serif', weight: 900 },
  { face: 'Poppins ExtraBold', label: 'Poppins ExtraBold', css: '"Poppins", system-ui, sans-serif', weight: 800 },
  { face: 'Anton', label: 'Anton', css: '"Anton", "Impact", "Arial Narrow", sans-serif', weight: 400 },
  { face: 'Archivo Black', label: 'Archivo Black', css: '"Archivo Black", "Arial Black", system-ui, sans-serif', weight: 400 },
  { face: 'Instrument Serif Italic', label: 'Instrument Serif', css: '"Instrument Serif", Georgia, serif', weight: 400, italic: true },
  { face: 'Plus Jakarta Sans', label: 'Plus Jakarta Sans', css: '"Plus Jakarta Sans", system-ui, sans-serif', weight: 700 }
]
export const captionFontByFace = (face: string): CaptionFontOption => CAPTION_FONTS.find((font) => font.face === face) ?? CAPTION_FONTS[0]

/** The engine face behind a preview preset, so "Customize" starts from what's on screen. */
export function engineFontOf(preset: CaptionPreset): string {
  if (preset.font.includes('Anton')) return 'Anton'
  if (preset.font.includes('Archivo')) return 'Archivo Black'
  if (preset.font.includes('Instrument')) return 'Instrument Serif Italic'
  if (preset.font.includes('Jakarta')) return 'Plus Jakarta Sans'
  if (preset.font.includes('Poppins')) return preset.weight >= 900 ? 'Poppins Black' : 'Poppins ExtraBold'
  if (preset.font.includes('Montserrat')) return preset.weight >= 900 ? 'Montserrat Black' : preset.weight >= 800 ? 'Montserrat ExtraBold' : 'Montserrat Black'
  return 'Montserrat Black'
}

/** The accent a style panel should open with: the pill, the glow, or the active word. */
export function accentOf(preset: CaptionPreset): string {
  return preset.pill ?? preset.glow ?? preset.highlight
}

/**
 * Layer editor customisation onto a preview preset, mirroring the engine's
 * apply_caption_style_overrides: the accent lands on the active word and its
 * pill/glow carrier (a pill keeps the text colour so the word stays readable).
 */
export function applyCaptionStyleOverrides(preset: CaptionPreset, ov: CaptionStyleOverrides): CaptionPreset {
  const font = captionFontByFace(ov.font)
  const pill = preset.pill ? ov.highlightColor : preset.pill
  return {
    ...preset,
    primary: ov.primaryColor,
    highlight: preset.pill ? ov.primaryColor : ov.highlightColor,
    pill,
    glow: preset.glow ? ov.highlightColor : preset.glow,
    font: font.css,
    weight: font.weight,
    italic: font.italic,
    uppercase: ov.uppercase ?? preset.uppercase,
    size: preset.size * ov.sizeScale
  }
}

/** Field-by-field equality for primitive override objects. */
export function sameCaptionStyle(a: CaptionStyleOverrides | null | undefined, b: CaptionStyleOverrides | null | undefined): boolean {
  if (!a || !b) return false
  return a.primaryColor === b.primaryColor && a.highlightColor === b.highlightColor && a.font === b.font && a.sizeScale === b.sizeScale && (a.uppercase ?? null) === (b.uppercase ?? null)
}

/**
 * Preset `size` and `stroke` are tuned for an 84px-tall preview. The compact
 * tile is 60px tall, so samples render at this fraction to keep the same fit.
 */
export const captionPreviewPreset = (id: string): CaptionPreset => PRESETS.find(p => p.id === id) ?? PRESETS[0]
const SAMPLE_SCALE = 60 / 84

/** Stroke + shadow as stacked text-shadows, scaled to the tile. */
export function textShadow(p: CaptionPreset, scale = SAMPLE_SCALE): string {
  const layers: string[] = []
  const w = p.stroke * 0.28 * scale
  if (w > 0) {
    for (let a = 0; a < 16; a++) {
      const r = (a / 16) * Math.PI * 2
      layers.push(`${(Math.cos(r) * w).toFixed(2)}px ${(Math.sin(r) * w).toFixed(2)}px 0 #000`)
    }
  }
  if (p.shadow === 'soft') layers.push(`0 ${(w + 1.5).toFixed(2)}px 4px rgb(0 0 0 / 0.6)`)
  if (p.shadow === 'hard') layers.push(`0 ${(w + 2.5).toFixed(2)}px 0 rgb(0 0 0 / 0.9)`)
  if (p.shadow === 'halo') layers.push('0 1px 6px rgb(0 0 0 / 0.85)', '0 0 3px rgb(0 0 0 / 0.6)')
  return layers.join(', ') || 'none'
}

function CaptionSample({ preset }: { preset: CaptionPreset }): React.JSX.Element {
  const [before, active, after] = preset.words
  const base: CSSProperties = {
    color: preset.primary,
    fontFamily: preset.font,
    fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal',
    fontSize: preset.size * SAMPLE_SCALE,
    textShadow: textShadow(preset),
    textTransform: preset.uppercase ? 'uppercase' : 'none'
  }

  let activeWord: React.JSX.Element
  if (preset.karaoke) {
    // Show the sweep mid-word; two spans rather than background-clip:text,
    // which the stroke shadow would paint over.
    const at = Math.ceil(active.length * 0.6)
    activeWord = (
      <span>
        <span style={{ color: preset.highlight }}>{active.slice(0, at)}</span>
        {active.slice(at)}
      </span>
    )
  } else if (preset.pill) {
    activeWord = (
      <span
        style={{ background: preset.pill, color: preset.highlight, textShadow: 'none', borderRadius: 4, padding: '1px 3px' }}
      >
        {active}
      </span>
    )
  } else {
    const bloom = preset.glow ? `, 0 0 4px ${preset.glow}, 0 0 10px ${preset.glow}` : ''
    activeWord = <span style={{ color: preset.highlight, textShadow: `${textShadow(preset)}${bloom}` }}>{active}</span>
  }

  const afterStyle: CSSProperties | undefined =
    preset.future === 'dim' ? { opacity: 0.6 } : preset.future === 'hide' ? { visibility: 'hidden' } : undefined
  // Karaoke: words already swept keep the highlight colour.
  const beforeStyle: CSSProperties | undefined = preset.karaoke ? { color: preset.highlight } : undefined

  const line = (
    <>
      {before && <span style={beforeStyle}>{before} </span>}
      {activeWord}
      {after && <span style={afterStyle}> {after}</span>}
    </>
  )

  return (
    <span className="relative block text-center leading-[1.1]" style={base}>
      {preset.plate ? (
        <span className="inline-block rounded px-1 py-px" style={{ background: preset.plate }}>
          {line}
        </span>
      ) : (
        line
      )}
    </span>
  )
}

/** A stand-in "frame" behind each sample: a flat, dim video-like tone. */
const SCENE = '#14161d'

// One shared sentence makes timing and word grouping easy to compare across styles.
const PREVIEW_WORDS = ['This', 'is', 'how', 'your', 'captions', 'come', 'to', 'life.']
const WORD_MS = 600
const SPEECH_MS = PREVIEW_WORDS.length * WORD_MS
const PREVIEW_MS = SPEECH_MS + 700 + 350 // Match the engine's linger, then clear before looping.

function CaptionMotionPreview({ preset, disabled }: { preset: CaptionPreset; disabled?: boolean }): React.JSX.Element {
  const [reducedMotion, setReducedMotion] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [playing, setPlaying] = useState(!reducedMotion)
  const [time, setTime] = useState(0)
  const elapsed = useRef(0)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = (): void => {
      setReducedMotion(media.matches)
      if (media.matches) setPlaying(false)
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!playing || disabled) return
    let frame = 0
    let previous = performance.now()
    const tick = (now: number): void => {
      if (!document.hidden) {
        elapsed.current = (elapsed.current + Math.min(now - previous, 100)) % PREVIEW_MS
        setTime(elapsed.current)
      }
      previous = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, disabled])

  const seek = (ms: number): void => { elapsed.current = ms; setTime(ms) }
  const active = Math.min(Math.floor(time / WORD_MS), PREVIEW_WORDS.length - 1)
  const groupSize = preset.maxWords ?? 3
  const groupStart = Math.floor(active / groupSize) * groupSize
  const groupTime = time - groupStart * WORD_MS
  const wordProgress = Math.min(1, (time - active * WORD_MS) / WORD_MS)
  const scale = !reducedMotion && preset.entrancePop !== false && groupTime < 170
    ? groupTime < 90 ? 0.82 + 0.24 * groupTime / 90 : 1.06 - 0.06 * (groupTime - 90) / 80
    : 1
  const shadow = textShadow(preset, 1.2)
  const base: CSSProperties = {
    color: preset.primary, fontFamily: preset.font, fontWeight: preset.weight,
    fontStyle: preset.italic ? 'italic' : 'normal', fontSize: preset.size * 1.65,
    textShadow: shadow, textTransform: preset.uppercase ? 'uppercase' : 'none',
    transform: `scale(${scale})`, visibility: time >= SPEECH_MS + 700 ? 'hidden' : undefined
  }

  return (
    <section aria-label="Caption preview" className="mb-3 overflow-hidden rounded-xl border border-white/[0.08]" style={{ background: SCENE }}>
      <div className="flex items-center justify-between gap-2 px-3 pt-3 text-xs">
        <span className="font-semibold text-ink">{preset.name} preview</span>
        <span className="text-2xs text-ink-subtle">Sample timing · No audio</span>
      </div>
      <div aria-hidden="true" className="flex h-32 items-center justify-center overflow-hidden px-4">
        <div className="text-center leading-snug" style={base}>
          <span className="inline-flex flex-wrap justify-center gap-x-[0.3em] rounded-md px-2 py-1" style={{ background: preset.plate }}>
            {PREVIEW_WORDS.slice(groupStart, groupStart + groupSize).map((word, offset) => {
              const index = groupStart + offset
              const state = index === active ? 'active' : index < active ? 'past' : 'future'
              const style: CSSProperties = {
                visibility: state === 'future' && preset.future === 'hide' ? 'hidden' : undefined,
                opacity: state === 'future' && preset.future === 'dim' ? preset.dimOpacity ?? 0.6 : 1,
                // Reserve pill padding on every word so the line stays put as it advances.
                padding: preset.pill ? '1px 5px' : undefined,
                borderRadius: 5
              }
              if (preset.karaoke) {
                if (state === 'past') style.color = preset.highlight
              } else if (state === 'active') {
                style.color = preset.colorTransition
                  ? `color-mix(in srgb, ${preset.highlight} ${Math.min(1, wordProgress / 0.3) * 100}%, ${preset.primary})`
                  : preset.highlight
                if (preset.pill) { style.background = preset.pill; style.textShadow = 'none' }
                if (preset.glow) style.textShadow = `${shadow}, 0 0 8px ${preset.glow}, 0 0 18px ${preset.glow}`
              }
              return (
                <span key={index} data-caption-state={state} className="relative inline-block whitespace-nowrap" style={style}>
                  {word}
                  {preset.karaoke && state === 'active' && (
                    <span className="absolute inset-0" style={{ color: preset.highlight, textShadow: 'none', clipPath: `inset(0 ${(1 - wordProgress) * 100}% 0 0)` }}>{word}</span>
                  )}
                </span>
              )
            })}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-2">
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label={playing && !disabled ? 'Pause caption preview' : 'Play caption preview'} icon={playing && !disabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} onClick={() => setPlaying((value) => !value)} />
        <Button size="sm" variant="ghost" iconOnly disabled={disabled} aria-label="Replay caption preview" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => { seek(0); setPlaying(true) }} />
        <input type="range" aria-label="Caption preview position" aria-valuetext={`${(time / 1000).toFixed(1)} seconds`} min={0} max={PREVIEW_MS} step={100} value={time} disabled={disabled} className="min-w-0 flex-1 accent-accent" onChange={(event) => { setPlaying(false); seek(Number(event.target.value)) }} />
        <span aria-hidden="true" className="w-16 text-right text-2xs tabular-nums text-ink-subtle">{(time / 1000).toFixed(1)} / {(PREVIEW_MS / 1000).toFixed(1)}s</span>
      </div>
    </section>
  )
}

interface CaptionPresetPickerProps {
  value: string
  onChange: (preset: string) => void
  disabled?: boolean
  showPreview?: boolean
  /** Offer a "No caption" tile for footage that already has captions baked in. */
  allowNone?: boolean
  noneSelected?: boolean
  onSelectNone?: () => void
  /** The user's saved styles, offered as tiles after the built-ins. */
  customStyles?: SavedCaptionStyle[]
  /** Selecting a saved style layers its overrides on its base preset. */
  onSelectCustom?: (style: SavedCaptionStyle) => void
  /** Current overrides, so a saved tile can show as checked and the motion preview can react. */
  styleValue?: CaptionStyleOverrides | null
  onDeleteCustom?: (id: string) => void
}

export function CaptionPresetPicker({ value, onChange, disabled, showPreview = false, allowNone = false, noneSelected = false, onSelectNone, customStyles = [], onSelectCustom, styleValue = null, onDeleteCustom }: CaptionPresetPickerProps): React.JSX.Element {
  const current = PRESETS.find((preset) => preset.id === value) ?? PRESETS[0]
  const previewPreset = styleValue ? applyCaptionStyleOverrides(current, styleValue) : current
  return (
    <div>
      {showPreview && !noneSelected && <CaptionMotionPreview key={styleValue ? `${current.id}:${JSON.stringify(styleValue)}` : current.id} preset={previewPreset} disabled={disabled} />}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2" role="radiogroup" aria-label="Caption style">
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={noneSelected}
            aria-label="No caption"
            aria-description="Clean output — skip burned-in captions"
            title="Clean output — skip burned-in captions"
            disabled={disabled}
            onClick={onSelectNone}
            className={cn(
              'glass-tile glass-tile-hover group relative rounded-xl p-1 text-left hover:-translate-y-0.5',
              noneSelected && 'glass-selected',
              disabled && 'opacity-50'
            )}
          >
            <span
              className="relative flex h-[60px] items-center justify-center overflow-hidden rounded-lg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
              style={{ background: SCENE }}
            >
              <Ban className="h-6 w-6 text-ink-subtle" aria-hidden />
              {noneSelected && (
                <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_1px_rgb(var(--accent)/0.6)] animate-pop-in">
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
              )}
            </span>
            <span className={cn('block truncate px-1.5 pb-0.5 pt-1.5 text-xs font-semibold', noneSelected ? 'text-ink' : 'text-ink/90')}>
              No caption
            </span>
          </button>
        )}
        {PRESETS.map((preset) => {
          const selected = value === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preset.name}
              aria-description={preset.description}
              title={preset.description}
              disabled={disabled}
              onClick={() => onChange(preset.id)}
              className={cn(
                'glass-tile glass-tile-hover group relative rounded-xl p-1 text-left hover:-translate-y-0.5',
                selected && 'glass-selected',
                disabled && 'opacity-50'
              )}
            >
              <span
                className="relative flex h-[60px] items-end justify-center overflow-hidden rounded-lg px-1.5 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
                style={{ background: SCENE }}
              >
                <CaptionSample preset={preset} />
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_1px_rgb(var(--accent)/0.6)] animate-pop-in">
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                )}
              </span>
              <span className={cn('block truncate px-1.5 pb-0.5 pt-1.5 text-xs font-semibold', selected ? 'text-ink' : 'text-ink/90')}>
                {preset.name}
              </span>
              {selected && styleValue && (
                <span className="absolute left-1.5 top-1.5 rounded-full bg-accent px-1.5 py-px text-[9px] font-semibold text-accent-ink">edited</span>
              )}
            </button>
          )
        })}
        {customStyles.map((saved) => {
          const selected = value === saved.preset && sameCaptionStyle(styleValue, saved.style)
          const base = PRESETS.find((preset) => preset.id === saved.preset) ?? PRESETS[0]
          return (
            <button
              key={saved.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={saved.name}
              aria-description={`${base.name} base, customised`}
              disabled={disabled}
              onClick={() => onSelectCustom?.(saved)}
              className={cn(
                'glass-tile glass-tile-hover group relative rounded-xl p-1 text-left hover:-translate-y-0.5',
                selected && 'glass-selected',
                disabled && 'opacity-50'
              )}
            >
              <span
                className="relative flex h-[60px] items-end justify-center overflow-hidden rounded-lg px-1.5 pb-2.5 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)]"
                style={{ background: SCENE }}
              >
                <CaptionSample preset={applyCaptionStyleOverrides(base, saved.style)} />
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_0_0_1px_rgb(var(--accent)/0.6)] animate-pop-in">
                    <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                  </span>
                )}
                {onDeleteCustom && !disabled && (
                  <button
                    type="button"
                    aria-label={`Delete style ${saved.name}`}
                    title={`Delete style ${saved.name}`}
                    className="absolute left-1 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-fill text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                    onClick={(e) => { e.stopPropagation(); onDeleteCustom(saved.id) }}
                  >
                    <X className="h-2.5 w-2.5" strokeWidth={3} />
                  </button>
                )}
              </span>
              <span className={cn('block truncate px-1.5 pb-0.5 pt-1.5 text-xs font-semibold', selected ? 'text-ink' : 'text-ink/90')}>
                {saved.name}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
