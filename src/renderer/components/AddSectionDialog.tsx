import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Plus, X } from 'lucide-react'
import { cn, formatTimecode, localFileUrl } from '../lib/utils'
import { Button } from './ui/Button'

/** Long-form clock (h:mm:ss), matching the section picker's readouts. */
function sectionClock(ms: number): string {
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const MIN_SECTION_MS = 100
const MAX_SECTION_MS = 20 * 60 * 1000

/**
 * "Add a section": watch the full source video, pick a time window (dual
 * thumbs, max 20 minutes), and append it to the clip as one more cut.
 */
export function AddSectionDialog({ src, durationMs, defaultStart, onAdd, onClose }: {
  src: string
  durationMs: number
  /** Where the picker opens — usually right after the clip's last section. */
  defaultStart: number
  onAdd: (a: number, b: number) => void
  onClose: () => void
}): React.JSX.Element {
  const initialA = Math.max(0, Math.min(Math.max(0, durationMs - 60_000), defaultStart))
  const [a, setA] = useState(initialA)
  const [b, setB] = useState(Math.min(durationMs, initialA + 60_000))
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(initialA / 1000)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onTime = (): void => {
      setTime(video.currentTime)
      if (video.currentTime * 1000 >= b) { video.pause(); setPlaying(false) }
    }
    video.addEventListener('timeupdate', onTime)
    return () => video.removeEventListener('timeupdate', onTime)
  }, [b])

  const seekVideo = (ms: number): void => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = ms / 1000
    setTime(ms / 1000)
  }

  const thumbDown = (which: 'a' | 'b') => (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault(); e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    videoRef.current?.pause(); setPlaying(false)
    const track = trackRef.current
    const clampA = (t: number): number => Math.max(0, Math.min(b - MIN_SECTION_MS, t))
    const clampB = (t: number): number => Math.min(durationMs, Math.max(a + MIN_SECTION_MS, t))
    if (track) seekVideo(which === 'a' ? clampA(a) : clampB(b))
    const move = (event: PointerEvent): void => {
      if (!track) return
      const t = Math.round((event.clientX - track.getBoundingClientRect().left) / track.clientWidth * durationMs)
      if (which === 'a') {
        const nextA = clampA(t)
        setA(nextA)
        setB((current) => Math.min(current, nextA + MAX_SECTION_MS))
        seekVideo(nextA)
      } else {
        const nextB = clampB(t)
        setB(nextB)
        setA((current) => Math.max(current, nextB - MAX_SECTION_MS))
        seekVideo(nextB)
      }
    }
    const done = (): void => { e.currentTarget.removeEventListener('pointermove', move); e.currentTarget.removeEventListener('lostpointercapture', done) }
    e.currentTarget.addEventListener('pointermove', move)
    e.currentTarget.addEventListener('lostpointercapture', done)
  }

  const trackDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!trackRef.current) return
    const t = Math.round((e.clientX - trackRef.current.getBoundingClientRect().left) / trackRef.current.clientWidth * durationMs)
    // A track click moves the nearest thumb.
    if (Math.abs(t - a) <= Math.abs(t - b)) { setA(Math.max(0, Math.min(b - MIN_SECTION_MS, t))); seekVideo(Math.max(0, Math.min(b - MIN_SECTION_MS, t))) }
    else { setB(Math.min(durationMs, Math.max(a + MIN_SECTION_MS, t))); seekVideo(Math.min(durationMs, Math.max(a + MIN_SECTION_MS, t))) }
  }

  const togglePlay = (): void => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      if (video.currentTime * 1000 < a || video.currentTime * 1000 >= b) seekVideo(a)
      void video.play().then(() => setPlaying(true)).catch(() => setPlaying(false))
    } else { video.pause(); setPlaying(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Add a section"
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass-thick w-full max-w-2xl rounded-2xl p-4">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
          <p className="text-sm font-semibold text-ink">Add a section</p>
          <span className="text-2xs text-ink-subtle">Select a time period to add. Maximum 20 minutes.</span>
          <Button size="sm" variant="ghost" iconOnly icon={<X className="h-3.5 w-3.5" />} aria-label="Close add a section" onClick={onClose} />
        </div>

        <div className="pt-5">
          <div ref={trackRef} className="relative h-6 cursor-pointer" onPointerDown={trackDown}>
            <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15" />
            <span className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent" style={{ left: `${a / durationMs * 100}%`, width: `${(b - a) / durationMs * 100}%` }} />
            {([['a', a], ['b', b]] as const).map(([which, value]) => (
              <div key={which} role="slider" aria-label={which === 'a' ? 'Section start' : 'Section end'} aria-valuemin={0} aria-valuemax={durationMs} aria-valuenow={value}
                className={cn('absolute top-1/2 h-5 w-5 -translate-y-1/2 -translate-x-1/2 cursor-ew-resize rounded-full border-2 border-white/80 bg-black/60')}
                style={{ left: `${value / durationMs * 100}%` }}
                onPointerDown={thumbDown(which)} />
            ))}
          </div>
          <div className="flex items-center justify-between pt-2 text-xs text-ink-subtle">
            <span className="rounded-md bg-white/[0.06] px-2 py-1 font-mono" role="status">{sectionClock(a)}</span>
            <span className="font-mono text-2xs">{formatTimecode(b - a)} selected</span>
            <span className="rounded-md bg-white/[0.06] px-2 py-1 font-mono" role="status">{sectionClock(b)}</span>
          </div>
        </div>

        <div className="relative mt-3 overflow-hidden rounded-xl bg-black/50">
          <video ref={videoRef} src={localFileUrl(src)} preload="auto" playsInline className="max-h-[46vh] w-full object-contain"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} onPause={() => setPlaying(false)} />
          <button type="button" aria-label={playing ? 'Pause preview' : 'Play preview'} onClick={togglePlay}
            className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/55 text-white">
              {playing ? <Pause className="h-6 w-6" /> : <Play className="ml-1 h-6 w-6" />}
            </span>
          </button>
          <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 font-mono text-2xs text-white" role="status">{sectionClock(time * 1000)}</span>
        </div>

        <div className="flex items-center justify-end gap-2 pt-3">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} disabled={b - a < MIN_SECTION_MS}
            onClick={() => onAdd(a, b)}>Add</Button>
        </div>
      </div>
    </div>
  )
}
