'use strict'
// Analytics page math: UTC dashboard windows, previous-period deltas,
// number formats and the weekday × UTC-hour heatmap grid.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: `export { dashboardWindow, deltaPercent, formatCompact, formatNumber, formatRate, heatmapGrid, WEEKDAY_SHORT, windowLabel } from './src/renderer/lib/analytics';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

const mod = { exports: {} }
vm.runInNewContext(bundle, { module: mod, exports: mod.exports, require, Intl, Date })
const { dashboardWindow, deltaPercent, formatCompact, formatNumber, formatRate, heatmapGrid, WEEKDAY_SHORT, windowLabel } = mod.exports

const days = (period, now) => {
  const win = dashboardWindow(period, now)
  return `${win.from}..${win.to}`
}

test('dashboard windows are UTC days ending today, both ends included', () => {
  const now = new Date('2026-10-02T18:45:00Z')
  assert.equal(days('7', now), '2026-09-26..2026-10-02')
  assert.equal(days('30', now), '2026-09-03..2026-10-02')
  assert.equal(days('90', now), '2026-07-05..2026-10-02')
  // A window never collapses to nothing on the first day of a month or year.
  assert.equal(days('7', new Date('2026-01-03T02:00:00Z')), '2025-12-28..2026-01-03')
})

test('deltas compare against the previous window and refuse junk bases', () => {
  assert.equal(deltaPercent(112, 100), 12)
  assert.equal(deltaPercent(98000, 80000), 22.5)
  assert.equal(deltaPercent(90, 100), -10)
  assert.equal(deltaPercent(100, 0), null, 'nothing to compare against')
  assert.equal(deltaPercent(100, -5), null)
  assert.equal(deltaPercent(Number.NaN, 100), null)
  assert.equal(deltaPercent(100, Number.POSITIVE_INFINITY), null)
})

test('numbers read grouped, compact or as a rate', () => {
  assert.equal(formatNumber(123400), '123,400')
  assert.equal(formatNumber(-12), '-12')
  assert.equal(formatNumber(5.6), '6', 'counts round')
  assert.equal(formatCompact(1234), '1.2K')
  assert.equal(formatCompact(999), '999')
  assert.equal(formatRate(5.44), '5.4%')
  assert.equal(formatRate(0), '0%')
})

test('window labels and weekday names match the calendar’s en-US style', () => {
  assert.equal(windowLabel('2026-09-03', '2026-10-02'), 'Sep 3 – Oct 2')
  assert.equal(windowLabel('2026-01-01', '2026-01-01'), 'Jan 1 – Jan 1')
  assert.equal(WEEKDAY_SHORT.join(' '), 'Mon Tue Wed Thu Fri Sat Sun')
})

test('the heatmap grid is Mon–Sun × 24 UTC hours, negatives kept out', () => {
  const grid = heatmapGrid([
    { dayOfWeek: 1, hour: 14, avgEngagement: 210.5, postCount: 12 },
    { dayOfWeek: 0, hour: 9, avgEngagement: 80, postCount: 4 },
    { dayOfWeek: 6, hour: 23, avgEngagement: 45, postCount: 2 },
    { dayOfWeek: 6, hour: 23, avgEngagement: 5, postCount: 1 },
    { dayOfWeek: 2, hour: 3, avgEngagement: -50, postCount: 3 }
  ])
  assert.equal(grid.engagement.length, 7)
  assert.equal(grid.engagement[0].length, 24)
  assert.equal(grid.engagement[1][14], 210.5)
  assert.equal(grid.postCount[1][14], 12)
  assert.equal(grid.engagement[6][23], 50, 'duplicate slots add up')
  assert.equal(grid.postCount[6][23], 3)
  assert.equal(grid.engagement[2][3], 0, 'a negative average paints nothing')
  assert.equal(grid.postCount[2][3], 3)
  assert.equal(grid.engagement.flat().reduce((sum, value) => sum + value, 0), 340.5)
})
