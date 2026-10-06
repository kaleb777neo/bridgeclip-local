/** Position of the preview strip inside the timeline's current view, in percent. */
export interface StripWindow { startMs: number; endMs: number }

export function filmstripStyle(win: StripWindow, viewStart: number, viewEnd: number): { left: string; width: string } | null {
  const span = viewEnd - viewStart
  if (!(span > 0) || !(win.endMs > win.startMs)) return null
  if (win.endMs <= viewStart || win.startMs >= viewEnd) return null
  const left = Math.max(0, (win.startMs - viewStart) / span * 100)
  const width = Math.min(100 - left, (win.endMs - win.startMs) / span * 100)
  return width > 0 ? { left: `${left}%`, width: `${width}%` } : null
}

/**
 * Frame thumbnails for the timeline, captured from a throwaway video element so
 * the visible preview is never seeked. `seekSeconds` maps a 0..1 fraction of the
 * strip to a position in the FILE (a fast per-reel preview starts at 0). Any
 * failure or abort yields [] — the timeline keeps its plain background.
 */
export function captureFilmstrip(src: string, count: number, seekSeconds: (fraction: number) => number, stopped: () => boolean): Promise<string[]> {
  return new Promise((resolve) => {
    const video = document.createElement('video')
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const finish = (thumbs: string[]): void => {
      clearTimeout(timer)
      video.removeAttribute('src')
      video.load()
      resolve(stopped() ? [] : thumbs)
    }
    const fail = (): void => finish([])
    const timer = setTimeout(fail, 15000)
    video.muted = true
    video.preload = 'auto'
    video.src = src
    video.onerror = fail
    video.onloadeddata = async (): Promise<void> => {
      try {
        const w = 96
        const h = Math.max(2, Math.round(w * video.videoHeight / Math.max(1, video.videoWidth)))
        canvas.width = w
        canvas.height = h
        const thumbs: string[] = []
        for (let i = 0; i < count; i++) {
          if (stopped()) return finish([])
          await new Promise<void>((done) => {
            const onSeeked = (): void => { video.removeEventListener('seeked', onSeeked); done() }
            video.addEventListener('seeked', onSeeked)
            video.currentTime = Math.max(0, Math.min((video.duration || 0) - .05, seekSeconds((i + .5) / count)))
          })
          ctx?.drawImage(video, 0, 0, w, h)
          thumbs.push(canvas.toDataURL('image/jpeg', .5))
        }
        finish(thumbs)
      } catch { fail() }
    }
  })
}
