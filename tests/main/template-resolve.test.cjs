'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const temp = tempDir('bridgeclip-resolve-')
const { electron } = fakeElectron(temp.dir)
const store = loadMain("export * from './src/main/templates-store'", { electron })
const resolve = loadMain("export * from './src/main/template-resolve'", { electron })

process.on('exit', () => fs.rmSync(temp.dir, { recursive: true, force: true }))

const userData = path.join(temp.dir, 'userData')

/** What the Create wizard sends: selecting a pack already wrote its preset and
 *  formats into the draft, so every field here is an explicit user choice. */
const base = (patch = {}) => ({
  videoUrl: 'https://example.com/video', maxClips: 3, autoClipCount: false, durationRanges: null,
  aspectRatio: '16:9', layoutStyle: 'auto', layoutVision: false, pacing: 'tight', videoSpeed: 1,
  includeCaptions: true, captionPreset: 'pop', includeTitle: true,
  startTimeSeconds: null, endTimeSeconds: null, bannerPlatform: null, bannerChannelUrl: null, ...patch
})

/** Formats and preset unset — a queue path where only the pack can supply them. */
const bare = (patch = {}) => {
  const { aspectRatio, aspectRatios, captionPreset, ...rest } = base(patch)
  return rest
}

test('the pack fills formats and preset only when the request leaves them unset', () => {
  store.saveTemplate({ id: 'studio-pack', name: 'Studio pack', captionPresetId: 'boxed', formats: ['9:16', '1:1'],
    badge: { kind: 'subscribe', position: 'top-right' }, safeZones: { 'top-right': .1 } })
  const filled = resolve.applyTemplateSnapshot({ ...bare(), templateId: 'studio-pack' })
  assert.equal(filled.aspectRatio, '9:16')
  assert.deepEqual(filled.aspectRatios, ['9:16', '1:1'])
  assert.equal(filled.captionPreset, 'boxed')
  assert.equal(filled.templateId, 'studio-pack')
  assert.deepEqual(filled.ctaBadges, [{ kind: 'subscribe', position: 'top-right', margin: .1 }])
  assert.equal(filled.logo, undefined)
})

test('manual wizard edits win: an explicit format list or preset is never overwritten', () => {
  const edited = resolve.applyTemplateSnapshot({
    ...base({ aspectRatio: '1:1', aspectRatios: ['1:1', '9:16'], captionPreset: 'neon' }),
    templateId: 'studio-pack'
  })
  assert.equal(edited.aspectRatio, '1:1')
  assert.deepEqual(edited.aspectRatios, ['1:1', '9:16'])
  assert.equal(edited.captionPreset, 'neon')
  assert.equal(edited.templateId, 'studio-pack')
  // Overlays the request cannot carry still materialize next to the edited fields.
  assert.deepEqual(edited.ctaBadges, [{ kind: 'subscribe', position: 'top-right', margin: .1 }])
  // An explicit primary with no list stays a single-format job; the pack adds nothing.
  const single = resolve.applyTemplateSnapshot({ ...base(), templateId: 'studio-pack' })
  assert.equal(single.aspectRatio, '16:9')
  assert.equal(single.aspectRatios, undefined)
  // A list without a primary resolves the primary from the request's own list.
  const listed = resolve.materializeTemplate(store.getTemplate('studio-pack'), { ...base({ aspectRatio: undefined, aspectRatios: ['1:1', '16:9'], templateId: 'studio-pack' }) })
  assert.equal(listed.aspectRatio, '1:1')
  assert.deepEqual(listed.aspectRatios, ['1:1', '16:9'])
})

test('a stored logo asset materializes with its safe-zone inset', () => {
  const pick = path.join(temp.dir, 'logo.png')
  fs.writeFileSync(pick, 'png-bytes')
  store.saveTemplate({ id: 'studio-logo', name: 'Studio logo', captionPresetId: 'pop', formats: ['9:16'],
    logo: { position: 'bottom-right', scale: .2, opacity: .8 }, safeZones: { 'bottom-right': .18 } }, pick)
  const out = resolve.applyTemplateSnapshot({ ...base(), templateId: 'studio-logo' })
  assert.deepEqual(out.logo, { path: path.join(userData, 'templates', 'studio-logo', 'logo.png'),
    position: 'bottom-right', scale: .2, opacity: .8, margin: .18 })
})

test('a logo config without a stored asset draws nothing, and center keeps the engine margin', () => {
  store.saveTemplate({ id: 'no-asset', name: 'No asset', captionPresetId: 'pop', formats: ['9:16'],
    logo: { position: 'center', scale: .1, opacity: .5 }, safeZones: { center: .2, 'top-left': .3 } })
  const out = resolve.applyTemplateSnapshot({ ...base(), templateId: 'no-asset' })
  assert.equal(out.logo, undefined)
  store.saveTemplate({ id: 'cta-center', name: 'CTA center', captionPresetId: 'pop', formats: ['9:16'],
    badge: { kind: 'follow', position: 'center' }, safeZones: { center: .2 } })
  assert.deepEqual(resolve.applyTemplateSnapshot({ ...base(), templateId: 'cta-center' }).ctaBadges,
    [{ kind: 'follow', position: 'center' }])
})

test('allowedFraming keeps a compatible choice and replaces an incompatible one', () => {
  store.saveTemplate({ id: 'fit-only', name: 'Fit only', captionPresetId: 'pop', formats: ['9:16'], allowedFraming: ['fit', 'fill'] })
  assert.equal(resolve.applyTemplateSnapshot({ ...base(), templateId: 'fit-only' }).layoutStyle, 'fit')
  assert.equal(resolve.applyTemplateSnapshot({ ...base({ layoutStyle: 'fill' }), templateId: 'fit-only' }).layoutStyle, 'fill')
})

test('per-channel render fields fill only what the request leaves unset', () => {
  store.saveTemplate({ id: 'channel-pack', name: 'Channel pack', captionPresetId: 'pop', formats: ['9:16'],
    banner: { platform: 'youtube', channelUrl: 'https://youtube.com/@studio' },
    includeTitle: false, pacing: 'natural', layoutStyle: 'fill' })
  // A queue path that omits the fields entirely: the pack supplies all four.
  const { bannerPlatform, bannerChannelUrl, includeTitle, pacing, layoutStyle, ...unset } = bare()
  const filled = resolve.applyTemplateSnapshot({ ...unset, templateId: 'channel-pack' })
  assert.equal(filled.bannerPlatform, 'youtube')
  assert.equal(filled.bannerChannelUrl, 'https://youtube.com/@studio')
  assert.equal(filled.includeTitle, false)
  assert.equal(filled.pacing, 'natural')
  assert.equal(filled.layoutStyle, 'fill')
  // Explicit user values win — including a falsy includeTitle and another channel's banner.
  const kept = resolve.applyTemplateSnapshot({
    ...base({ includeTitle: true, pacing: 'tight', layoutStyle: 'auto', bannerPlatform: 'tiktok', bannerChannelUrl: 'https://www.tiktok.com/@me' }),
    templateId: 'channel-pack'
  })
  assert.equal(kept.includeTitle, true)
  assert.equal(kept.pacing, 'tight')
  assert.equal(kept.layoutStyle, 'auto')
  assert.equal(kept.bannerPlatform, 'tiktok')
  assert.equal(kept.bannerChannelUrl, 'https://www.tiktok.com/@me')
  // The wizard always sends the banner pair and has no banner editor: its nulls count as unset,
  // while includeTitle/pacing are real wizard choices and stay untouched.
  const fromWizard = resolve.applyTemplateSnapshot({ ...base(), templateId: 'channel-pack' })
  assert.equal(fromWizard.bannerPlatform, 'youtube')
  assert.equal(fromWizard.bannerChannelUrl, 'https://youtube.com/@studio')
  assert.equal(fromWizard.includeTitle, true)
  assert.equal(fromWizard.pacing, 'tight')
})

test('a pack layoutStyle obeys its own allowedFraming, which still corrects the request', () => {
  store.saveTemplate({ id: 'framed-pack', name: 'Framed', captionPresetId: 'pop', formats: ['9:16'], layoutStyle: 'auto', allowedFraming: ['fit', 'fill'] })
  // Unset framing: the pack's own layoutStyle is corrected to the first allowed style.
  const { layoutStyle, ...unset } = bare()
  assert.equal(resolve.applyTemplateSnapshot({ ...unset, templateId: 'framed-pack' }).layoutStyle, 'fit')
  assert.equal(resolve.applyTemplateSnapshot({ ...base({ layoutStyle: 'auto' }), templateId: 'framed-pack' }).layoutStyle, 'fit')
  assert.equal(resolve.applyTemplateSnapshot({ ...base({ layoutStyle: 'fill' }), templateId: 'framed-pack' }).layoutStyle, 'fill')
})

test('packs without per-channel fields leave those request values alone', () => {
  const clean = resolve.applyTemplateSnapshot({ ...base(), templateId: 'clean' })
  assert.equal(clean.bannerPlatform, null)
  assert.equal(clean.bannerChannelUrl, null)
  // Clean now prefers natural pacing, but the wizard carries an explicit choice, so it stays.
  assert.equal(clean.pacing, 'tight')
  assert.equal(clean.includeTitle, true)
})

test('built-in packs resolve without any stored file', () => {
  const clean = resolve.applyTemplateSnapshot({ ...bare(), templateId: 'clean' })
  assert.equal(clean.aspectRatio, '9:16')
  assert.deepEqual(clean.aspectRatios, ['9:16'])
  assert.equal(clean.captionPreset, 'pop')
  assert.equal(clean.logo, undefined)
  assert.equal(clean.ctaBadges, undefined)
  // Boxed brand ships logo settings but no asset in userData: captions change, nothing is drawn.
  const boxed = resolve.applyTemplateSnapshot({ ...bare(), templateId: 'boxed-brand' })
  assert.equal(boxed.captionPreset, 'boxed')
  assert.deepEqual(boxed.aspectRatios, ['9:16', '1:1'])
  assert.equal(boxed.logo, undefined)
  assert.equal(boxed.ctaBadges, undefined)
})

test('the pack intro/outro materialize only with a stored file, and manual videos win', () => {
  const intro = path.join(temp.dir, 'brand-intro.mp4')
  const outro = path.join(temp.dir, 'brand-outro.webm')
  fs.writeFileSync(intro, 'intro-bytes')
  fs.writeFileSync(outro, 'outro-bytes')
  store.saveTemplate({ id: 'studio-intro', name: 'Studio intro', captionPresetId: 'pop', formats: ['9:16'],
    intro: 'brand-intro.mp4', outro: 'brand-outro.webm' }, null, intro, outro)
  const filled = resolve.applyTemplateSnapshot({ ...base(), templateId: 'studio-intro' })
  assert.deepEqual(filled.intro, { path: path.join(userData, 'templates', 'studio-intro', 'intro.mp4') })
  assert.deepEqual(filled.outro, { path: path.join(userData, 'templates', 'studio-intro', 'outro.webm') })
  // A name without a stored file materializes nothing.
  store.saveTemplate({ id: 'intro-ghost', name: 'Intro ghost', captionPresetId: 'pop', formats: ['9:16'], intro: 'ghost.mp4' })
  assert.equal(resolve.applyTemplateSnapshot({ ...base(), templateId: 'intro-ghost' }).intro, undefined)
  // The request cannot carry intro/outro today, but an explicit value still wins.
  const manual = resolve.materializeTemplate(store.getTemplate('studio-intro'), { ...base({ intro: { path: 'MINE' } }), templateId: 'studio-intro' })
  assert.deepEqual(manual.intro, { path: 'MINE' })
})

test('snapshot semantics: later template edits never change a resolved request', () => {
  const resolved = resolve.applyTemplateSnapshot({ ...bare(), templateId: 'studio-pack' })
  store.saveTemplate({ id: 'studio-pack', name: 'Studio pack', captionPresetId: 'neon', formats: ['1:1'] })
  assert.deepEqual(resolved.aspectRatios, ['9:16', '1:1'])
  assert.equal(resolved.captionPreset, 'boxed')
  assert.deepEqual(resolved.ctaBadges, [{ kind: 'subscribe', position: 'top-right', margin: .1 }])
  // A fresh unset request resolves the edited pack instead.
  assert.equal(resolve.applyTemplateSnapshot({ ...bare(), templateId: 'studio-pack' }).captionPreset, 'neon')
  // And a request with explicit choices keeps them against the edited pack too.
  assert.equal(resolve.applyTemplateSnapshot({ ...base(), templateId: 'studio-pack' }).captionPreset, 'pop')
})

test('unknown templates, presets and format conflicts fail closed', () => {
  // No templateId: the request passes through untouched, snapshot included.
  const plain = base()
  assert.equal(resolve.applyTemplateSnapshot(plain), plain)
  assert.throws(() => resolve.applyTemplateSnapshot({ ...base(), templateId: 'gone' }), /Brand template not found/)
  assert.throws(() => resolve.materializeTemplate({ id: 'x', name: 'x', captionPresetId: 'ghost', formats: ['9:16'] }, base()),
    /Unknown caption preset/)
  store.saveTemplate({ id: 'square-pack', name: 'Square', captionPresetId: 'pop', formats: ['1:1'] })
  // Nothing picked in the wizard: the pack's 1:1 primary lands on the review job — allowed now.
  assert.equal(resolve.applyTemplateSnapshot({ ...bare({ workflow: 'review' }), templateId: 'square-pack' }).aspectRatio, '1:1')
  // An explicit 16:9 review choice stays — manual edits win, and it is renderable.
  assert.equal(resolve.applyTemplateSnapshot({ ...base({ workflow: 'review' }), templateId: 'square-pack' }).aspectRatio, '16:9')
})
