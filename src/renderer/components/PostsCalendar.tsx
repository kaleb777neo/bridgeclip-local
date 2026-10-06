import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock3, LayoutGrid, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import type { CalendarPost } from '../../shared/zernio-posts'
import type { ZernioAccount } from '../../shared/zernio'
import { getApi } from '../lib/ipc'
import { cn, errorMessage } from '../lib/utils'
import {
  addDays, chipTime, dayKey, layoutDayCards, minutesOfDay, movedWhen, monthGrid, monthTitle,
  shiftDay, weekGrid, WEEKDAY_LABELS,
} from '../lib/calendar'
import { PlatformIcon, platformName } from './PlatformIcon'
import { Panel } from './ui/Panel'
import { Button } from './ui/Button'
import { Callout } from './ui/Callout'
import { Dialog } from './ui/Dialog'
import { WELL } from './ui/Field'
import { SchedulePostDialog } from './SchedulePostDialog'
import { usePostsStore } from '../store/use-posts-store'
import type { Page } from './Sidebar'

/** Height of one hour row in the week grid, px. */
const HOUR_PX = 56
/** Zernio needs a few minutes of lead time; earlier slots cannot be scheduled into. */
const SCHEDULE_LEAD_MS = 5 * 60_000

function isPastSlot(key: string, hour: number): boolean {
  return new Date(`${key}T00:00:00`).getTime() + hour * 3_600_000 < Date.now() + SCHEDULE_LEAD_MS
}

/**
 * The hour a month cell's "+" schedules into: today gets the next whole hour
 * still ahead of us, later days the 9:00 working default, past days nothing.
 */
function openSlotHour(key: string): number | null {
  const now = new Date()
  if (key === dayKey(now)) {
    const next = now.getHours() + 1
    return next <= 23 && !isPastSlot(key, next) ? next : null
  }
  return key > dayKey(now) ? 9 : null
}

export type CalendarMode = 'week' | 'month'

function statusLabel(status: string): string {
  if (status === 'publishing') return 'Publishing…'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function StatusMark({ status }: { status: string }): React.JSX.Element {
  if (status === 'published' || status === 'partial') return <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
  if (status === 'failed') return <AlertCircle aria-hidden className="h-3.5 w-3.5 shrink-0 text-danger" />
  if (status === 'scheduled' || status === 'publishing') return <Clock3 aria-hidden className={cn('h-3.5 w-3.5 shrink-0', status === 'publishing' ? 'text-accent' : 'text-ink-subtle')} />
  return <Clock3 aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
}

function postTitle(post: CalendarPost): string {
  return post.title ?? post.content ?? 'Untitled post'
}

/**
 * Posts calendar over the whole Zernio workspace (BridgeClip's posts and
 * external ones alike): a week time grid or a month grid, with a mini month
 * and the connected accounts beside it.
 */
export function PostsCalendar({ mode, onModeChange, onNavigate, onSchedule, onReschedule, reloadSignal }: {
  mode: CalendarMode
  onModeChange: (mode: CalendarMode) => void
  onNavigate: (page: Page) => void
  /** The Schedule Post dialog, opened by a "+" on a day or hour slot. */
  onSchedule: (slot: { key: string; hour: number }) => void
  /** Drag & drop: move a scheduled post onto another day/hour. False = refused. */
  onReschedule: (post: CalendarPost, whenIso: string) => Promise<boolean>
  /** Bumped after a post is made so the grid refetches. */
  reloadSignal: number
}): React.JSX.Element {
  const [anchor, setAnchor] = useState(() => new Date())
  // Re-render once a minute so "today", the past-slot cutoff and the mini
  // month survive the app being left open across midnight.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  const [posts, setPosts] = useState<CalendarPost[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<CalendarPost | null>(null)
  const [editingPost, setEditingPost] = useState<CalendarPost | null>(null)
  const [dragPost, setDragPost] = useState<CalendarPost | null>(null)
  const [dropKey, setDropKey] = useState<string | null>(null)
  const localPosts = usePostsStore((s) => s.posts)
  const [accounts, setAccounts] = useState<ZernioAccount[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  const view = { year: anchor.getFullYear(), month: anchor.getMonth() }
  const month = useMemo(() => monthGrid(view), [view.year, view.month, nowTick])
  const week = useMemo(() => weekGrid(anchor), [anchor, nowTick])
  // The mini month always shows the anchor's month, so a week that crosses a
  // month boundary must fetch both windows.
  const from = mode === 'month' ? month.from : (week.from < month.from ? week.from : month.from)
  const to = mode === 'month' ? month.to : (week.to > month.to ? week.to : month.to)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      // Pad a day on each side: Zernio resolves the window server-side, and a
      // post scheduled near midnight must land on its local calendar day.
      const result = await getApi().zernio.posts.calendar(shiftDay(from, -1), shiftDay(to, 1))
      setPosts(result.posts)
      setTruncated(result.truncated)
      if (result.error) setError(result.error)
    } catch (err) {
      setError(errorMessage(err, 'Could not load the calendar.'))
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => {
    setSelected(null)
    void load()
  }, [load, reloadSignal])

  useEffect(() => {
    void (async () => {
      try {
        const cached = await getApi().zernio.cachedOverview()
        if (cached?.accounts.length) setAccounts(cached.accounts)
        setAccounts((await getApi().zernio.overview()).accounts)
      } catch { /* the rail simply stays empty until Accounts syncs */ }
    })()
  }, [])

  // Open the week where the working day starts, not at midnight.
  useEffect(() => {
    if (mode === 'week' && scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_PX
  }, [mode])

  /** Only our own scheduled posts can move: published/failed/external are fixed. */
  const movable = (post: CalendarPost): boolean => post.source === 'zernio' && post.status === 'scheduled'
  const dropPost = async (post: CalendarPost | null, dayKey: string, minutes: number | null): Promise<void> => {
    setDropKey(null)
    setDragPost(null)
    if (!post || !movable(post)) return
    if (!(await onReschedule(post, movedWhen(post.when, dayKey, minutes ?? undefined)))) {
      setError('That post could not be moved — check that the new time is in the future and inside the scheduling window.')
    }
  }

  const byDay = useMemo(() => {
    const days = new Map<string, CalendarPost[]>()
    for (const post of posts) {
      const key = dayKey(new Date(post.when))
      const bucket = days.get(key)
      if (bucket) bucket.push(post)
      else days.set(key, [post])
    }
    for (const bucket of days.values()) bucket.sort((a, b) => a.when.localeCompare(b.when))
    return days
  }, [posts])

  const monthPrefix = `${view.year}-${String(view.month + 1).padStart(2, '0')}`
  const monthCount = useMemo(() => [...byDay.entries()]
    .filter(([key]) => key.startsWith(monthPrefix))
    .reduce((total, [, list]) => total + list.length, 0), [byDay, monthPrefix])
  const activeAccounts = accounts.filter((account) => account.isActive && !account.needsReconnect).length

  const goToday = (): void => setAnchor(new Date())
  const shiftRange = (delta: number): void => setAnchor((current) => mode === 'week'
    ? addDays(current, delta * 7)
    : new Date(current.getFullYear(), current.getMonth() + delta, 1))
  const rangeTitle = mode === 'week' ? week.title : monthTitle(view)
  const isAnchorToday = dayKey(anchor) === dayKey(new Date())

  return (
    <div className="space-y-3">
      {error && <Callout tone="danger" onDismiss={() => setError(null)}>{error}</Callout>}
      <div className="flex items-start gap-3">
        <aside className="w-[216px] shrink-0 space-y-3">
          <Panel padded={false} className="p-3">
            <div className="flex items-center justify-between gap-1">
              <span className="truncate text-xs font-semibold text-ink">{monthTitle(view)}</span>
              <div className="flex items-center gap-0.5">
                <Button size="sm" variant="ghost" iconOnly aria-label="Previous month" onClick={() => setAnchor(new Date(view.year, view.month - 1, 1))} icon={<ChevronLeft className="h-3.5 w-3.5" />} />
                <Button size="sm" variant="ghost" iconOnly aria-label="Next month" onClick={() => setAnchor(new Date(view.year, view.month + 1, 1))} icon={<ChevronRight className="h-3.5 w-3.5" />} />
              </div>
            </div>
            <div className="mt-2 grid grid-cols-7 text-center" role="presentation">
              {WEEKDAY_LABELS.map((label) => (
                <span key={label} className="py-0.5 text-[10px] font-medium uppercase text-ink-faint">{label.slice(0, 1)}</span>
              ))}
              {month.cells.map((cell) => {
                const hasPosts = (byDay.get(cell.key)?.length ?? 0) > 0
                return (
                  <button key={cell.key} type="button" onClick={() => setAnchor(new Date(`${cell.key}T00:00:00`))}
                    aria-label={cell.key}
                    className="flex flex-col items-center gap-0.5 py-0.5">
                    <span className={cn('flex h-5 w-5 items-center justify-center rounded-full font-mono text-2xs tabular',
                      cell.isToday ? 'bg-accent text-ink-inverted' : cell.inMonth ? 'text-ink-muted hover:bg-white/[0.07]' : 'text-ink-faint')}>
                      {cell.dayOfMonth}
                    </span>
                    <span aria-hidden className={cn('h-[3px] w-[3px] rounded-full', hasPosts && cell.inMonth ? 'bg-ink-subtle' : 'bg-transparent')} />
                  </button>
                )
              })}
            </div>
            <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={isAnchorToday} onClick={goToday}>Today</Button>
            <p className="mt-2 text-2xs text-ink-muted">
              <span className="font-mono tabular text-ink">{monthCount}</span> posts scheduled this month
            </p>
          </Panel>

          <Panel padded={false} className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink">Connections</span>
              <span className="font-mono text-2xs tabular text-ink-subtle">{activeAccounts} active</span>
            </div>
            {accounts.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {accounts.map((account) => {
                  const dot = !account.isActive ? 'bg-ink-faint'
                    : account.needsReconnect ? 'bg-danger'
                    : account.health === 'warning' ? 'bg-warning' : 'bg-success'
                  return (
                    <li key={account.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-white/[0.04]">
                      <PlatformIcon platform={account.platform} className="h-5 w-5 shrink-0 rounded-md [&_svg]:h-2.5 [&_svg]:w-2.5" />
                      <span className="min-w-0 flex-1 truncate text-xs text-ink" title={postHandle(account)}>
                        {postHandle(account)}
                      </span>
                      <span aria-hidden title={account.needsReconnect ? 'Reconnect needed' : account.isActive ? 'Online' : 'Inactive'}
                        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="mt-2 text-2xs text-ink-subtle">Nothing connected yet.</p>
            )}
            <Button size="sm" variant="secondary" className="mt-2.5 w-full" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => onNavigate('accounts')}>
              Connect more
            </Button>
          </Panel>
        </aside>

        <Panel padded={false} className="min-w-0 flex-1 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-3 py-2.5">
            <div className="flex items-center gap-0.5">
              <Button size="sm" variant="ghost" iconOnly aria-label="Previous" onClick={() => shiftRange(-1)} icon={<ChevronLeft className="h-4 w-4" />} />
              <Button size="sm" variant="ghost" iconOnly aria-label="Next" onClick={() => shiftRange(1)} icon={<ChevronRight className="h-4 w-4" />} />
            </div>
            <h2 className="min-w-0 truncate text-sm font-semibold text-ink">{rangeTitle}</h2>
            <span className="font-mono text-2xs tabular text-ink-subtle">{posts.length} post{posts.length === 1 ? '' : 's'}</span>
            <div className="ml-auto flex items-center gap-1">
              {loading && <RefreshCw aria-hidden className="h-3.5 w-3.5 animate-spin text-ink-faint" />}
              <div role="tablist" aria-label="Calendar mode" className="glass-tile flex items-center rounded-full p-0.5">
                {(['week', 'month'] as const).map((id) => (
                  <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => onModeChange(id)}
                    className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs capitalize transition-colors duration-150',
                      mode === id ? 'bg-white/[0.12] text-ink' : 'text-ink-muted hover:text-ink')}>
                    {id === 'week' ? <LayoutGrid className="h-3 w-3" /> : <CalendarDays className="h-3 w-3" />}
                    {id}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {mode === 'week' ? (
            <WeekGrid week={week} byDay={byDay} selectedId={selected?.id ?? null}
              onSelect={(post) => setSelected(selected?.id === post.id ? null : post)} scrollRef={scrollRef}
              onSchedule={onSchedule} dragPost={dragPost} dropKey={dropKey}
              onDragStart={setDragPost} onDropAt={(key, minutes) => { void dropPost(dragPost, key, minutes) }} setDropKey={setDropKey} />
          ) : (
            <MonthGrid month={month} byDay={byDay} selectedId={selected?.id ?? null}
              onSelect={(post) => setSelected(selected?.id === post.id ? null : post)} onSchedule={onSchedule}
              dragPost={dragPost} dropKey={dropKey} onDragStart={setDragPost}
              onDropAt={(key) => { void dropPost(dragPost, key, null) }} setDropKey={setDropKey} />
          )}
        </Panel>
      </div>

      {truncated && <p className="px-1 text-2xs text-ink-subtle">Showing the newest 1000 posts per source in this range.</p>}
      {selected && (
        <PostPreviewDialog post={selected}
          onClose={() => setSelected(null)}
          onEdit={() => { setEditingPost(selected); setSelected(null) }}
          onCanceled={() => { setSelected(null); void load() }} />
      )}
      {editingPost && (() => {
        const record = localPosts.find((p) => p.id === editingPost.id)
        return (
          <SchedulePostDialog slot={null}
            editing={{
              postId: editingPost.id,
              clipTitle: editingPost.title ?? record?.clipTitle ?? 'Untitled clip',
              clipPath: record?.clipPath ?? null,
              caption: editingPost.content ?? '',
              accountIds: editingPost.targets.map((target) => target.accountId).filter((id): id is string => id !== null),
            }}
            onClose={() => setEditingPost(null)}
            onConnect={() => { setEditingPost(null); onNavigate('accounts') }}
            onSaved={() => { setEditingPost(null); void load() }} />
        )
      })()}
    </div>
  )
}

function postHandle(account: ZernioAccount): string {
  return account.displayName ?? account.username ?? platformName(account.platform)
}

function WeekGrid({ week, byDay, selectedId, onSelect, scrollRef, onSchedule, dragPost, dropKey, onDragStart, onDropAt, setDropKey }: {
  week: ReturnType<typeof weekGrid>
  byDay: Map<string, CalendarPost[]>
  selectedId: string | null
  onSelect: (post: CalendarPost) => void
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSchedule: (slot: { key: string; hour: number }) => void
  dragPost: CalendarPost | null
  dropKey: string | null
  onDragStart: (post: CalendarPost | null) => void
  onDropAt: (dayKey: string, minutes: number | null) => void
  setDropKey: (key: string | null) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="flex border-b border-white/[0.06]">
        <span aria-hidden className="w-[52px] shrink-0" />
        {week.cells.map((cell, index) => (
          <span key={cell.key} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5">
            <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">{WEEKDAY_LABELS[index]}</span>
            <span className={cn('flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-mono text-2xs tabular',
              cell.isToday ? 'bg-accent text-ink-inverted' : 'text-ink')}>
              {cell.dayOfMonth}
            </span>
          </span>
        ))}
      </div>
      <div ref={scrollRef} className="max-h-[calc(100vh-320px)] overflow-y-auto">
        <div className="flex" style={{ height: 24 * HOUR_PX }}>
          <div aria-hidden className="relative w-[52px] shrink-0">
            {Array.from({ length: 24 }, (_, hour) => (
              <span key={hour} className="absolute right-2 -translate-y-1/2 font-mono text-[10px] tabular text-ink-faint"
                style={{ top: hour * HOUR_PX }}>
                {String(hour).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {week.cells.map((cell) => (
            <DayColumn key={cell.key} cell={cell} posts={byDay.get(cell.key) ?? []} dragPost={dragPost} dropKey={dropKey} onDragStart={onDragStart} onDropAt={onDropAt} setDropKey={setDropKey}
              selectedId={selectedId} onSelect={onSelect} onSchedule={onSchedule} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Only our own scheduled posts can move: published/failed/external are fixed. */
const movable = (post: CalendarPost): boolean => post.source === 'zernio' && post.status === 'scheduled'

function DayColumn({ cell, posts, selectedId, onSelect, onSchedule, dragPost, dropKey, onDragStart, onDropAt, setDropKey }: {
  cell: { key: string; isToday: boolean }
  posts: CalendarPost[]
  selectedId: string | null
  onSelect: (post: CalendarPost) => void
  onSchedule: (slot: { key: string; hour: number }) => void
  dragPost: CalendarPost | null
  dropKey: string | null
  onDragStart: (post: CalendarPost | null) => void
  onDropAt: (dayKey: string, minutes: number | null) => void
  setDropKey: (key: string | null) => void
}): React.JSX.Element {
  const { cards, more } = useMemo(() => layoutDayCards(
    posts.map((post) => ({ item: post, minutes: minutesOfDay(post.when) }))), [posts])
  const dropHere = dropKey === cell.key
  return (
    <div
      className={cn('relative min-w-0 flex-1 border-l border-white/[0.05]', cell.isToday && 'bg-white/[0.015]', dropHere && 'ring-1 ring-inset ring-accent/60 bg-accent/[0.04]')}
      onDragOver={(e) => { if (dragPost) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(cell.key) } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropKey(null) }}
      onDrop={(e) => {
        e.preventDefault()
        const top = e.currentTarget.getBoundingClientRect().top
        const minutes = Math.round(((e.clientY - top) / HOUR_PX) * 60)
        onDropAt(cell.key, Math.max(0, minutes))
      }}>
      {Array.from({ length: 24 }, (_, hour) => (
        <span key={hour} aria-hidden className="absolute inset-x-0 border-t border-white/[0.04]" style={{ top: hour * HOUR_PX }} />
      ))}
      {Array.from({ length: 24 }, (_, hour) => (
        <div key={hour} aria-hidden className="group absolute inset-x-0" style={{ top: hour * HOUR_PX, height: HOUR_PX }}>
          {!isPastSlot(cell.key, hour) && (
            <button type="button" onClick={() => onSchedule({ key: cell.key, hour })} tabIndex={-1}
              title={`Schedule a post on ${cell.key} at ${String(hour).padStart(2, '0')}:00`}
              className="absolute inset-x-1 top-1.5 hidden items-center justify-center rounded-lg border border-dashed border-white/[0.16] bg-[#141417] py-1 text-ink-muted group-hover:flex hover:border-white/0 hover:bg-[#1a1a1f] hover:text-ink">
              <Plus aria-hidden className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}
      {cards.map(({ item: post, minutes, lane }) => (
        <button key={post.id} type="button" draggable={movable(post)} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', post.id); onDragStart(post) }} onDragEnd={() => onDragStart(null)} onClick={() => onSelect(post)}
          aria-label={`${chipTime(post.when)} ${statusLabel(post.status)}: ${postTitle(post)}`}
          title={`${chipTime(post.when)} · ${statusLabel(post.status)} · ${postTitle(post)}`}
          className={cn('absolute overflow-hidden rounded-xl border border-white/[0.07] bg-[#141417] px-2 py-1.5 text-left',
            'shadow-[0_10px_24px_-12px_rgb(0_0_0/0.9)] transition-colors duration-100 hover:bg-[#1a1a1f]',
            selectedId === post.id && 'ring-1 ring-accent')}
          style={{
            top: Math.min(Math.max((minutes / 60) * HOUR_PX - 6, 0), 24 * HOUR_PX - 52),
            left: `calc(${lane * 14}% + 4px)`,
            width: `calc(${100 - lane * 18}% - 8px)`,
            height: 48,
            zIndex: 10 + lane,
          }}>
          <span className="flex items-center gap-1.5">
            <PlatformIcon platform={post.targets[0]?.platform ?? ''} className="h-3.5 w-3.5 shrink-0 rounded-full [&_svg]:h-2 [&_svg]:w-2" />
            <span className="font-mono text-2xs tabular text-ink-muted">{chipTime(post.when)}</span>
            <span className="ml-auto"><StatusMark status={post.status} /></span>
          </span>
          <span className="mt-0.5 block truncate text-xs leading-4 text-ink">{postTitle(post)}</span>
        </button>
      ))}
      {more.map((chip) => (
        <span key={`${chip.minutes}:${chip.count}`} aria-hidden
          className="absolute rounded-lg bg-[#141417] px-1.5 py-1 font-mono text-2xs tabular text-ink-muted shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]"
          style={{ top: (chip.minutes / 60) * HOUR_PX + 46, left: `calc(${chip.lane * 14}% + 4px)`, zIndex: 20 }}>
          +{chip.count}
        </span>
      ))}
    </div>
  )
}

function MonthGrid({ month, byDay, selectedId, onSelect, onSchedule, dragPost, dropKey, onDragStart, onDropAt, setDropKey }: {
  month: ReturnType<typeof monthGrid>
  byDay: Map<string, CalendarPost[]>
  selectedId: string | null
  onSelect: (post: CalendarPost) => void
  onSchedule: (slot: { key: string; hour: number }) => void
  dragPost: CalendarPost | null
  dropKey: string | null
  onDragStart: (post: CalendarPost | null) => void
  onDropAt: (dayKey: string, minutes: number | null) => void
  setDropKey: (key: string | null) => void
}): React.JSX.Element {
  return (
    <div>
      <div className="grid grid-cols-7 gap-2 px-3 pt-3" aria-hidden>
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="pb-1 text-center text-[13px] font-medium text-ink">{label}</span>
        ))}
      </div>
      <div role="grid" aria-label={`${monthTitle(month)} posts`} className="grid grid-cols-7 gap-2 p-3">
        {month.cells.map((cell) => {
          const dayPosts = byDay.get(cell.key) ?? []
          const shown = dayPosts.slice(0, 1)
          const hidden = dayPosts.length - shown.length
          const slotHour = openSlotHour(cell.key)
          return (
            <div key={cell.key} role="gridcell" aria-label={cell.key}
              className={cn('group relative min-h-[118px] rounded-2xl border border-white/[0.06] bg-white/[0.015] p-2', !cell.inMonth && 'opacity-40', dropKey === cell.key && 'ring-1 ring-accent/60 bg-accent/[0.04]')}
              onDragOver={(e) => { if (dragPost) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropKey(cell.key) } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropKey(null) }}
              onDrop={(e) => { e.preventDefault(); onDropAt(cell.key, null) }}>
              <span className={cn('block text-center font-mono text-xs tabular', cell.isToday ? 'font-semibold text-accent' : 'text-ink-muted')}>
                {cell.dayOfMonth}
              </span>
              {hidden > 0 && (
                <span aria-hidden className="absolute right-2 top-1.5 font-mono text-2xs tabular text-ink-muted">+{hidden}</span>
              )}
              <div className="mt-1.5 space-y-1.5">
                {shown.map((post) => (
                  <button key={post.id} type="button" draggable={movable(post)} onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', post.id); onDragStart(post) }} onDragEnd={() => onDragStart(null)} onClick={() => onSelect(post)}
                    aria-label={`${chipTime(post.when)} ${statusLabel(post.status)}: ${postTitle(post)}`}
                    title={`${chipTime(post.when)} · ${statusLabel(post.status)} · ${postTitle(post)}`}
                    className={cn('block w-full rounded-xl bg-[#141417] px-2 py-1.5 text-left shadow-[inset_0_0_0_1px_rgb(255_255_255/0.06)] transition-colors duration-100 hover:bg-[#1a1a1f]',
                      selectedId === post.id && 'ring-1 ring-accent')}>
                    <span className="flex items-center gap-1.5">
                      <PlatformIcon platform={post.targets[0]?.platform ?? ''} className="h-3.5 w-3.5 shrink-0 rounded-full [&_svg]:h-2 [&_svg]:w-2" />
                      <span className="min-w-0 flex-1 truncate font-mono text-2xs tabular text-ink-muted">{chipTime(post.when)}</span>
                      <StatusMark status={post.status} />
                    </span>
                    <span className="mt-0.5 block truncate text-xs font-medium text-ink">{postTitle(post)}</span>
                  </button>
                ))}
                {slotHour !== null && (
                  <button type="button" onClick={() => onSchedule({ key: cell.key, hour: slotHour })}
                    aria-label={`Schedule a post on ${cell.key}`}
                    title={`Schedule a post on ${cell.key} at ${String(slotHour).padStart(2, '0')}:00`}
                    className="hidden w-full items-center justify-center rounded-xl border border-dashed border-white/[0.16] bg-[#141417] py-1 text-ink-muted group-hover:flex hover:border-white/0 hover:bg-[#1a1a1f] hover:text-ink">
                    <Plus aria-hidden className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The calendar's "Post preview" dialog: what waits or went out, where, plus
 * the two actions the calendar can honestly offer — open the published post
 * on its platform, and cancel one that is still scheduled.
 */
function PostPreviewDialog({ post, onClose, onEdit, onCanceled }: {
  post: CalendarPost
  onClose: () => void
  onEdit: () => void
  onCanceled: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canCancel = post.source === 'zernio' && post.status === 'scheduled'
  const link = post.targets.find((target) => target.url) ?? null
  const when = new Date(post.when)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cancel = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await getApi().zernio.posts.cancel(post.id)
      onCanceled()
    } catch (err) {
      setError(errorMessage(err, 'Could not cancel the post.'))
      setBusy(false)
    }
  }

  return (
    <Dialog onBackdropMouseDown={onClose} panelClassName="mx-auto max-w-[700px]" aria-label="Post preview">
      <div className="px-6 pb-6 pt-5">
        {post.status === 'scheduled' && (
          <Callout tone="warning" icon={<Clock3 className="h-4 w-4 text-warning" strokeWidth={2} />}>
            If you&apos;re editing this video clip, the previously exported version will go live unless changes are saved and exported beforehand.
          </Callout>
        )}
        <div className="mt-4 flex items-center gap-2.5">
          <h2 className="text-base font-semibold text-ink">Post preview</h2>
          <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-2xs text-ink-muted', WELL)}>
            <StatusMark status={post.status} />{statusLabel(post.status)}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {canCancel ? (
              <Button size="sm" variant="ghost" iconOnly aria-label="Edit scheduled post" title="Edit"
                onClick={onEdit} icon={<Pencil className="h-4 w-4" />} />
            ) : link ? (
              <Button size="sm" variant="ghost" iconOnly aria-label={`Open on ${platformName(link.platform)}`}
                title={`Open on ${platformName(link.platform)}`}
                onClick={() => { void getApi().zernio.posts.openCalendarLink(link.platform, link.url!) }}
                icon={<Pencil className="h-4 w-4" />} />
            ) : null}
            {canCancel && (
              <Button size="sm" variant="ghost" iconOnly aria-label="Cancel post" title="Cancel post" disabled={busy}
                onClick={() => setConfirming(true)} icon={<Trash2 className="h-4 w-4 text-danger" />} />
            )}
            <Button size="sm" variant="ghost" iconOnly aria-label="Close" onClick={onClose} icon={<X className="h-4 w-4" />} />
          </div>
        </div>

        <div className="mt-4 border-t border-white/[0.07] pt-3">
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            {post.status === 'scheduled' ? 'Scheduled for:' : 'When:'}
            <span className="text-ink">{new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' }).format(when)}</span>
            <Clock3 aria-hidden className="h-3.5 w-3.5" />
            <span className="text-ink">{new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(when)}</span>
          </p>
        </div>

        <div className="mt-1 border-t border-white/[0.07] pt-3">
          <p className="truncate text-[15px] font-semibold text-ink" title={postTitle(post)}>{postTitle(post)}</p>
        </div>

        <div className="mt-1 border-t border-white/[0.07] pt-3">
          <p className="text-sm font-semibold text-ink">Published on</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {post.targets.map((target) => (
              <span key={`${target.platform}:${target.handle ?? ''}`} className="inline-flex h-8 items-center gap-2 rounded-full bg-white/[0.07] pl-1.5 pr-3 text-[13px] text-ink">
                <PlatformIcon platform={target.platform} className="h-5 w-5 rounded-full [&_svg]:h-2.5 [&_svg]:w-2.5" />
                <span className="max-w-[200px] truncate uppercase">{target.handle ?? platformName(target.platform)}</span>
              </span>
            ))}
          </div>
        </div>

        {confirming && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-white/[0.04] px-3 py-2">
            <p className="text-xs text-ink-muted">Cancel this post? Zernio won&apos;t publish it.</p>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep</Button>
              <Button size="sm" variant="danger" loading={busy} onClick={() => void cancel()}>Cancel post</Button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </div>
    </Dialog>
  )
}
