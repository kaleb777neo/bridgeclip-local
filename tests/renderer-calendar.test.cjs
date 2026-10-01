'use strict'
// Posts calendar grid math: Monday-start weeks, stable 6-week height, day
// keys, month navigation and the local-time day shift used for fetch windows.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: `export { addMonths, chipTime, dayKey, monthGrid, monthTitle, shiftDay, WEEKDAY_LABELS } from './src/renderer/lib/calendar';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

const mod = { exports: {} }
vm.runInNewContext(bundle, { module: mod, exports: mod.exports, require, Intl, Date })
const { addMonths, chipTime, dayKey, monthGrid, monthTitle, shiftDay, WEEKDAY_LABELS } = mod.exports

test('month grids start on Monday, keep six weeks and cover the whole month', () => {
  for (const [year, month] of [[2026, 9], [2026, 0], [2024, 1], [2025, 11]]) {
    const grid = monthGrid({ year, month })
    assert.equal(grid.cells.length, 42, `${year}-${month} has 42 cells`)
    // Monday-start: the first cell's weekday is Monday (index 0 in the grid).
    const first = grid.cells[0]
    const firstDate = new Date(first.key + 'T00:00:00')
    assert.equal((firstDate.getDay() + 6) % 7, 0, `${year}-${month} grid starts on Monday`)
    // The month's own first day appears, in position, and every month day exists.
    const monthKeys = grid.cells.filter((cell) => cell.inMonth).map((cell) => cell.key)
    assert.equal(monthKeys.length, new Date(year, month + 1, 0).getDate(), `${year}-${month} includes every month day`)
    // Contiguous day keys from first to last cell.
    for (let index = 1; index < grid.cells.length; index += 1) {
      assert.equal(grid.cells[index].key, shiftDay(grid.cells[index - 1].key, 1))
    }
    assert.equal(grid.from, grid.cells[0].key)
    assert.equal(grid.to, grid.cells[41].key)
  }
})

test('adjacent-month cells are flagged and weekend flags follow Mon-Fri layout', () => {
  // October 2026 starts on a Thursday: Sep 28 (Mon) opens the grid.
  const grid = monthGrid({ year: 2026, month: 9 })
  assert.equal(grid.cells[0].key, '2026-09-28')
  assert.equal(grid.cells[0].inMonth, false)
  assert.equal(grid.cells[3].key, '2026-10-01')
  assert.equal(grid.cells[3].inMonth, true)
  // Saturday and Sunday are the 6th and 7th columns.
  assert.equal(grid.cells[5].isWeekend, true)
  assert.equal(grid.cells[6].isWeekend, true)
  assert.equal(grid.cells[4].isWeekend, false)
})

test('today is marked once, by local day', () => {
  const now = new Date()
  const grid = monthGrid({ year: now.getFullYear(), month: now.getMonth() }, now)
  const marked = grid.cells.filter((cell) => cell.isToday)
  assert.equal(marked.length, 1)
  assert.equal(marked[0].key, dayKey(now))
})

test('month navigation rolls over year boundaries and formats titles', () => {
  // Objects cross the vm boundary; compare fields (deepEqual checks prototypes).
  const next = addMonths({ year: 2026, month: 11 }, 1)
  assert.equal(next.year, 2027)
  assert.equal(next.month, 0)
  const back = addMonths({ year: 2027, month: 0 }, -2)
  assert.equal(back.year, 2026)
  assert.equal(back.month, 10)
  assert.equal(monthTitle({ year: 2026, month: 9 }), 'October 2026')
  assert.equal(monthTitle({ year: 2026, month: 0 }), 'January 2026')
})

test('chip time and day shifts stay in local time', () => {
  // Local-time rendering, whatever the machine's zone: the key parts match.
  const iso = '2026-10-03T18:30:00'
  assert.equal(chipTime(iso), '18:30')
  assert.equal(chipTime('not a date'), '')
  assert.equal(shiftDay('2026-10-01', -1), '2026-09-30')
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01')
  assert.equal(WEEKDAY_LABELS[0], 'Mon')
  assert.equal(WEEKDAY_LABELS[6], 'Sun')
})
