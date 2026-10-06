'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const source = "export * from './src/main/templates-store'"

function loadStore(dir) {
  const { electron } = fakeElectron(dir)
  return loadMain(source, { electron })
}

function workspace(t) {
  const temp = tempDir('bridgeclip-templates-')
  t.after(temp.cleanup)
  const userData = path.join(temp.dir, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  return { dir: temp.dir, store: loadStore(temp.dir), userData }
}

const pack = (patch = {}) => ({
  id: 'studio-pack', name: 'Studio pack', captionPresetId: 'boxed', formats: ['9:16', '1:1'],
  logo: { position: 'bottom-right', scale: .12, opacity: .9 },
  badge: { kind: 'subscribe', position: 'top-right' },
  ...patch
})

test('built-in packs ship first, are read-only, and validate against the engine presets', (t) => {
  const { store } = workspace(t)
  const list = store.listTemplates()
  assert.deepEqual(list.map((tpl) => tpl.id).slice(0, 3), ['clean', 'boxed-brand', 'platform-cta'])
  assert.equal(list.filter((tpl) => tpl.builtIn).length, 3)
  const clean = store.getTemplate('clean')
  assert.equal(clean.logo, undefined)
  assert.equal(clean.badge, undefined)
  const boxed = store.getTemplate('boxed-brand')
  assert.deepEqual(boxed.logo, { position: 'bottom-right', scale: .15, opacity: .9 })
  assert.equal(boxed.captionPresetId, 'boxed')
  const cta = store.getTemplate('platform-cta')
  assert.deepEqual(cta.badge, { kind: 'subscribe', position: 'top-right' })
  assert.deepEqual(cta.formats, ['9:16'])
  for (const id of ['clean', 'boxed-brand', 'platform-cta']) {
    assert.throws(() => store.deleteTemplate(id), /cannot be deleted/i)
    assert.throws(() => store.saveTemplate(pack({ id })), /cannot be edited/i)
  }
})

test('save, update and delete a pack; the store file stays versioned and atomic', (t) => {
  const { store, userData } = workspace(t)
  const file = path.join(userData, 'templates.json')
  const saved = store.saveTemplate(pack({ hintForUi: 'dropped', builtInField: false }))
  assert.equal(saved.version, 1)
  assert.equal(saved.hintForUi, undefined)
  const persisted = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.equal(persisted.version, store.TEMPLATE_STORE_VERSION)
  assert.deepEqual(Object.keys(persisted.templates[0]).sort(), ['badge', 'captionPresetId', 'formats', 'id', 'logo', 'name', 'version'])
  assert.deepEqual(fs.readdirSync(userData).filter((name) => name.endsWith('.tmp')), [])
  assert.deepEqual(store.loadTemplates().map((tpl) => tpl.id), ['studio-pack'])
  assert.ok(store.listTemplates().some((tpl) => tpl.id === 'studio-pack'))
  // Update replaces in place; unknown fields never persist.
  store.saveTemplate(pack({ name: 'Studio pack v2', stray: 1 }))
  assert.equal(store.loadTemplates().length, 1)
  assert.equal(store.getTemplate('studio-pack').name, 'Studio pack v2')
  assert.equal(store.deleteTemplate('studio-pack'), true)
  assert.equal(store.deleteTemplate('studio-pack'), false)
  assert.equal(store.getTemplate('studio-pack'), null)
  // Only what parseBrandTemplate accepts reaches the file.
  assert.throws(() => store.saveTemplate(pack({ captionPresetId: 'not-a-preset' })), /Invalid brand template/)
  assert.throws(() => store.saveTemplate(pack({ formats: ['9:16', '9:16'] })), /Invalid brand template/)
  assert.throws(() => store.saveTemplate(pack({ id: 'Bad Id' })), /Invalid brand template/)
  assert.throws(() => store.saveTemplate(null), /Invalid brand template/)
})

test('normalizeTemplates skips bad entries, shadows and duplicates, and drops unknown fields', (t) => {
  const { store } = workspace(t)
  const out = store.normalizeTemplates([
    pack(),
    { id: 'bad-preset', name: 'Bad', captionPresetId: 'ghost', formats: ['9:16'] },
    { id: 'no-formats', name: 'None', captionPresetId: 'pop', formats: [] },
    { id: 'UPPER', name: 'Bad id', captionPresetId: 'pop', formats: ['9:16'] },
    { id: 'pretends-built-in', name: 'X', captionPresetId: 'pop', formats: ['9:16'], builtIn: true },
    { id: 'clean', name: 'Shadow', captionPresetId: 'pop', formats: ['9:16'] },
    { ...pack({ id: 'second', extra: { deep: [1] } }) },
    pack(),
    { ...pack({ id: 'second', name: 'Later dupe' }) },
    'not-an-object',
    null
  ])
  assert.deepEqual(out.map((tpl) => tpl.id), ['studio-pack', 'second'])
  assert.equal(out[1].extra, undefined)
  assert.deepEqual(store.normalizeTemplates('nope'), [])
  assert.deepEqual(store.normalizeTemplates({ templates: [] }), [])
})

test('per-channel render fields round-trip and malformed ones never survive a parse', (t) => {
  const { store } = workspace(t)
  const full = pack({ banner: { platform: 'youtube', channelUrl: 'https://youtube.com/@studio' }, includeTitle: false, pacing: 'natural', layoutStyle: 'fill' })
  const saved = store.saveTemplate(full)
  assert.deepEqual(saved.banner, { platform: 'youtube', channelUrl: 'https://youtube.com/@studio' })
  assert.equal(saved.includeTitle, false)
  assert.equal(saved.pacing, 'natural')
  assert.equal(saved.layoutStyle, 'fill')
  const round = store.getTemplate('studio-pack')
  assert.deepEqual(round.banner, full.banner)
  assert.equal(round.includeTitle, false)
  // Additive fields: old packs without them stay valid, and the store keeps version 1.
  assert.equal(store.TEMPLATE_STORE_VERSION, 1)
  const legacy = store.normalizeTemplates([{ version: 1, id: 'legacy', name: 'Legacy', captionPresetId: 'pop', formats: ['9:16'] }])
  assert.equal(legacy.length, 1)
  assert.equal(legacy[0].banner, undefined)
  assert.equal(legacy[0].includeTitle, undefined)
  assert.equal(legacy[0].pacing, undefined)
  assert.equal(legacy[0].layoutStyle, undefined)
  // Bad values throw on save…
  for (const bad of [
    { banner: { platform: 'myspace', channelUrl: 'https://example.com/@me' } },
    { banner: { platform: 'youtube' } },
    { banner: { platform: 'youtube', channelUrl: 'youtube.com/@me' } },
    { banner: { platform: 'youtube', channelUrl: '' } },
    { banner: { platform: 'youtube', channelUrl: `https://e.com/${'a'.repeat(200)}` } },
    { banner: 'https://youtube.com/@studio' },
    { pacing: 'brisk' },
    { layoutStyle: 'zoom' },
    { includeTitle: 'yes' }
  ]) assert.throws(() => store.saveTemplate(pack(bad)), /Invalid brand template/, JSON.stringify(bad))
  // …and one bad entry only drops itself on load.
  const mixed = store.normalizeTemplates([
    { id: 'good', name: 'Good', captionPresetId: 'pop', formats: ['9:16'], pacing: 'tight', banner: { platform: 'tiktok', channelUrl: 'https://www.tiktok.com/@me' } },
    { id: 'bad-banner', name: 'Bad', captionPresetId: 'pop', formats: ['9:16'], banner: { platform: 'youtube', channelUrl: 'ftp://youtube.com/@me' } },
    { id: 'bad-title', name: 'Bad', captionPresetId: 'pop', formats: ['9:16'], includeTitle: 1 }
  ])
  assert.deepEqual(mixed.map((tpl) => tpl.id), ['good'])
  assert.deepEqual(mixed[0].banner, { platform: 'tiktok', channelUrl: 'https://www.tiktok.com/@me' })
})

test('a corrupt templates file is kept for recovery instead of being overwritten', (t) => {
  const { store, userData } = workspace(t)
  fs.writeFileSync(path.join(userData, 'templates.json'), '{ not json')
  assert.throws(() => store.loadTemplates(), /kept for recovery/i)
})

test('main copies the picked logo into the pack folder, replaces it, and prunes it on delete', (t) => {
  const { store, dir, userData } = workspace(t)
  const assetDir = path.join(userData, 'templates', 'studio-pack')
  const pick = path.join(dir, 'picked.png')
  fs.writeFileSync(pick, 'fake-png-bytes')
  store.saveTemplate(pack(), pick)
  const asset = path.join(assetDir, 'logo.png')
  assert.equal(store.logoAssetPath('studio-pack'), asset)
  assert.equal(fs.readFileSync(asset, 'utf-8'), 'fake-png-bytes')
  // A later save without a new pick keeps the stored logo.
  store.saveTemplate(pack({ name: 'Studio pack v2' }))
  assert.equal(fs.existsSync(asset), true)
  // A new pick replaces the old file: exactly one logo remains.
  const jpg = path.join(dir, 'picked.jpg')
  fs.writeFileSync(jpg, 'jpeg-bytes')
  store.saveTemplate(pack(), jpg)
  assert.deepEqual(fs.readdirSync(assetDir), ['logo.jpg'])
  assert.equal(store.logoAssetPath('studio-pack'), path.join(assetDir, 'logo.jpg'))
  // Anything that is not a small image file is rejected before it is copied.
  assert.throws(() => store.saveTemplate(pack(), 'picked.png'), /file picker/i)
  assert.throws(() => store.saveTemplate(pack(), path.join(dir, 'missing.png')), /could not be read/i)
  const notes = path.join(dir, 'notes.txt')
  fs.writeFileSync(notes, 'x')
  assert.throws(() => store.saveTemplate(pack(), notes), /PNG, JPG or WebP/i)
  assert.equal(store.logoAssetPath('../escape'), null)
  store.deleteTemplate('studio-pack')
  assert.equal(fs.existsSync(assetDir), false)
})

test('main copies picked intro/outro videos into the pack folder, one file per slot', (t) => {
  const { store, dir, userData } = workspace(t)
  const assetDir = path.join(userData, 'templates', 'studio-pack')
  const intro = path.join(dir, 'picked-intro.mp4')
  const outro = path.join(dir, 'picked-outro.mov')
  fs.writeFileSync(intro, 'intro-bytes')
  fs.writeFileSync(outro, 'outro-bytes')
  store.saveTemplate(pack({ intro: 'picked-intro.mp4', outro: 'picked-outro.mov' }), null, intro, outro)
  assert.equal(store.packVideoPath('studio-pack', 'intro'), path.join(assetDir, 'intro.mp4'))
  assert.equal(store.packVideoPath('studio-pack', 'outro'), path.join(assetDir, 'outro.mov'))
  assert.equal(fs.readFileSync(path.join(assetDir, 'intro.mp4'), 'utf-8'), 'intro-bytes')
  // A later save without a new pick keeps both stored videos.
  store.saveTemplate(pack({ intro: 'picked-intro.mp4', outro: 'picked-outro.mov' }))
  assert.deepEqual(fs.readdirSync(assetDir).sort(), ['intro.mp4', 'outro.mov'])
  // A new pick replaces only its own slot's file.
  const webm = path.join(dir, 'next.webm')
  fs.writeFileSync(webm, 'webm-bytes')
  store.saveTemplate(pack({ intro: 'next.webm', outro: 'picked-outro.mov' }), null, webm)
  assert.deepEqual(fs.readdirSync(assetDir).sort(), ['intro.webm', 'outro.mov'])
  // Anything that is not a small video file is rejected before it is copied.
  assert.throws(() => store.saveTemplate(pack({ intro: 'x' }), null, 'picked-intro.mp4'), /file picker/i)
  assert.throws(() => store.saveTemplate(pack({ intro: 'x' }), null, path.join(dir, 'missing.mp4')), /could not be read/i)
  const notes = path.join(dir, 'notes.txt')
  fs.writeFileSync(notes, 'x')
  assert.throws(() => store.saveTemplate(pack({ intro: 'x' }), null, notes), /MP4, MOV or WebM/i)
  assert.equal(store.packVideoPath('../escape', 'intro'), null)
  // Dropping the field from the config disables the slot even though the file lingers.
  store.saveTemplate(pack({ outro: 'picked-outro.mov' }))
  const saved = store.getTemplate('studio-pack')
  assert.equal(saved.intro, undefined)
  assert.equal(saved.outro, 'picked-outro.mov')
})
