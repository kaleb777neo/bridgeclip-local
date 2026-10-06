'use strict'
// Analytics reads for the Analytics page: dashboard and best-time against the
// local mock — validation, defensive parsing, add-on gating and keyless reads.
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMockZernio } = require('./support/mock-zernio.cjs')
const { loadMain, tempDir, fakeElectron } = require('./support/load-main.cjs')

const KEY = 'test-zernio-key'

const DASHBOARD = {
  dateRange: { fromDate: '2026-09-03', toDate: '2026-10-02' },
  totals: { impressions: 123400, reach: 98000, likes: 5400, comments: 320, shares: 890, saves: 1200, clicks: 450, views: 210000, engagementRate: 5.4 },
  previousTotals: { impressions: 100000, reach: 80000, likes: 4000, comments: 300, shares: 700, saves: 900, clicks: 400, views: 180000, engagementRate: 4.8 },
  followers: { current: 15230, gained: 640, byAccount: [{ accountId: 'acc1', platform: 'tiktok', current: 15230, gained: 640 }] },
  daily: [
    { date: '2026-10-01', impressions: 5000, reach: 4000, engagement: 300, views: 8000, followersGained: 40 },
    { date: '2026-10-02', impressions: 6000, reach: 4200, engagement: 350, views: 9000, followersGained: -12 }
  ],
  topPosts: [
    { postId: 'v1234567890abcdef', platform: 'tiktok', publishedAt: '2026-09-25T10:00:00Z', metrics: { impressions: 90000, reach: 70000, likes: 4000, comments: 200, shares: 600, saves: 800, clicks: 200, views: 150000, engagementRate: 6.1 } }
  ],
  dataAsOf: '2026-10-02T05:00:00Z'
}

const BEST_TIMES = {
  slots: [
    { day_of_week: 1, hour: 14, avg_engagement: 210.5, post_count: 12 },
    { day_of_week: 0, hour: 9, avg_engagement: 80, post_count: 4 },
    { day_of_week: 6, hour: 23, avg_engagement: 45, post_count: 2 }
  ]
}

/** Serves both analytics paths; each side can be overridden or turned into a failure. */
function analyticsRoutes({ dashboard = DASHBOARD, best = BEST_TIMES, dashboardStatus = 200, bestStatus = 200 } = {}) {
  const seen = { dashboard: [], best: [] }
  const routes = [
    {
      method: 'GET',
      path: '/api/v1/analytics/dashboard',
      handler: (ctx) => {
        seen.dashboard.push({ query: Object.fromEntries(ctx.query), authorized: ctx.req.headers.authorization === `Bearer ${KEY}` })
        ctx.json(dashboardStatus, dashboard)
      }
    },
    {
      method: 'GET',
      path: '/api/v1/analytics/best-time',
      handler: (ctx) => {
        seen.best.push({ query: Object.fromEntries(ctx.query), authorized: ctx.req.headers.authorization === `Bearer ${KEY}` })
        ctx.json(bestStatus, best)
      }
    }
  ]
  return { routes, seen }
}

async function withAnalytics(fn, routes = {}) {
  const { dir, cleanup } = tempDir()
  const previousUrl = process.env.BRIDGECLIP_ZERNIO_API_URL
  let mock = null
  try {
    mock = await createMockZernio({ apiKey: KEY, extraRoutes: routes.routes, rateLimit: routes.rateLimit })
    process.env.BRIDGECLIP_ZERNIO_API_URL = mock.apiUrl
    const { electron } = fakeElectron(dir)
    const main = loadMain(`
      export * as analytics from './src/main/zernio/analytics'
      export * as settings from './src/main/settings-store'
    `, { electron })
    if (routes.setKey !== false) main.settings.replaceApiKey('zernioApiKey', KEY)
    await fn({ mock, main, seen: routes.seen })
  } finally {
    if (previousUrl === undefined) delete process.env.BRIDGECLIP_ZERNIO_API_URL
    else process.env.BRIDGECLIP_ZERNIO_API_URL = previousUrl
    if (mock) await mock.close()
    cleanup()
  }
}

test('dashboard: the requested window, deltas and top posts arrive normalised', () => withAnalytics(async ({ main, seen }) => {
  const result = await main.analytics.analyticsDashboard('2026-09-03', '2026-10-02')
  assert.equal(result.error, null)
  assert.equal(result.addonRequired, false)
  const dash = result.dashboard
  assert.equal(dash.from, '2026-09-03')
  assert.equal(dash.to, '2026-10-02')
  assert.equal(dash.totals.impressions, 123400)
  assert.equal(dash.totals.engagementRate, 5.4)
  assert.equal(dash.previous.impressions, 100000)
  assert.deepEqual(dash.followers, { current: 15230, gained: 640 })
  assert.equal(dash.daily.length, 2)
  assert.equal(dash.daily[1].followersGained, -12, 'a losing day stays negative')
  assert.equal(dash.topPosts[0].postId, 'v1234567890abcdef')
  assert.equal(dash.topPosts[0].platform, 'tiktok')
  assert.equal(dash.dataAsOf, new Date('2026-10-02T05:00:00Z').toISOString())

  assert.equal(seen.dashboard.length, 1)
  assert.equal(seen.dashboard[0].authorized, true)
  assert.equal(seen.dashboard[0].query.fromDate, '2026-09-03')
  assert.equal(seen.dashboard[0].query.toDate, '2026-10-02')
  assert.equal(seen.dashboard[0].query.compare, 'previous_period')
  assert.equal(seen.dashboard[0].query.topPosts, '6')
  assert.equal(seen.dashboard[0].query.recentPosts, '0')
}, analyticsRoutes()))

test('dashboard: junk values become 0 and unusable rows are dropped', () => {
  const dirty = {
    totals: { impressions: '1234', reach: null, likes: 5, comments: 6, shares: 7, saves: 8, clicks: 9, views: 10, engagementRate: 200000 },
    daily: [{ date: 'not-a-day', impressions: 1 }, { date: '2026-10-01', impressions: 40 }],
    topPosts: [{ postId: 'has spaces', platform: 'tiktok' }, { postId: 'ok1', platform: 'TikTok!' }, { postId: 'ok2', platform: 'youtube', metrics: { views: 3 } }],
    followers: 'oops'
  }
  return withAnalytics(async ({ main }) => {
    const result = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
    const dash = result.dashboard
    assert.equal(dash.totals.impressions, 0, 'a string count is not a number')
    assert.equal(dash.totals.engagementRate, 1000, 'rates are clamped')
    assert.deepEqual(dash.daily.map((day) => day.date), ['2026-10-01'])
    assert.equal(dash.topPosts.length, 1)
    assert.equal(dash.topPosts[0].postId, 'ok2')
    assert.deepEqual(dash.followers, { current: 0, gained: 0 })
    assert.equal(dash.previous, null)
    assert.equal(dash.dataAsOf, null)
  }, analyticsRoutes({ dashboard: dirty }))
})

test('dashboard: the window itself is validated before any request', () => withAnalytics(async ({ main, seen }) => {
  await assert.rejects(() => main.analytics.analyticsDashboard('nope', '2026-10-02'), /valid date range/)
  await assert.rejects(() => main.analytics.analyticsDashboard('2026-10-02', '2026-09-03'), /ends before it starts/)
  await assert.rejects(() => main.analytics.analyticsDashboard('2025-01-01', '2026-10-02'), /too wide/)
  // 367 inclusive days: the 366th day difference is already past the window Zernio allows.
  await assert.rejects(() => main.analytics.analyticsDashboard('2025-10-01', '2026-10-02'), /too wide/)
  await assert.rejects(() => main.analytics.analyticsDashboard(42, null), /valid date range/)
  assert.equal(seen.dashboard.length, 0, 'nothing was asked of Zernio')
}, analyticsRoutes()))

test('dashboard: a missing API key reads as an error field, never a rejection', () => withAnalytics(async ({ main, mock }) => {
  const result = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.equal(result.dashboard, null)
  assert.match(result.error, /API key/i)
  assert.equal(result.addonRequired, false)
  assert.equal(mock.requestsTo('GET', '/api/v1/analytics').length, 0)
}, { ...analyticsRoutes(), setKey: false }))

test('dashboard: the analytics add-on 403 is reported as addonRequired', () => withAnalytics(async ({ main }) => {
  const result = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.equal(result.dashboard, null)
  assert.equal(result.addonRequired, true)
  assert.match(result.error, /add-?on/i)
}, analyticsRoutes({ dashboardStatus: 403, dashboard: { error: 'The Analytics add-on is not enabled for this workspace.', code: 'analytics_addon_required' } })))

test('dashboard: a 402 payment gate also reads as add-on billing', () => withAnalytics(async ({ main }) => {
  const result = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.equal(result.dashboard, null)
  assert.equal(result.addonRequired, true)
}, analyticsRoutes({ dashboardStatus: 402, dashboard: { error: 'Upgrade to use analytics.' } })))

test('best-time: slots keep day and hour bounds and sort Monday-first', () => withAnalytics(async ({ main, seen }) => {
  const result = await main.analytics.analyticsBestTime()
  assert.equal(result.error, null)
  assert.deepEqual(result.slots.map((s) => [s.dayOfWeek, s.hour]), [[0, 9], [1, 14], [6, 23]])
  assert.equal(result.slots[1].avgEngagement, 210.5)
  assert.equal(result.slots[1].postCount, 12)
  assert.equal(seen.best.length, 1)
  assert.equal(seen.best[0].authorized, true)
}, analyticsRoutes()))

test('best-time: junk slots are dropped, only Mon–Sun × 0–23 survive', () => withAnalytics(async ({ main }) => {
  const result = await main.analytics.analyticsBestTime()
  assert.deepEqual(result.slots, [{ dayOfWeek: 2, hour: 0, avgEngagement: 10, postCount: 1 }])
}, {
  routes: [{
    method: 'GET',
    path: '/api/v1/analytics/best-time',
    handler: (ctx) => ctx.json(200, { slots: [
      { day_of_week: 2, hour: 0, avg_engagement: 10, post_count: 1 },
      { day_of_week: 7, hour: 3, avg_engagement: 99, post_count: 5 },
      { day_of_week: 1, hour: 24, avg_engagement: 99, post_count: 5 },
      { day_of_week: '1', hour: 5, avg_engagement: 99, post_count: 5 },
      { hour: 5, avg_engagement: 99 }
    ] })
  }]
}))

test('best-time: a Zernio failure reads as an error field with empty slots', () => withAnalytics(async ({ main, seen }) => {
  const result = await main.analytics.analyticsBestTime()
  assert.deepEqual(result.slots, [])
  assert.equal(result.addonRequired, false)
  assert.match(result.error, /No history for this workspace/, "Zernio's own detail survives, so the route really answered")
  assert.equal(seen.best.length, 1)
}, analyticsRoutes({ bestStatus: 404, best: { error: 'No history for this workspace.' } })))

test('analytics reads honour the shared API rate-limit gate', () => withAnalytics(async ({ main, mock }) => {
  const first = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.equal(first.error, null)
  // Zernio's free window here holds one request; even its 200 answer arms the client-side cooldown.
  const blocked = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.equal(blocked.dashboard, null)
  assert.match(blocked.error, /request limit|rate limit/i)
  const third = await main.analytics.analyticsDashboard('2026-09-30', '2026-10-02')
  assert.match(third.error, /request limit|rate limit/i, 'the client answers from its own cooldown')
  assert.equal(mock.requestsTo('GET', '/api/v1/analytics/dashboard').length, 1, 'the cooldown answers never reached Zernio')
}, { ...analyticsRoutes(), rateLimit: 1 }))
