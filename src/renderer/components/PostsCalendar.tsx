import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, RefreshCw } from 'lucide-react'
import type { CalendarPost } from '../../shared/zernio-posts'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import { addMonths, chipTime, dayKey, monthGrid, monthTitle, shiftDay, WEEKDAY_LABELS } from '../lib/calendar'
import { formatScheduled } from './PostDialog'
import { PlatformIcon, platformName } from './PlatformIcon'
import { Panel } from './ui/Panel'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { WELL } from './ui/Field'

const MAX_CHIPS_PER_CELL = 3

function statusTone(status: string): string {
  if (status === 'scheduled') return 'text-accent'
  if (status === 'published') return 'text-success'
  if (status === 'failed' || status === 'partial') return 'text-danger'
  return 'text-ink-subtle'
}

function statusLabel(status: string): string {
  if (status === 'publishing') return 'Publishing…'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/**
 * Monthly posts calendar over the whole Zernio workspace (BridgeClip's posts
 * and external ones alike), straight from the list endpoint.
 */
export function PostsCalendar(): React.JSX.Element {
  const [view, setView] = useState(() => ({ year: new Date().getFullYear(), month: new Date().getMonth() }))
  const [posts, setPosts] = useState<CalendarPost[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CalendarPost | null>(null)
  const [platformFilter, setPlatformFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')

  const grid = useMemo(() => monthGrid(view), [view])

  const load = useCallback(async (window: { from: string; to: string }): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      // Pad a day on each side: Zernio resolves the window server-side, and a
      // post scheduled near midnight must land on its local calendar day.
      const result = await getApi().zernio.posts.calendar(shiftDay(window.from, -1), shiftDay(window.to, 1))
      setPosts(result.posts)
      setTruncated(result.truncated)
      if (result.error) setError(result.error)
    } catch (err) {
      setError(errorMessage(err, 'Could not load the calendar.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setSelected(null)
    void load(grid)
  }, [grid, load])

  const platforms = useMemo(() =>
    [...new Set(posts.flatMap((post) => post.targets.map((target) => target.platform)))].sort(), [posts])

  const visible = useMemo(() => posts.filter((post) =>
    (platformFilter === 'all' || post.targets.some((target) => target.platform === platformFilter)) &&
    (sourceFilter === 'all' || post.source === sourceFilter)), [posts, platformFilter, sourceFilter])

  const byDay = useMemo(() => {
    const days = new Map<string, CalendarPost[]>()
    for (const post of visible) {
      const key = dayKey(new Date(post.when))
      const bucket = days.get(key)
      if (bucket) bucket.push(post)
      else days.set(key, [post])
    }
    for (const bucket of days.values()) bucket.sort((a, b) => a.when.localeCompare(b.when))
    return days
  }, [visible])

  const goToday = (): void => setView({ year: new Date().getFullYear(), month: new Date().getMonth() })
  const isCurrentMonth = view.year === new Date().getFullYear() && view.month === new Date().getMonth()

  return (
    <div className="space-y-3">
      {error && (
        <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>
      )}

      <Panel padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
          <div className="flex items-center gap-0.5">
            <Button size="sm" variant="ghost" iconOnly aria-label="Previous month" onClick={() => setView(addMonths(view, -1))} icon={<ChevronLeft className="h-4 w-4" />} />
            <Button size="sm" variant="ghost" iconOnly aria-label="Next month" disabled={false} onClick={() => setView(addMonths(view, 1))} icon={<ChevronRight className="h-4 w-4" />} />
            <Button size="sm" variant="ghost" disabled={isCurrentMonth} onClick={goToday}>Today</Button>
          </div>
          <h2 className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-ink">{monthTitle(view)}</h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xs tabular text-ink-subtle">{visible.length} post{visible.length === 1 ? '' : 's'}</span>
            <Button size="sm" variant="ghost" iconOnly aria-label="Refresh calendar" title="Refresh" disabled={loading} onClick={() => void load(grid)}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <label className="flex items-center gap-1.5 text-2xs text-ink-muted">
            Platform
            <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)}
              aria-label="Filter by platform" className={cn('h-[26px] rounded-full px-2.5 text-xs text-ink [color-scheme:dark] focus:outline-none', WELL)}>
              <option value="all">All</option>
              {platforms.map((platform) => <option key={platform} value={platform}>{platformName(platform)}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-2xs text-ink-muted">
            Source
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
              aria-label="Filter by source" className={cn('h-[26px] rounded-full px-2.5 text-xs text-ink [color-scheme:dark] focus:outline-none', WELL)}>
              <option value="all">All</option>
              <option value="zernio">Via Zernio</option>
              <option value="external">External</option>
            </select>
          </label>
          {truncated && <p className="ml-auto text-2xs text-ink-subtle">Showing the newest 1000 posts per source in this range.</p>}
        </div>

        <div className="grid grid-cols-7 border-b border-white/[0.06]" aria-hidden>
          {WEEKDAY_LABELS.map((label) => (
            <span key={label} className="px-1.5 py-1 text-center text-2xs font-medium uppercase tracking-wide text-ink-muted">{label}</span>
          ))}
        </div>

        <div role="grid" aria-label={`${monthTitle(view)} posts`} className="grid grid-cols-7">
          {grid.cells.map((cell) => {
            const dayPosts = byDay.get(cell.key) ?? []
            const shown = dayPosts.slice(0, MAX_CHIPS_PER_CELL)
            const hidden = dayPosts.length - shown.length
            return (
              <div key={cell.key} role="gridcell" aria-label={cell.key}
                className={cn('min-h-[92px] border-b border-r border-white/[0.04] p-1 last:border-r-0', !cell.inMonth && 'opacity-40')}>
                <div className="flex items-center justify-between px-0.5 pb-1">
                  <span className={cn('font-mono text-2xs tabular', cell.isToday ? 'rounded-full bg-accent px-1.5 text-ink-inverted' : cell.isWeekend ? 'text-ink-subtle' : 'text-ink-muted')}>
                    {cell.dayOfMonth}
                  </span>
                  {dayPosts.length > 0 && cell.inMonth && (
                    <span className="font-mono text-[10px] tabular text-ink-faint">{dayPosts.length}</span>
                  )}
                </div>
                <div className="space-y-1">
                  {shown.map((post) => {
                    const isSelected = selected?.id === post.id
                    return (
                      <button key={post.id} type="button" onClick={() => setSelected(isSelected ? null : post)}
                        aria-label={`${chipTime(post.when)} ${statusLabel(post.status)}: ${post.title ?? post.content ?? 'post'}`}
                        className={cn(
                          'flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-2xs transition-colors duration-100',
                          isSelected ? 'bg-accent/20 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]' : 'bg-white/[0.04] hover:bg-white/[0.08]')}>
                        <span className="flex shrink-0 items-center gap-0.5">
                          {[...new Set(post.targets.map((target) => target.platform))].slice(0, 3).map((platform) => (
                            <PlatformIcon key={platform} platform={platform} className="h-3.5 w-3.5 rounded-full [&_svg]:h-2 [&_svg]:w-2" />
                          ))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono tabular text-ink-muted">{chipTime(post.when)}</span>
                        </span>
                        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', post.status === 'published' ? 'bg-success' : post.status === 'scheduled' ? 'bg-accent' : post.status === 'failed' || post.status === 'partial' ? 'bg-danger' : 'bg-ink-faint')} />
                      </button>
                    )
                  })}
                  {hidden > 0 && <p className="px-1 text-[10px] text-ink-subtle">+{hidden} more</p>}
                </div>
              </div>
            )
          })}
        </div>
      </Panel>

      {selected && <CalendarDetail post={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function CalendarDetail({ post, onClose }: { post: CalendarPost; onClose: () => void }): React.JSX.Element {
  return (
    <Panel>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{post.title ?? post.content ?? 'Untitled post'}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <span className={statusTone(post.status)}>{statusLabel(post.status)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1"><Clock3 aria-hidden className="h-3 w-3" />{formatScheduled(post.when, post.timezone)}</span>
            {post.source === 'external' && (
              <span className="rounded-full bg-white/[0.07] px-1.5 py-px text-2xs text-ink-muted">Posted outside Zernio</span>
            )}
          </p>
        </div>
        <Button size="sm" variant="ghost" iconOnly aria-label="Close details" onClick={onClose} icon={<ChevronRight className="h-3.5 w-3.5" />} />
      </div>
      {post.content && post.content !== post.title && (
        <p className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-muted" data-selectable>{post.content}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {post.targets.map((target) => {
          const chip = (
            <>
              <PlatformIcon platform={target.platform} className="h-4 w-4 rounded-full [&_svg]:h-2.5 [&_svg]:w-2.5" />
              <span className="max-w-[140px] truncate text-ink">{target.handle ?? platformName(target.platform)}</span>
              {target.status && <span className="text-ink-subtle">· {target.status}</span>}
            </>
          )
          const className = 'inline-flex h-[22px] items-center gap-1.5 rounded-full bg-white/[0.05] pl-[3px] pr-2 text-2xs text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.09),inset_0_1px_0_rgb(255_255_255/0.06)]'
          return target.url ? (
            <button key={`${post.id}:${target.platform}:${target.handle ?? ''}`} type="button"
              onClick={() => { void getApi().zernio.posts.openCalendarLink(target.platform, target.url!) }}
              title={`Open on ${platformName(target.platform)}`}
              aria-label={`Open on ${platformName(target.platform)}, ${target.handle ?? 'account'}`}
              className={cn(className, 'transition-[background,box-shadow,color] duration-150 hover:bg-white/[0.09] hover:text-ink hover:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.16),inset_0_1px_0_rgb(255_255_255/0.08)]')}>
              {chip}
              <ArrowUpRight className="h-3 w-3" />
            </button>
          ) : (
            <span key={`${post.id}:${target.platform}:${target.handle ?? ''}`} className={className}>{chip}</span>
          )
        })}
      </div>
    </Panel>
  )
}
