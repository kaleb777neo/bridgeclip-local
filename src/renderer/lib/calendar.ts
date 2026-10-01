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
