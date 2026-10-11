'use strict'
// Editor caption text: hyphen-split clitics rejoin, caption edits retime,
// suppression and cuts filter, groups follow the engine's rules, and the
// on-screen group honors silence linger.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const path = require('node:path')
const { buildSync } = require('esbuild')

const bundle = buildSync({
  stdin: {
    contents: `export { mergeHyphenSplits, effectiveCaptionWords, captionGroups, activeCaptionAt } from './src/renderer/lib/caption-text';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

const mod = { exports: {} }
vm.runInNewContext(bundle, { module: mod, exports: mod.exports, require, Intl, Date })
const { mergeHyphenSplits, effectiveCaptionWords, captionGroups, activeCaptionAt } = mod.exports

// Results cross the vm realm boundary; plain() rebuilds them in this realm so
// strict deep equality compares structure, not prototypes.
const plain = (x) => JSON.parse(JSON.stringify(x))
const word = (text, start, end) => ({ text, start_ms: start, end_ms: end })

test('split clitics rejoin into one word, mirroring the engine', () => {
  const merged = mergeHyphenSplits([word('eu', 0, 300), word('m', 300, 420), word('-aș', 420, 700)])
  assert.deepEqual(plain(merged.map((w) => w.text)), ['eu', 'm-aș'])
  assert.deepEqual(plain([merged[1].start_ms, merged[1].end_ms]), [300, 700])
  // Across a pause they never rejoin.
  const apart = mergeHyphenSplits([word('vorbeam', 0, 400), word('-abia', 2000, 2400)])
  assert.deepEqual(plain(apart.map((w) => w.text)), ['vorbeam', '-abia'])
})

const project = (transcript) => ({
  version: 1, revision: 1, title: 't', duration_ms: 30000, width: 1920, height: 1080,
  aspect_ratio: '9:16', candidates: [], transcript
})

const candidate = (patch = {}) => ({
  id: 'c1', title: 'T', ranges: [[0, 6000]], scenes: [{ at_ms: 0, layout: 'fill', crops: [[0, 0, 1, 1]] }],
  captions: true, caption_preset: 'pop', caption_style: undefined, video_speed: 1, status: 'refining',
  caption_edits: [], caption_suppression_ranges: [], ...patch
})

test('effective words apply edits with engine retiming, cuts and suppression', () => {
  const p = project([
    { start_ms: 0, end_ms: 2000, text: 'm-aș gândit așa', words: [word('m', 100, 300), word('-aș', 300, 500), word('gândit', 600, 900), word('așa', 1000, 1300)] },
    { start_ms: 2400, end_ms: 4000, text: 'old words here', words: [word('old', 2500, 2800), word('words', 2800, 3100), word('here', 3100, 3400)] }
  ])
  // Plain: clitics rejoin, everything inside the cut flows through.
  assert.deepEqual(plain(effectiveCaptionWords(p, candidate()).map((w) => w.text)), ['m-aș', 'gândit', 'așa', 'old', 'words', 'here'])
  // Same-count edit keeps the original word timings.
  const edited = effectiveCaptionWords(p, candidate({ caption_edits: [{ segment: 1, text: 'new words now' }] }))
  assert.deepEqual(plain(edited.slice(3).map((w) => w.text)), ['new', 'words', 'now'])
  assert.deepEqual(plain(edited.slice(3).map((w) => w.start_ms)), [2500, 2800, 3100])
  // Different-count edit spreads over the line's spoken interval.
  const spread = effectiveCaptionWords(p, candidate({ caption_edits: [{ segment: 1, text: 'two words' }] }))
  assert.deepEqual(plain(spread.slice(3).map((w) => w.text)), ['two', 'words'])
  assert.equal(spread[3].start_ms, 2500)
  assert.equal(spread[4].end_ms, 3400)
  // Suppression and cuts drop words entirely.
  assert.deepEqual(
    plain(effectiveCaptionWords(p, candidate({ caption_suppression_ranges: [[900, 3200]] })).map((w) => w.text)),
    ['m-aș', 'gândit']
  )
  assert.deepEqual(plain(effectiveCaptionWords(p, candidate({ ranges: [[0, 1000]] })).map((w) => w.text)), ['m-aș', 'gândit'])
})

test('groups follow the engine rules: word limit, sentence ends, commas', () => {
  const groups = captionGroups([
    word('unu', 0, 200), word('doi.', 200, 400), word('trei', 500, 700), word('patru', 700, 900), word('cinci,', 900, 1100), word('șase', 1100, 1300)
  ], 3)
  assert.deepEqual(plain(groups.map((g) => g.words.map((w) => w.text))), [['unu', 'doi.'], ['trei', 'patru', 'cinci,'], ['șase']])
  assert.equal(groups[0].end_ms, 400)
})

test('the on-screen group lingers through silence until the next begins', () => {
  const groups = captionGroups([word('primul', 0, 400), word('grup.', 400, 600), word('alt', 1500, 1800), word('grup.', 1800, 2000)], 3)
  const mid = activeCaptionAt(groups, 900)
  assert.ok(mid)
  assert.deepEqual(plain(mid.states), ['past', 'past'])
  const speaking = activeCaptionAt(groups, 1600)
  assert.deepEqual(plain(speaking.group.words.map((w) => w.text)), ['alt', 'grup.'])
  assert.deepEqual(plain(speaking.states), ['active', 'future'])
  // Past the last group's linger, nothing shows.
  assert.equal(activeCaptionAt(groups, 2000 + 701), null)
  // Between words the next word is already the active one.
  const gap = activeCaptionAt(groups, 1550)
  assert.deepEqual(plain(gap.states), ['active', 'future'])
})
