'use strict'
// Element-track geometry: sliding and edge-trimming overlay blocks on the
// expandable timeline lanes (b-roll, text, effects).
const assert = require('node:assert/strict')
const { test } = require('node:test')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: `export { moveOverlayRange, resizeOverlayRange, insertSection } from './src/shared/clip-editor';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

const { moveOverlayRange, resizeOverlayRange, insertSection } = (() => {
  const module = { exports: {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, require })
  return module.exports
})()

test('sliding an element block keeps its length inside the source', () => {
  assert.equal(JSON.stringify(moveOverlayRange(1000, 3000, 500, 12000)), JSON.stringify([1500, 3500]))
  assert.equal(JSON.stringify(moveOverlayRange(1000, 3000, -500, 12000)), JSON.stringify([500, 2500]))
  // The block never leaves the source: it stops at both edges.
  assert.equal(JSON.stringify(moveOverlayRange(1000, 3000, -5000, 12000)), JSON.stringify([0, 2000]))
  assert.equal(JSON.stringify(moveOverlayRange(9000, 11000, 5000, 12000)), JSON.stringify([10000, 12000]))
  // Values are rounded to whole milliseconds.
  assert.equal(JSON.stringify(moveOverlayRange(1000, 3000, 33.4, 12000)), JSON.stringify([1033, 3033]))
})

test('edge trims pin the opposite edge and keep a minimum length', () => {
  assert.equal(JSON.stringify(resizeOverlayRange(1000, 3000, 'l', 500, 12000)), JSON.stringify([500, 3000]))
  assert.equal(JSON.stringify(resizeOverlayRange(1000, 3000, 'r', 4000, 12000)), JSON.stringify([1000, 4000]))
  // The left edge cannot cross the right one (100 ms minimum).
  assert.equal(JSON.stringify(resizeOverlayRange(1000, 3000, 'l', 2950, 12000)), JSON.stringify([2900, 3000]))
  assert.equal(JSON.stringify(resizeOverlayRange(1000, 3000, 'r', 1050, 12000)), JSON.stringify([1000, 1100]))
  // The right edge cannot pass the source end.
  assert.equal(JSON.stringify(resizeOverlayRange(1000, 3000, 'r', 99999, 12000)), JSON.stringify([1000, 12000]))
})

test('add a section inserts sorted and refuses overlaps or overflow', () => {
  const base = [[0, 2000], [6000, 8000]]
  // Sorted insertion between cuts.
  assert.equal(JSON.stringify(insertSection(base, 3000, 4500)), JSON.stringify([[0, 2000], [3000, 4500], [6000, 8000]]))
  // Adjacent to an existing cut is allowed (the engine accepts touching cuts).
  assert.equal(JSON.stringify(insertSection(base, 2000, 3500)), JSON.stringify([[0, 2000], [2000, 3500], [6000, 8000]]))
  // Overlap with any cut rejects.
  assert.equal(insertSection(base, 7000, 9000), null)
  assert.equal(insertSection(base, 1000, 6500), null)
  // Too short rejects.
  assert.equal(insertSection(base, 3000, 3050), null)
  // The 24-cut ceiling rejects.
  const full = Array.from({ length: 24 }, (_, i) => [i * 400, i * 400 + 100])
  assert.equal(insertSection(full, 20000, 21000), null)
})
