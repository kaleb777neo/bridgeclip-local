import { getClient } from './service'
import { ZernioApiError, type ZernioClient } from './client'
import {
  type AnalyticsDashboard,
  type AnalyticsDay,
  type AnalyticsTopPost,
  type AnalyticsTotals,
  type BestTimeResult,
  type BestTimeSlot,
  type DashboardResult
} from '../../shared/zernio-analytics'

type JsonRecord = Record<string, unknown>

/** Zernio caps the dashboard window at 366 days; the renderer picks 7/30/90. */
const MAX_WINDOW_DAYS = 366
const DAY_MS = 86_400_000

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

/** A provider number kept as a sane finite number; junk becomes 0. */
function num(value: unknown, absMax = 1_000_000_000_000): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, -absMax), absMax) : 0
}

function iso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function isoDay(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null
}

/** Zernio sells analytics as an add-on; a 402 or the addon 403 means "enable it in Zernio". */
function addonRequired(error: unknown): boolean {
  if (!(error instanceof ZernioApiError)) return false
  if (error.status === 402 || error.code === 'analytics_addon_required') return true
  // Both endpoints document 403 only as the add-on or key-permission gate.
  return error.status === 403 && /add-?on/i.test(error.message)
}

function readFailure(error: unknown, fallback: string): { error: string; addonRequired: boolean } {
  return { error: error instanceof Error ? error.message : fallback, addonRequired: addonRequired(error) }
}

function parseTotals(value: unknown): AnalyticsTotals {
  const record = asRecord(value)
  return {
    impressions: num(record.impressions),
    reach: num(record.reach),
    likes: num(record.likes),
    comments: num(record.comments),
    shares: num(record.shares),
    saves: num(record.saves),
    clicks: num(record.clicks),
    views: num(record.views),
    engagementRate: num(record.engagementRate, 1000)
  }
}

function parseDay(value: unknown): AnalyticsDay | null {
  const record = asRecord(value)
  const date = isoDay(record.date)
  if (!date) return null
  return {
    date,
    impressions: num(record.impressions),
    reach: num(record.reach),
    engagement: num(record.engagement),
    views: num(record.views),
    // A bad day can lose followers; the real number may be negative.
    followersGained: num(record.followersGained, 1_000_000_000)
  }
}

function parseTopPost(value: unknown): AnalyticsTopPost | null {
  const record = asRecord(value)
  const postId = typeof record.postId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(record.postId) ? record.postId : null
  const platform = typeof record.platform === 'string' && /^[a-z]{1,24}$/.test(record.platform) ? record.platform : null
  if (!postId || !platform) return null
  return { postId, platform, publishedAt: iso(record.publishedAt), metrics: parseTotals(record.metrics) }
}

function parseSlot(value: unknown): BestTimeSlot | null {
  const record = asRecord(value)
  if (!Number.isInteger(record.day_of_week) || (record.day_of_week as number) < 0 || (record.day_of_week as number) > 6) return null
  if (!Number.isInteger(record.hour) || (record.hour as number) < 0 || (record.hour as number) > 23) return null
  return {
    dayOfWeek: record.day_of_week as number,
    hour: record.hour as number,
    avgEngagement: num(record.avg_engagement, 100_000_000),
    postCount: num(record.post_count, 1_000_000)
  }
}

/**
 * The Analytics page's headline numbers: one dashboard call for a UTC day
 * window, with the previous window included for the deltas.
 */
export async function analyticsDashboard(from: unknown, to: unknown): Promise<DashboardResult> {
  const fromDate = isoDay(from)
  const toDate = isoDay(to)
  if (!fromDate || !toDate) throw new Error('Choose a valid date range for analytics.')
  if (Date.parse(toDate) < Date.parse(fromDate)) throw new Error('The analytics range ends before it starts.')
  if (Date.parse(toDate) - Date.parse(fromDate) >= MAX_WINDOW_DAYS * DAY_MS) throw new Error('The analytics range is too wide.')

  let client: ZernioClient
  try {
    client = getClient()
  } catch (error) {
    const failure = readFailure(error, 'Add your Zernio API key to see analytics.')
    return { dashboard: null, error: failure.error, addonRequired: failure.addonRequired }
  }

  try {
    const body = await client.getAnalyticsDashboard(fromDate, toDate)
    const followers = asRecord(body.followers)
    const previous = asRecord(body.previousTotals)
    const dashboard: AnalyticsDashboard = {
      from: fromDate,
      to: toDate,
      totals: parseTotals(body.totals),
      previous: Object.keys(previous).length > 0 ? parseTotals(previous) : null,
      followers: { current: num(followers.current, 1_000_000_000), gained: num(followers.gained, 1_000_000_000) },
      daily: (Array.isArray(body.daily) ? body.daily : [])
        .map(parseDay)
        .filter((day): day is AnalyticsDay => day !== null)
        .sort((a, b) => a.date.localeCompare(b.date)),
      topPosts: (Array.isArray(body.topPosts) ? body.topPosts : []).map(parseTopPost).filter((post): post is AnalyticsTopPost => post !== null),
      dataAsOf: iso(body.dataAsOf)
    }
    return { dashboard, error: null, addonRequired: false }
  } catch (error) {
    const failure = readFailure(error, 'Could not load your analytics.')
    return { dashboard: null, error: failure.error, addonRequired: failure.addonRequired }
  }
}

/** When the workspace's posts earn the most engagement, as a weekday × UTC-hour grid. */
export async function analyticsBestTime(): Promise<BestTimeResult> {
  let client: ZernioClient
  try {
    client = getClient()
  } catch (error) {
    const failure = readFailure(error, 'Add your Zernio API key to see analytics.')
    return { slots: [], error: failure.error, addonRequired: failure.addonRequired }
  }

  try {
    const body = await client.getBestTimeToPost()
    const slots = (Array.isArray(body.slots) ? body.slots : [])
      .map(parseSlot)
      .filter((slot): slot is BestTimeSlot => slot !== null)
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour)
    return { slots, error: null, addonRequired: false }
  } catch (error) {
    const failure = readFailure(error, 'Could not load best posting times.')
    return { slots: [], error: failure.error, addonRequired: failure.addonRequired }
  }
}
