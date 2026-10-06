// Analytics come from the user's Zernio workspace (GET /v1/analytics/*).
// Zernio collects the numbers from the platforms; BridgeClip only reads and
// shows them, and these reads never reject for Zernio problems — the result
// carries an error field instead, like the calendar does.

/** One dashboard totals set; every field is a count except engagementRate (%). */
export interface AnalyticsTotals {
  impressions: number
  reach: number
  likes: number
  comments: number
  shares: number
  saves: number
  clicks: number
  views: number
  engagementRate: number
}

export interface AnalyticsFollowers {
  current: number
  /** New followers in the window; negative when the account lost some. */
  gained: number
}

/** One UTC day of the dashboard's daily series. */
export interface AnalyticsDay {
  /** YYYY-MM-DD */
  date: string
  impressions: number
  reach: number
  engagement: number
  views: number
  followersGained: number
}

export interface AnalyticsTopPost {
  postId: string
  platform: string
  publishedAt: string | null
  metrics: AnalyticsTotals
}

export interface AnalyticsDashboard {
  from: string
  to: string
  totals: AnalyticsTotals
  /** The same length window right before `from`, when Zernio sent it. */
  previous: AnalyticsTotals | null
  followers: AnalyticsFollowers
  /** One entry per day that has data, oldest first. */
  daily: AnalyticsDay[]
  /** Zernio's best posts in the window, best first. */
  topPosts: AnalyticsTopPost[]
  /** When Zernio last synced these numbers, or null when it doesn't say. */
  dataAsOf: string | null
}

export interface DashboardResult {
  /** null when Zernio couldn't supply the numbers; `error` explains. */
  dashboard: AnalyticsDashboard | null
  error: string | null
  /** Zernio answered that this workspace has no Analytics access yet. */
  addonRequired: boolean
}

/** Zernio's average engagement of posts published in that weekday/hour slot. */
export interface BestTimeSlot {
  /** 0 = Monday … 6 = Sunday, Zernio's own numbering. */
  dayOfWeek: number
  /** 0–23, UTC. */
  hour: number
  avgEngagement: number
  postCount: number
}

export interface BestTimeResult {
  slots: BestTimeSlot[]
  error: string | null
  addonRequired: boolean
}
