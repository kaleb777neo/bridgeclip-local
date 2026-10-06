import { useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { cn, formatRelativeDate } from '../lib/utils'
import { getApi } from '../lib/ipc'
import { useSettingsStore } from '../store/use-settings-store'
import { PlatformIcon, platformName } from '../components/PlatformIcon'
import { Page as PageColumn } from '../components/ui/Page'
import { PageHeader } from '../components/ui/PageHeader'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { Button } from '../components/ui/Button'
import { Callout } from '../components/ui/Callout'
import { EmptyState } from '../components/ui/EmptyState'
import { Segmented } from '../components/ui/Segmented'
import { WELL } from '../components/ui/Field'
import type { BestTimeResult, DashboardResult } from '../../shared/zernio-analytics'
import type { Page } from '../components/Sidebar'
import {
  dashboardWindow,
  deltaPercent,
  formatCompact,
  formatNumber,
  formatRate,
  heatmapGrid,
  WEEKDAY_SHORT,
  windowLabel,
  type AnalyticsPeriod
} from '../lib/analytics'

const TITLE = 'Analytics'

const PERIOD_OPTIONS: { value: AnalyticsPeriod; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' }
]

export function AnalyticsPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const configured = useSettingsStore((s) => s.zernioConfigured)
  return (
    <PageColumn width="default">
      {configured ? (
        <AnalyticsView onNavigate={onNavigate} />
      ) : (
        <>
          <PageHeader title={TITLE} />
          <EmptyState
            className="mt-4"
            icon={<BarChart3 />}
            title="Connect your social accounts"
            description="Analytics come from your Zernio workspace. Set up your accounts to see how the posts are doing."
            action={<Button variant="primary" onClick={() => onNavigate('accounts')}>Open Accounts</Button>}
          />
        </>
      )}
    </PageColumn>
  )
}

interface AnalyticsState {
  period: AnalyticsPeriod
  loading: boolean
  dashboard: DashboardResult | null
  best: BestTimeResult | null
}

/** Headline tiles, a daily chart, the best-times heatmap and top posts — all read-only. */
function AnalyticsView({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [state, setState] = useState<AnalyticsState>({ period: '30', loading: true, dashboard: null, best: null })
  const [reload, setReload] = useState(0)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  useEffect(() => {
    let active = true
    setBannerDismissed(false)
    setState((current) => ({ ...current, loading: true }))
    const { from, to } = dashboardWindow(state.period)
    const api = getApi()
    // Each panel degrades on its own; one broken read must not hide the other's data.
    const dashboard = api.zernio.analytics.dashboard(from, to)
      .catch((): DashboardResult => ({ dashboard: null, error: 'Could not load your analytics.', addonRequired: false }))
    const best = api.zernio.analytics.bestTime()
      .catch((): BestTimeResult => ({ slots: [], error: 'Could not load best posting times.', addonRequired: false }))
    void Promise.all([dashboard, best]).then(([dashboardResult, bestResult]) => {
      if (active) setState({ period: state.period, loading: false, dashboard: dashboardResult, best: bestResult })
    })
    return () => { active = false }
  }, [state.period, reload])

  const result = state.dashboard
  const dash = result?.dashboard ?? null
  const win = dash ?? dashboardWindow(state.period)
  const windowText = windowLabel(win.from, win.to)

  const heat = useMemo(() => (state.best ? heatmapGrid(state.best.slots) : null), [state.best])
  const peak = heat ? Math.max(...heat.engagement.flat(), 0) : 0

  const setPeriod = (period: AnalyticsPeriod): void => setState((current) => ({ ...current, period }))

  return (
    <>
      <PageHeader
        className="items-center"
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            {TITLE}
            <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-2xs text-ink-muted', WELL)}>
              {windowText}
            </span>
          </span>
        }
        actions={
          <div className="flex items-center gap-1.5">
            <Segmented
              label="Analytics period"
              size="sm"
              value={state.period}
              options={PERIOD_OPTIONS}
              onChange={setPeriod}
            />
            <Button
              variant="ghost"
              iconOnly
              aria-label="Refresh analytics"
              title="Refresh"
              disabled={state.loading}
              onClick={() => setReload((n) => n + 1)}
              icon={<RefreshCw className={cn('h-3.5 w-3.5', state.loading && 'animate-spin')} />}
            />
          </div>
        }
      />

      <div className="mt-4 space-y-3">
        {result?.addonRequired ? (
          <EmptyState
            icon={<BarChart3 />}
            title="Analytics isn’t enabled on Zernio"
            description={result.error ?? 'Your Zernio workspace needs the Analytics add-on before these numbers are available.'}
            action={<Button variant="primary" onClick={() => onNavigate('settings')}>Open Settings</Button>}
          />
        ) : dash === null && state.loading ? (
          <Panel padded={false}>
            <p role="status" className="px-4 py-3 text-xs text-ink-muted">Loading your analytics…</p>
          </Panel>
        ) : dash === null ? (
          <>
            {result?.error && !bannerDismissed && (
              <Callout tone="danger" onDismiss={() => setBannerDismissed(true)}>
                {result.error}
              </Callout>
            )}
            <Panel padded={false} className="flex items-center justify-between gap-3 py-2 pl-4 pr-2.5">
              <p className="text-xs text-ink-muted">Your analytics are unavailable right now.</p>
              <Button size="sm" onClick={() => setReload((n) => n + 1)} disabled={state.loading}>Try again</Button>
            </Panel>
          </>
        ) : (
          <>
            <StatTiles dash={dash} />
            <Panel padded={false} className="overflow-hidden">
              <PanelHeader className="px-4 pt-4" title="Daily performance"
                description={dash.dataAsOf ? `Zernio last synced the numbers ${formatRelativeDate(dash.dataAsOf)}.` : 'Impressions per UTC day.'} />
              {dash.daily.length === 0 ? (
                <p className="px-4 pb-4 pt-2 text-xs text-ink-muted">No posts with data in this window yet.</p>
              ) : (
                <DailyChart daily={dash.daily} />
              )}
            </Panel>
            <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
              <Panel padded={false} className="overflow-hidden">
                <PanelHeader className="px-4 pt-4" title="Top posts" description="Zernio’s best-performing posts in the window." />
                {dash.topPosts.length === 0 ? (
                  <p className="px-4 pb-4 pt-2 text-xs text-ink-muted">Nothing to rank yet — {state.period === '7' ? 'try a longer window' : 'schedule a post from the calendar'}.</p>
                ) : (
                  <TopPosts posts={dash.topPosts} />
                )}
              </Panel>
              <Panel padded={false} className="overflow-hidden">
                <PanelHeader className="px-4 pt-4" title="Best times to post" description="Average engagement per weekday and hour, in UTC, over your workspace’s history." />
                {heat && peak > 0 ? (
                  <BestTimeHeatmap heat={heat} peak={peak} />
                ) : (
                  <p className="px-4 pb-4 pt-2 text-xs text-ink-muted">
                    {state.best?.error ? `Best times are unavailable: ${state.best.error}` : 'Not enough published posts yet to tell when your audience is active.'}
                  </p>
                )}
              </Panel>
            </div>
            <p className="px-1 text-2xs text-ink-subtle">Analytics follow your Zernio workspace, not just posts made from BridgeClip.</p>
          </>
        )}
      </div>
    </>
  )
}

function StatTiles({ dash }: { dash: NonNullable<DashboardResult['dashboard']> }): React.JSX.Element {
  const { totals, previous, followers } = dash
  // Zernio reports the window's gained figure; the start-of-window count is the delta base.
  const startFollowers = followers.current - followers.gained
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
      <Stat label="Impressions" value={formatNumber(totals.impressions)} delta={previous ? deltaPercent(totals.impressions, previous.impressions) : null} />
      <Stat label="Reach" value={formatNumber(totals.reach)} delta={previous ? deltaPercent(totals.reach, previous.reach) : null} />
      <Stat label="Views" value={formatNumber(totals.views)} delta={previous ? deltaPercent(totals.views, previous.views) : null} />
      <Stat label="Engagement rate" value={formatRate(totals.engagementRate)} hint={previous ? `was ${formatRate(previous.engagementRate)}` : undefined} />
      <Stat label="Followers gained" value={formatNumber(followers.gained)} hint={`now ${formatNumber(followers.current)} total`} delta={startFollowers > 0 ? deltaPercent(followers.current, startFollowers) : null} />
    </div>
  )
}

function Stat({ label, value, hint, delta }: {
  label: string
  value: string
  hint?: string
  delta?: number | null
}): React.JSX.Element {
  return (
    <div className="glass-tile rounded-2xl p-3.5">
      <p className="eyebrow text-2xs text-ink-subtle">{label}</p>
      <p className="mt-1.5 font-mono text-xl tabular text-ink">{value}</p>
      <div className="mt-1 flex min-h-4 items-center gap-1.5">
        {delta !== null && delta !== undefined && (delta === 0 ? (
          <span className="font-mono text-2xs tabular text-ink-subtle">no change</span>
        ) : (
          <span className={cn('inline-flex items-center gap-0.5 font-mono text-2xs tabular', delta > 0 ? 'text-success' : 'text-danger')}>
            {delta > 0 ? <TrendingUp aria-hidden className="h-3 w-3" /> : <TrendingDown aria-hidden className="h-3 w-3" />}
            {formatRate(Math.abs(delta))}
          </span>
        ))}
        {hint && <span className="truncate text-2xs text-ink-faint">{hint}</span>}
      </div>
    </div>
  )
}

function DailyChart({ daily }: { daily: NonNullable<DashboardResult['dashboard']>['daily'] }): React.JSX.Element {
  const max = Math.max(...daily.map((day) => day.impressions), 1)
  return (
    <div className="px-4 pb-4 pt-3">
      <div role="img" aria-label="Impressions per day" className="flex h-28 items-end gap-[3px]">
        {daily.map((day) => (
          <div
            key={day.date}
            title={`${day.date}: ${formatNumber(day.impressions)} impressions · ${formatNumber(day.views)} views · ${formatNumber(day.engagement)} engagement`}
            className={cn('min-w-[3px] flex-1 rounded-t-sm bg-accent/70 transition-colors hover:bg-accent', day.impressions === 0 && 'bg-white/[0.06] hover:bg-white/[0.1]')}
            style={{ height: `${Math.max((day.impressions / max) * 100, day.impressions > 0 ? 3 : 1.5)}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-2xs tabular text-ink-faint">
        <span>{daily[0]?.date.slice(5)}</span>
        <span>{daily[Math.floor(daily.length / 2)]?.date.slice(5)}</span>
        <span>{daily[daily.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  )
}

function TopPosts({ posts }: { posts: NonNullable<DashboardResult['dashboard']>['topPosts'] }): React.JSX.Element {
  return (
    <ul className="mt-2 divide-y divide-white/[0.05] pb-1">
      {posts.map((post) => (
        <li key={post.postId} className="flex items-center gap-3 px-4 py-2.5">
          <PlatformIcon platform={post.platform} className="h-8 w-8 rounded-lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-ink">{platformName(post.platform)}</p>
            <p className="mt-0.5 text-2xs text-ink-subtle">{post.publishedAt ? `Published ${formatRelativeDate(post.publishedAt)}` : 'Published date unknown'}</p>
          </div>
          <dl className="flex shrink-0 items-center gap-3 font-mono text-2xs tabular text-ink-muted">
            <div className="text-right"><dt className="text-ink-faint">Impr.</dt><dd>{formatCompact(post.metrics.impressions)}</dd></div>
            <div className="text-right"><dt className="text-ink-faint">Views</dt><dd>{formatCompact(post.metrics.views)}</dd></div>
            <div className="text-right"><dt className="text-ink-faint">Eng.</dt><dd>{formatRate(post.metrics.engagementRate)}</dd></div>
          </dl>
        </li>
      ))}
    </ul>
  )
}

function BestTimeHeatmap({ heat, peak }: {
  heat: ReturnType<typeof heatmapGrid>
  peak: number
}): React.JSX.Element {
  let busiest = { day: 0, hour: 0, value: -1 }
  heat.engagement.forEach((row, day) => row.forEach((value, hour) => {
    if (value > busiest.value) busiest = { day, hour, value }
  }))
  const slotText = `${WEEKDAY_SHORT[busiest.day]} ${String(busiest.hour).padStart(2, '0')}:00 UTC`
  return (
    <div className="px-4 pb-4 pt-3">
      <div
        role="img"
        aria-label={`Average engagement by weekday and UTC hour. Busiest slot: ${slotText} with ${formatNumber(busiest.value)} average engagement.`}
        className="grid gap-[3px]"
        style={{ gridTemplateColumns: '28px repeat(24, minmax(0, 1fr))' }}
      >
        <span aria-hidden />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} aria-hidden className={cn('text-center font-mono text-[9px] leading-none tabular text-ink-faint', hour % 6 !== 0 && 'invisible')}>
            {String(hour).padStart(2, '0')}
          </span>
        ))}
        {heat.engagement.map((row, day) => (
          <FragmentRow key={day} day={day} row={row} counts={heat.postCount[day]} peak={peak} />
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-2xs text-ink-faint">
        <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: 'rgb(var(--accent) / 0.15)' }} />
        quieter
        <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: 'rgb(var(--accent) / 0.9)' }} />
        busier
      </p>
    </div>
  )
}

function FragmentRow({ day, row, counts, peak }: {
  day: number
  row: number[]
  counts: number[]
  peak: number
}): React.JSX.Element {
  return (
    <>
      <span aria-hidden className="self-center font-mono text-[9px] leading-none text-ink-faint">{WEEKDAY_SHORT[day]}</span>
      {row.map((value, hour) => (
        <span
          key={hour}
          title={value === 0
            ? `${WEEKDAY_SHORT[day]} ${String(hour).padStart(2, '0')}:00 UTC · no posts in this slot`
            : `${WEEKDAY_SHORT[day]} ${String(hour).padStart(2, '0')}:00 UTC · avg ${formatNumber(value)} engagement over ${formatNumber(counts[hour] ?? 0)} posts`}
          className="h-4 rounded-[3px]"
          style={{ backgroundColor: value > 0 ? `rgb(var(--accent) / ${0.15 + 0.75 * (value / peak)})` : 'rgb(255 255 255 / 0.05)' }}
        />
      ))}
    </>
  )
}
