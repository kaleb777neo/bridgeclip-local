import type { BestTimeSlot } from '../../shared/zernio-analytics'

export type AnalyticsPeriod = '7' | '30' | '90'

const DAY_MS = 86_400_000

/** The UTC day window Zernio's dashboard reports for a quick period. */
export function dashboardWindow(period: AnalyticsPeriod, now: Date = new Date()): { from: string; to: string } {
  const days = Number(period)
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - (days - 1) * DAY_MS).toISOString().slice(0, 10)
  return { from, to }
}

/** Percent change against the previous window; null when there's nothing to compare. */
export function deltaPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null
  return Math.round(((current - previous) / previous) * 1000) / 10
}

const GROUPED = new Intl.NumberFormat('en-US')
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

export function formatNumber(value: number): string {
  return GROUPED.format(Math.round(value))
}

export function formatCompact(value: number): string {
  return COMPACT.format(value)
}

export function formatRate(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

/** "Oct 2 – Oct 30", for the window chip beside the page title. */
export function windowLabel(from: string, to: string): string {
  const format = (day: string): string => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`))
  return `${format(from)} – ${format(to)}`
}

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export interface HeatmapGrid {
  /** rows[day][hour] of average engagement, Mon–Sun × 0–23 UTC. */
  engagement: number[][]
  /** rows[day][hour] of posts behind each average. */
  postCount: number[][]
}

export function heatmapGrid(slots: BestTimeSlot[]): HeatmapGrid {
  const engagement = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  const postCount = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  for (const slot of slots) {
    if (slot.dayOfWeek < 0 || slot.dayOfWeek > 6 || slot.hour < 0 || slot.hour > 23) continue
    engagement[slot.dayOfWeek][slot.hour] += Math.max(0, slot.avgEngagement)
    postCount[slot.dayOfWeek][slot.hour] += Math.max(0, slot.postCount)
  }
  return { engagement, postCount }
}
