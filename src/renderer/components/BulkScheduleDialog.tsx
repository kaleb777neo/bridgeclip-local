import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, CalendarClock, X } from 'lucide-react'
import { Button } from './ui/Button'
import type { PostableClip } from './PostDialog'
import { formatScheduled } from './PostDialog'

function localInput(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Bulk Scheduling: order the selected clips, pick a start time and an
 * interval, and every clip gets its own slot (start + i × interval).
 */
export function BulkScheduleDialog({ clips, timeZone, onCancel, onStart }: {
  clips: PostableClip[]
  timeZone?: string | null
  onCancel: () => void
  onStart: (startISO: string, intervalMinutes: number, order: PostableClip[]) => void
}): React.JSX.Element {
  const [order, setOrder] = useState<PostableClip[]>(() => [...clips])
  const quarter = 15 * 60_000
  const [startValue, setStartValue] = useState(() => localInput(Math.ceil((Date.now() + 60 * 60_000) / quarter) * quarter))
  const [intervalMinutes, setIntervalMinutes] = useState(60)

  const startMs = Number.isFinite(Date.parse(startValue)) ? Date.parse(startValue) : Date.now() + 60 * 60_000
  const valid = Number.isFinite(startMs) && startMs > Date.now() - 60_000 && intervalMinutes >= 1 && order.length > 0

  const starts = useMemo(() => order.map((_, i) => startMs + i * intervalMinutes * 60_000), [order, startMs, intervalMinutes])

  const move = (index: number, delta: -1 | 1): void => {
    const next = [...order]
    const other = index + delta
    if (other < 0 || other >= next.length) return
    ;[next[index], next[other]] = [next[other], next[index]]
    setOrder(next)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Schedule clips in a batch">
      <div className="glass max-h-[86vh] w-full max-w-xl overflow-y-auto rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-ink">Schedule {order.length} clips in a batch</h2>
            <p className="mt-1 text-xs text-ink-subtle">Set the posting order, the first slot and the spacing. Each clip is scheduled at start + i × interval.</p>
          </div>
          <Button size="sm" variant="ghost" iconOnly icon={<X className="h-4 w-4" />} aria-label="Close bulk scheduling" onClick={onCancel} />
        </div>

        <div className="mt-4 space-y-2">
          {order.map((clip, index) => (
            <div key={`${clip.path}-${index}`} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
              <span className="w-6 text-center font-mono text-xs text-ink-subtle">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink">{clip.title}</span>
              <span className="whitespace-nowrap font-mono text-2xs tabular-nums text-ink-subtle">
                {formatScheduled(new Date(starts[index]).toISOString(), timeZone)}
              </span>
              <span className="flex flex-col">
                <button type="button" aria-label={`Move ${clip.title} up`} className="text-ink-subtle hover:text-ink disabled:opacity-30" disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label={`Move ${clip.title} down`} className="text-ink-subtle hover:text-ink disabled:opacity-30" disabled={index === order.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="text-xs text-ink">
            <span className="mb-1 block font-medium">First post</span>
            <input type="datetime-local" className="w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-2 text-sm" value={startValue} aria-label="First post time"
              onChange={(event) => setStartValue(event.target.value)} />
          </label>
          <label className="text-xs text-ink">
            <span className="mb-1 block font-medium">Interval</span>
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={10080} className="w-full rounded-md border border-white/15 bg-black/30 px-2.5 py-2 text-sm" value={intervalMinutes}
                aria-label="Minutes between posts" onChange={(event) => setIntervalMinutes(Math.max(1, Math.floor(Number(event.target.value) || 1)))} />
              <span className="whitespace-nowrap text-ink-subtle">min</span>
            </div>
          </label>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" icon={<CalendarClock className="h-4 w-4" />} disabled={!valid}
            onClick={() => onStart(new Date(startMs).toISOString(), intervalMinutes, order)}>
            Continue with {order.length} slots
          </Button>
        </div>
      </div>
    </div>
  )
}
