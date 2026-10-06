/** Pure FCPXML 1.8 builder: no Node or Electron imports so the renderer and tests can reuse it. */

export interface FcpXmlAsset {
  /** Stable id used by sequence items, e.g. "a0". */
  id: string
  name: string
  /** Absolute file URL (pathToFileURL on the main side). */
  srcUrl: string
  durationMs: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

/** Pan & zoom that maps a normalized source crop rect onto the output frame. */
export interface FcpXmlTransform { scaleX: number; scaleY: number; offsetX: number; offsetY: number }

/** Connected clips (b-roll) and caption titles riding lanes beside the spine. */
export type FcpXmlOverlay =
  | { kind: 'video'; assetId: string; offsetMs: number; startMs: number; durationMs: number; lane: number }
  | { kind: 'title'; text: string; offsetMs: number; durationMs: number; lane: number }

export interface FcpXmlSequence {
  name: string
  /** Timeline items in play order; each cuts a span out of one asset. */
  items: Array<{ assetId: string; startMs: number; durationMs: number; transform?: FcpXmlTransform }>
  /** Overlays ride lanes beside the spine; `offsetMs` is spine time. */
  overlays?: FcpXmlOverlay[]
}

/** Crop-to-fill transform for a normalized crop rect [x, y, w, h] on the source. */
export function cropTransform(crop: readonly [number, number, number, number]): FcpXmlTransform {
  const [x, y, w, h] = crop
  const cw = Math.max(0.01, w), ch = Math.max(0.01, h)
  return { scaleX: 1 / cw, scaleY: 1 / ch, offsetX: -(x / cw), offsetY: -(y / ch) }
}

const COMMON_FRAME_DURATIONS: Array<[number, string]> = [
  [24, '1/24s'], [25, '1/25s'], [30, '1/30s'], [50, '1/50s'], [60, '1/60s'],
  [23.976, '1001/24000s'], [29.97, '1001/30000s'], [59.94, '1001/60000s'],
]

export function frameDuration(fps: number): string {
  for (const [rate, value] of COMMON_FRAME_DURATIONS) {
    if (Math.abs(fps - rate) < 0.01) return value
  }
  if (!Number.isFinite(fps) || fps <= 0) return '1/30s'
  return `${Math.round(1000 / fps)}/1000s`
}

/** FCPXML rational time: an exact fraction of seconds. */
export function rationalTime(ms: number): string {
  return `${Math.max(0, Math.round(ms))}/1000s`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function attr(value: string): string {
  return escapeXml(value)
}

export function buildTimeline(title: string, assets: FcpXmlAsset[], sequences: FcpXmlSequence[]): string {
  if (sequences.length === 0) throw new Error('No clips to export')
  const byId = new Map<string, FcpXmlAsset>()
  for (const asset of assets) {
    if (!asset.srcUrl.startsWith('file://')) throw new Error('Clip sources must be file URLs')
    if (!Number.isFinite(asset.durationMs) || asset.durationMs <= 0) throw new Error('Clip duration must be positive')
    if (!Number.isFinite(asset.width) || !Number.isFinite(asset.height) || asset.width <= 0 || asset.height <= 0) {
      throw new Error('Clip dimensions must be positive')
    }
    if (byId.has(asset.id)) throw new Error('Duplicate asset id')
    byId.set(asset.id, asset)
  }
  for (const sequence of sequences) {
    if (sequence.items.length === 0) throw new Error('Sequences need at least one item')
    for (const item of sequence.items) {
      const asset = byId.get(item.assetId)
      if (!asset) throw new Error('Unknown asset reference')
      if (!Number.isFinite(item.startMs) || item.startMs < 0) throw new Error('Segment start must be positive')
      if (!Number.isFinite(item.durationMs) || item.durationMs <= 0) throw new Error('Segment duration must be positive')
      if (item.startMs + item.durationMs > asset.durationMs + 1000) throw new Error('Segment exceeds its asset')
    }
    for (const overlay of sequence.overlays ?? []) {
      if (overlay.kind === 'video') {
        const asset = byId.get(overlay.assetId)
        if (!asset) throw new Error('Unknown overlay asset reference')
        if (!Number.isFinite(overlay.startMs) || overlay.startMs < 0) throw new Error('Overlay start must be positive')
        if (!Number.isFinite(overlay.durationMs) || overlay.durationMs <= 0) throw new Error('Overlay duration must be positive')
        if (overlay.startMs + overlay.durationMs > asset.durationMs + 1000) throw new Error('Overlay exceeds its asset')
      } else if (!overlay.text.trim()) {
        throw new Error('Caption titles need text')
      } else if (!Number.isFinite(overlay.durationMs) || overlay.durationMs <= 0) {
        throw new Error('Overlay duration must be positive')
      }
    }
  }
  const formats = new Map<string, { id: string; fps: number; width: number; height: number }>()
  const formatFor = (asset: FcpXmlAsset): string => {
    const key = `${asset.width}x${asset.height}@${asset.fps}`
    let format = formats.get(key)
    if (!format) {
      format = { id: `r${formats.size + 1}`, fps: asset.fps, width: asset.width, height: asset.height }
      formats.set(key, format)
    }
    return format.id
  }
  const formatLines: string[] = []
  const assetLines: string[] = []
  const sequenceLines: string[] = []
  const seenFormats = new Set<string>()
  const formatLine = (asset: FcpXmlAsset): string => {
    const formatId = formatFor(asset)
    if (!seenFormats.has(formatId)) {
      seenFormats.add(formatId)
      formatLines.push(`    <format id="${formatId}" frameDuration="${frameDuration(asset.fps)}" width="${asset.width}" height="${asset.height}"/>`)
    }
    return formatId
  }
  for (const asset of assets) {
    const formatId = formatLine(asset)
    assetLines.push(
      `    <asset id="${asset.id}" name="${attr(asset.name)}" src="${attr(asset.srcUrl)}" start="0s" duration="${rationalTime(asset.durationMs)}"` +
      ` hasVideo="1" hasAudio="${asset.hasAudio ? 1 : 0}"${asset.hasAudio ? ' audioSources="1" audioChannels="2"' : ''} format="${formatId}"/>`,
    )
  }
  sequences.forEach((sequence, index) => {
    const first = byId.get(sequence.items[0].assetId)!
    const formatId = formatLine(first)
    let offset = 0
    const itemLines = sequence.items.map((item, itemIndex) => {
      const asset = byId.get(item.assetId)!
      if (formatFor(asset) !== formatId) throw new Error('Mixed formats in one sequence are not supported')
      const transform = item.transform
        ? ` scale="${item.transform.scaleX.toFixed(6)} ${item.transform.scaleY.toFixed(6)}"` +
          ` offset="${item.transform.offsetX.toFixed(6)} ${item.transform.offsetY.toFixed(6)}"` +
          ` anchor="0 0"`
        : ''
      const line =
        `          <asset-clip id="clip-${index}-${itemIndex}" ref="${item.assetId}" offset="${rationalTime(offset)}"` +
        ` start="${rationalTime(item.startMs)}" duration="${rationalTime(item.durationMs)}" format="${formatId}" tcFormat="NDF">` +
        (transform ? `<adjust-transform${transform}/>` : '') +
        `</asset-clip>`
      offset += item.durationMs
      return line
    })
      const overlayLines: string[] = []
      for (const [overlayIndex, overlay] of (sequence.overlays ?? []).entries()) {
        if (overlay.kind === 'video') {
          const asset = byId.get(overlay.assetId)
          if (!asset) throw new Error('Unknown overlay asset reference')
          const overlayFormat = formatFor(asset)
          overlayLines.push(
            `          <asset-clip lane="${overlay.lane}" id="overlay-${index}-${overlayIndex}" ref="${overlay.assetId}"` +
            ` offset="${rationalTime(overlay.offsetMs)}" start="${rationalTime(overlay.startMs)}"` +
            ` duration="${rationalTime(overlay.durationMs)}" format="${overlayFormat}" tcFormat="NDF"/>`)
        } else {
          if (!overlay.text.trim()) throw new Error('Caption titles need text')
          overlayLines.push(
            `          <title lane="${overlay.lane}" id="caption-${index}-${overlayIndex}" name="Caption"` +
            ` offset="${rationalTime(overlay.offsetMs)}" duration="${rationalTime(overlay.durationMs)}">` +
            `<text><text-style font="Montserrat" font-size="48" font-face="Bold" color="1 1 1 1" alignment="center">` +
            `${attr(overlay.text)}</text-style></text></title>`)
        }
      }
    sequenceLines.push(
      `      <sequence id="sequence-${index}" name="${attr(sequence.name)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo"` +
      ` audioFormat="s16" format="${formatId}">\n` +
      // Connected clips and titles ride lanes inside the spine — children of
      // <sequence> outside it are not valid FCPXML and NLEs drop them.
      `        <spine>\n` +
      [...itemLines, ...overlayLines].join('\n') + '\n' +
      `        </spine>\n` +
      `      </sequence>`,
    )
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
${formatLines.join('\n')}
${assetLines.join('\n')}
  </resources>
  <library>
    <event id="event-0" name="${attr(title)}">
${sequenceLines.join('\n')}
    </event>
  </library>
</fcpxml>
`
}

export interface FcpXmlClip extends Omit<FcpXmlAsset, 'id'> {}

/** One full-length clip per sequence — the shape the library's rendered clips export as. */
export function buildFcpxml(title: string, clips: FcpXmlClip[]): string {
  return buildTimeline(title,
    clips.map((clip, index) => ({ ...clip, id: `a${index}` })),
    clips.map((clip, index) => ({ name: clip.name, items: [{ assetId: `a${index}`, startMs: 0, durationMs: clip.durationMs }] })))
}
