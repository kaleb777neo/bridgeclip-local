// Pure calendar-grid math for the Posts calendar: month grids, day keys and
// month navigation. No React or IPC here, so tests cover every branch.

/** Weeks start on Monday, like most European calendars. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export interface CalendarCell {
  /** Local day key, YYYY-MM-DD. */
  key: string
  dayOfMonth: number
  inMonth: boolean
  isToday: boolean
  isWeekend: boolean
}

export interface MonthGrid {
  year: number
  /** 0-based month. */
  month: number
  /** Always six 7-day weeks, so the grid height never jumps between months. */
  cells: CalendarCell[]
  /** First and last cell keys: the date window a fetch must cover. */
  from: string
  to: string
}

export function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function addMonths({ year, month }: { year: number; month: number }, delta: number): { year: number; month: number } {
  const zeroBased = year * 12 + month + delta
  return { year: Math.floor(zeroBased / 12), month: ((zeroBased % 12) + 12) % 12 }
}

export function monthTitle({ year, month }: { year: number; month: number }, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month, 15)))
}

/** Six Monday-start weeks covering the month; includes adjacent-month days. */
export function monthGrid(view: { year: number; month: number }, today = new Date()): MonthGrid {
  const first = new Date(view.year, view.month, 1)
  // Monday=0 … Sunday=6 in the grid; JS dates use Sunday=0.
  const offset = (first.getDay() + 6) % 7
  const start = new Date(view.year, view.month, 1 - offset)
  const todayKey = dayKey(today)
  const cells: CalendarCell[] = []
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    const key = dayKey(date)
    cells.push({
      key,
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === view.month,
      isToday: key === todayKey,
      isWeekend: index % 7 >= 5
    })
  }
  return { year: view.year, month: view.month, cells, from: cells[0].key, to: cells[cells.length - 1].key }
}

/** Local HH:MM for a timestamp, as shown on calendar chips. */
export function chipTime(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Day key ± N days, staying in local time (never UTC-parsed). */
export function shiftDay(key: string, delta: number): string {
  const [year, month, day] = key.split('-').map(Number)
  return dayKey(new Date(year, month - 1, day + delta))
}

export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
}

function parseKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export interface WeekGrid {
  /** Monday through Sunday, as six CalendarCells. */
  cells: CalendarCell[]
  from: string
  to: string
  /** "28 Sept – 4 Oct, 2026" or "30 Sept – 4 Oct, 2026" style. */
  title: string
}

function shortMonth(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(date.getFullYear(), date.getMonth(), 15)))
}

/** Monday-start seven-day grid containing the anchor's local day. */
export function weekGrid(anchor: Date, today = new Date(), locale = 'en-US'): WeekGrid {
  const start = addDays(anchor, -((anchor.getDay() + 6) % 7))
  const todayKey = dayKey(today)
  const cells: CalendarCell[] = []
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(start, index)
    const key = dayKey(date)
    cells.push({
      key,
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === anchor.getMonth(),
      isToday: key === todayKey,
      isWeekend: index >= 5
    })
  }
  const first = parseKey(cells[0].key)
  const last = parseKey(cells[6].key)
  const year = last.getFullYear()
  const title = first.getMonth() === last.getMonth() && first.getFullYear() === year
    ? `${first.getDate()} – ${last.getDate()} ${shortMonth(last, locale)}, ${year}`
    : first.getFullYear() === year
      ? `${first.getDate()} ${shortMonth(first, locale)} – ${last.getDate()} ${shortMonth(last, locale)}, ${year}`
      : `${first.getDate()} ${shortMonth(first, locale)} ${first.getFullYear()} – ${last.getDate()} ${shortMonth(last, locale)}, ${year}`
  return { cells, from: cells[0].key, to: cells[6].key, title }
}

/** Local minutes since midnight for an ISO timestamp; 0 when unparseable. */
export function minutesOfDay(iso: string): number {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return 0
  return date.getHours() * 60 + date.getMinutes()
}

/** "GMT+3 · Bucharest" from the machine's own zone. */
export function timezoneLabel(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const hours = Math.floor(abs / 60)
  const minutes = abs % 60
  const gmt = `GMT${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const city = zone ? zone.split('/').pop()!.replace(/[_-]+/g, ' ') : ''
  return city ? `${gmt} · ${city}` : gmt
}

export interface DayCard<T> {
  item: T
  minutes: number
  /** 0-based column inside its overlap cluster. */
  lane: number
}

export interface MoreChip {
  minutes: number
  lane: number
  count: number
}

/**
 * Place timed cards into side-by-side lanes. Cards closer together than
 * `overlapMinutes` share a cluster (their boxes would collide), the first
 * `maxLanes` of each cluster stay visible and the rest collapse into one
 * "+N" chip beside them.
 */
export function layoutDayCards<T>(
  items: { item: T; minutes: number }[], overlapMinutes = 30, maxLanes = 3,
): { cards: DayCard<T>[]; more: MoreChip[] } {
  const sorted = [...items].sort((a, b) => a.minutes - b.minutes)
  const cards: DayCard<T>[] = []
  const more: MoreChip[] = []
  let cluster: { item: T; minutes: number }[] = []
  const flush = (): void => {
    cluster.forEach((entry, index) => {
      if (index < maxLanes) cards.push({ ...entry, lane: index })
    })
    if (cluster.length > maxLanes) {
      more.push({ minutes: cluster[0].minutes, lane: maxLanes, count: cluster.length - maxLanes })
    }
    cluster = []
  }
  for (const entry of sorted) {
    if (cluster.length && entry.minutes - cluster[cluster.length - 1].minutes >= overlapMinutes) flush()
    cluster.push(entry)
  }
  flush()
  return { cards, more }
}
