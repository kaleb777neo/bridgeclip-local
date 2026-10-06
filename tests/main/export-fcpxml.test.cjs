'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

function load(entry) {
  const code = buildSync({ entryPoints: [path.resolve(__dirname, '../../', entry)], bundle: true,
    platform: 'node', format: 'cjs', packages: 'external', write: false }).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', code)(mod, mod.exports, require)
  return mod.exports
}

const { buildFcpxml, buildTimeline, cropTransform, frameDuration, rationalTime } = load('src/shared/fcpxml.ts')

/** Stack-based tag-balance check: catches the failure modes a string diff would miss. */
function assertWellFormed(xml) {
  const tagPattern = /<(\/?)([A-Za-z][\w.-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g
  const stack = []
  let match
  while ((match = tagPattern.exec(xml))) {
    const [, closing, name, , selfClosing] = match
    if (selfClosing) continue
    if (closing) {
      assert.equal(stack.pop(), name, `unexpected </${name}>`)
    } else {
      stack.push(name)
    }
  }
  assert.deepEqual(stack, [], 'unclosed tags')
}

const clip = (overrides) => ({
  name: 'Clip 1', srcUrl: 'file:///C:/library/run/clip_00.mp4', durationMs: 28500,
  width: 1080, height: 1920, fps: 30, hasAudio: true, ...overrides,
})

test('one sequence and asset per clip, with a single format per geometry', () => {
  const xml = buildFcpxml('My Podcast', [
    clip({}),
    clip({ name: 'Clip 2', srcUrl: 'file:///C:/library/run/clip_01.mp4', durationMs: 15000 }),
    clip({ name: 'Wide', srcUrl: 'file:///C:/library/run/clip_02.mp4', durationMs: 61000, width: 1920, height: 1080, fps: 29.97 }),
  ])
  assertWellFormed(xml)
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1\.8">/)
  assert.equal((xml.match(/<sequence /g) || []).length, 3)
  assert.equal((xml.match(/<asset /g) || []).length, 3)
  assert.equal((xml.match(/<format /g) || []).length, 2)
  assert.match(xml, /frameDuration="1\/30s"/)
  assert.match(xml, /frameDuration="1001\/30000s"/)
  assert.match(xml, /<asset-clip [^>]*ref="a1" offset="0\/1000s" start="0\/1000s" duration="15000\/1000s"/)
  assert.match(xml, /<event id="event-0" name="My Podcast">/)
})

test('names and paths are XML-escaped', () => {
  const xml = buildFcpxml('Tom & "Jerry" <live>', [
    clip({ name: 'A & B "quote" <tag>', srcUrl: 'file:///C:/x%20y/a%26b.mp4' }),
  ])
  assertWellFormed(xml)
  assert.match(xml, /name="A &amp; B &quot;quote&quot; &lt;tag&gt;"/)
  assert.match(xml, /name="Tom &amp; &quot;Jerry&quot; &lt;live&gt;"/)
})

test('audio-less clips drop the audio source attributes', () => {
  const xml = buildFcpxml('Silent', [clip({ hasAudio: false })])
  assertWellFormed(xml)
  assert.match(xml, /hasAudio="0"/)
  assert.doesNotMatch(xml, /audioSources/)
})

test('invalid inputs are rejected before any XML is produced', () => {
  assert.throws(() => buildFcpxml('Empty', []), /No clips to export/)
  assert.throws(() => buildFcpxml('Bad', [clip({ srcUrl: 'https://example.com/a.mp4' })]), /file URLs/)
  assert.throws(() => buildFcpxml('Bad', [clip({ durationMs: 0 })]), /positive/)
  assert.throws(() => buildFcpxml('Bad', [clip({ width: 0 })]), /dimensions/)
})

test('frame rates map to exact rational frame durations', () => {
  assert.equal(frameDuration(30), '1/30s')
  assert.equal(frameDuration(59.94), '1001/60000s')
  assert.equal(frameDuration(23.975), '1001/24000s')
  assert.equal(frameDuration(48), '21/1000s')
  assert.equal(frameDuration(0), '1/30s')
  assert.equal(rationalTime(28500), '28500/1000s')
  assert.equal(rationalTime(-5), '0/1000s')
})

const sourceAsset = { id: 'source', name: 'Show', srcUrl: 'file:///C:/library/run/editor-source.mp4', durationMs: 600000, width: 1080, height: 1920, fps: 30, hasAudio: true }

test('a source sequence cuts real pacing spans with cumulative timeline offsets', () => {
  const xml = buildTimeline('Show', [sourceAsset], [
    { name: 'Best moment', items: [
      { assetId: 'source', startMs: 61000, durationMs: 15000 },
      { assetId: 'source', startMs: 92000, durationMs: 8000 },
    ] },
  ])
  assertWellFormed(xml)
  assert.equal((xml.match(/<asset /g) || []).length, 1)
  assert.equal((xml.match(/<format /g) || []).length, 1)
  assert.match(xml, /<asset-clip [^>]*ref="source" offset="0\/1000s" start="61000\/1000s" duration="15000\/1000s"/)
  assert.match(xml, /<asset-clip [^>]*ref="source" offset="15000\/1000s" start="92000\/1000s" duration="8000\/1000s"/)
})

test('timeline validation rejects bad references, spans and mixed formats', () => {
  assert.throws(() => buildTimeline('X', [sourceAsset], [{ name: 'A', items: [] }]), /at least one item/)
  assert.throws(() => buildTimeline('X', [sourceAsset], [{ name: 'A', items: [{ assetId: 'nope', startMs: 0, durationMs: 1000 }] }]), /Unknown asset/)
  assert.throws(() => buildTimeline('X', [sourceAsset], [{ name: 'A', items: [{ assetId: 'source', startMs: 599000, durationMs: 3000 }] }]), /exceeds its asset/)
  assert.throws(() => buildTimeline('X', [sourceAsset, { ...sourceAsset, id: 'source' }], [{ name: 'A', items: [{ assetId: 'source', startMs: 0, durationMs: 1000 }] }]), /Duplicate asset id/)
  const wide = { ...sourceAsset, id: 'wide', width: 1920, height: 1080 }
  assert.throws(() => buildTimeline('X', [sourceAsset, wide], [
    { name: 'Mixed', items: [{ assetId: 'source', startMs: 0, durationMs: 1000 }, { assetId: 'wide', startMs: 0, durationMs: 1000 }] },
  ]), /Mixed formats/)
})

test('crop transform maps a normalized rect to crop-to-fill scale and offset', () => {
  const t1 = cropTransform([0, 0, 0.5, 1])
  assert.equal(t1.scaleX, 2)
  assert.equal(t1.offsetX, -0)
  const t2 = cropTransform([0.5, 0.25, 0.5, 0.75])
  assert.equal(Math.round(t2.scaleX * 100) / 100, 2)
  assert.equal(Math.round(t2.offsetX * 100) / 100, -1)
  assert.equal(Math.round(t2.offsetY * 100) / 100, Math.round(-(0.25 / 0.75) * 100) / 100)
})

test('a degenerate crop rect stays finite', () => {
  const t = cropTransform([0.2, 0, 0, 1])
  assert.ok(Number.isFinite(t.scaleX) && Number.isFinite(t.offsetX), 'no -Infinity attributes')
})

test('the timeline carries tracking transforms, b-roll lanes and caption titles', () => {
  const source = { id: 'source', name: 'Source', srcUrl: 'file:///run/editor-source.mp4', durationMs: 60_000, width: 1080, height: 1920, fps: 30, hasAudio: true }
  const broll = { id: 'broll-1', name: 'b-roll', srcUrl: 'file:///run/editor-asset-abc.mp4', durationMs: 5000, width: 1920, height: 1080, fps: 30, hasAudio: false }
  const xml = buildTimeline('X', [source, broll], [{
    name: 'Tracked',
    items: [
      { assetId: 'source', startMs: 0, durationMs: 2000, transform: cropTransform([0.25, 0, 0.5, 1]) },
      { assetId: 'source', startMs: 2000, durationMs: 2000 },
    ],
    overlays: [
      { kind: 'video', assetId: 'broll-1', offsetMs: 1000, startMs: 0, durationMs: 1500, lane: 1 },
      { kind: 'title', text: 'Hello <world> & friends', offsetMs: 0, durationMs: 1200, lane: 2 },
    ],
  }])
  assert.ok(xml.includes('<adjust-transform scale="2.000000 1.000000" offset="-0.500000 0.000000" anchor="0 0"/>'), 'tracking transform on the first piece')
  assert.ok(xml.includes('lane="1"'), 'b-roll rides lane 1')
  assert.ok(xml.includes('lane="2"'), 'captions ride lane 2')
  assert.ok(xml.includes('Hello &lt;world&gt; &amp; friends'), 'caption text is escaped')
  assert.ok(xml.includes('<title lane="2"'), 'caption title element')
  const spine = xml.slice(xml.indexOf('<spine>'), xml.indexOf('</spine>'))
  assert.ok(spine.includes('lane="1"') && spine.includes('<title lane="2"'), 'connected clips live inside the spine, not beside it')
  assert.doesNotThrow(() => assertWellFormed(xml))
})

test('overlay spans are validated like spine segments', () => {
  const source = { ...sourceAsset }
  const broll = { id: 'broll-1', name: 'b-roll', srcUrl: 'file:///run/editor-asset-abc.mp4', durationMs: 5000, width: 1920, height: 1080, fps: 30, hasAudio: false }
  const items = [{ assetId: 'source', startMs: 0, durationMs: 1000 }]
  assert.throws(() => buildTimeline('X', [source, broll], [
    { name: 'A', items, overlays: [{ kind: 'video', assetId: 'ghost', offsetMs: 0, startMs: 0, durationMs: 1000, lane: 1 }] },
  ]), /Unknown overlay asset/)
  assert.throws(() => buildTimeline('X', [source, broll], [
    { name: 'A', items, overlays: [{ kind: 'video', assetId: 'broll-1', offsetMs: 0, startMs: 4600, durationMs: 1500, lane: 1 }] },
  ]), /exceeds its asset/)
  assert.throws(() => buildTimeline('X', [source, broll], [
    { name: 'A', items, overlays: [{ kind: 'title', text: '   ', offsetMs: 0, durationMs: 1000, lane: 2 }] },
  ]), /need text/)
})
