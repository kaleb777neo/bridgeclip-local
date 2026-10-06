import { useEffect, useRef, useState } from 'react'
import { getApi } from '../lib/ipc'

/** Audio peaks (0–1, fixed buckets across the source) drawn under the timeline track. */
export function EditorWaveform({ outputDir, duration, viewStart, viewEnd, ranges, height = 30 }: {
  outputDir: string; duration: number; viewStart: number; viewEnd: number; ranges: [number, number][]; height?: number
}): React.JSX.Element | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let active = true
    void getApi().editor.waveform(outputDir).then((p) => { if (active) setPeaks(p) }).catch(() => { if (active) setPeaks(null) })
    return () => { active = false }
  }, [outputDir])
  useEffect(() => {
    const out = canvas.current
    if (!out || !peaks) return
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(out.clientWidth * dpr)), h = Math.round(height * dpr)
    if (out.width !== width || out.height !== h) { out.width = width; out.height = h }
    const ctx = out.getContext('2d')!
    ctx.clearRect(0, 0, width, h)
    const buckets = peaks.length
    for (let x = 0; x < width; x++) {
      const t = viewStart + (x / width) * (viewEnd - viewStart)
      const i = Math.min(buckets - 1, Math.max(0, Math.floor(t / duration * buckets)))
      const selected = ranges.some(([a, b]) => t >= a && t < b)
      const peak = peaks[i] ?? 0
      const bar = Math.max(1, peak * (h / 2 - 1))
      ctx.fillStyle = selected ? 'rgba(120, 200, 160, .75)' : 'rgba(160, 160, 170, .22)'
      ctx.fillRect(x, h / 2 - bar, 1, bar * 2)
    }
  }, [peaks, viewStart, viewEnd, duration, ranges, height])
  if (!peaks) return null
  return <canvas ref={canvas} className="editor-waveform" style={{ height }} aria-hidden />
}
