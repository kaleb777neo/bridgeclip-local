'use strict'
// Auto Import: playlist id parsing, config normalization, dedup across polls
// and job enqueueing — with yt-dlp stubbed, no network. No real key needed.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const root = tempDir('bridgeclip-auto-import-')
test.after(() => root.cleanup())

function loadModule() {
  const { electron } = fakeElectron(root.dir)
  return loadMain("export * from './src/main/auto-import'", { electron })
}

function writeSettings(playlists, enabled = true) {
  fs.mkdirSync(path.join(root.dir, 'userData'), { recursive: true })
  fs.writeFileSync(path.join(root.dir, 'userData', 'settings.json'), JSON.stringify({
    version: 3, outputDirectory: path.join(root.dir, 'library'), pythonPath: 'python3',
    autoImportPlaylists: playlists, autoImportEnabled: enabled, autoImportIntervalMinutes: 30
  }))
}

test('playlist ids parse from URLs and raw ids; junk is refused', () => {
  const mod = loadModule()
  assert.equal(mod.playlistIdFrom('https://www.youtube.com/playlist?list=PLabc123def456ghi789012'), 'PLabc123def456ghi789012')
  assert.equal(mod.playlistIdFrom('PLxyz987654321xyz987'), 'PLxyz987654321xyz987')
  assert.equal(mod.playlistIdFrom('https://youtube.com/watch?v=x'), null)
  assert.equal(mod.playlistIdFrom('not a playlist'), null)
})

test('config normalization: playlists from URLs dedupe and junk lines drop', async () => {
  writeSettings('PLaaa11111111111\nPLaaa11111111111\nhttps://www.youtube.com/playlist?list=PLbbb22222222222\nnot a playlist')
  const mod = loadModule()
  const status = await mod.autoImportStatus()
  assert.deepEqual(status.config.playlists, ['PLaaa11111111111', 'PLbbb22222222222'])
  assert.equal(status.lastPollAt, null)
})

test('poll queues new uploads once, skips already-imported and caps per playlist', async () => {
  writeSettings('PLaaa11111111111')
  const mod = loadModule()
  const lister = async () => [
    { id: 'vid_old', title: 'Already imported' },
    { id: 'vid_new1', title: 'Fresh upload one' },
    { id: 'vid_new2', title: 'Fresh upload two' },
    { id: 'vid_new3', title: 'Fresh upload three' }
  ]
  const store = path.join(root.dir, 'userData', 'auto-import-state.json')
  fs.mkdirSync(path.dirname(store), { recursive: true })
  fs.writeFileSync(store, JSON.stringify({ version: 1, imported: { vid_old: '2026-01-01T00:00:00.000Z' }, lastPollAt: null }))

  const first = await mod.pollAutoImport({ lister })
  assert.equal(first.queued.length, 3, 'all fresh uploads are queued (max per poll = 3)')
  assert.equal(mod.autoImportStatus().importedCount, 4)
  assert.equal(mod.autoImportStatus().polling, false)

  const second = await mod.pollAutoImport()
  assert.equal(second.queued.length, 0, 'the same uploads are never queued twice')

  const persisted = JSON.parse(fs.readFileSync(store, 'utf8'))
  assert.ok(persisted.imported.vid_new1 && persisted.imported.vid_old)
})

test('a playlist listing failure is reported without blocking other playlists', async () => {
  writeSettings('PLaaa11111111111\nPLbbb22222222222')
  const mod = loadModule()
  let calls = 0
  const lister = async (playlistId) => {
    calls += 1
    if (playlistId === 'PLaaa11111111111') throw new Error('network down')
    return [{ id: 'vid_ok', title: 'Good upload' }]
  }
  const result = await mod.pollAutoImport({ lister })
  assert.equal(calls, 2, 'both playlists were attempted')
  assert.equal(result.queued.length, 1)
  assert.match(result.errors[0], /network down/)
})

test('poll due-ness honors the configured interval', () => {
  const mod = loadModule()
  const now = Date.now()
  assert.equal(mod.autoImportDue(null, 30), true, 'never polled: due')
  assert.equal(mod.autoImportDue('not a date', 30), true, 'an unreadable timestamp polls anyway')
  assert.equal(mod.autoImportDue(new Date(now - 5 * 60_000).toISOString(), 30), false, '5 minutes into a 30 minute interval waits')
  assert.equal(mod.autoImportDue(new Date(now - 29 * 60_000).toISOString(), 30), false, '29 minutes into a 30 minute interval waits')
  assert.equal(mod.autoImportDue(new Date(now - 31 * 60_000).toISOString(), 30), true, 'past the interval it is due')
  assert.equal(mod.autoImportDue(new Date(now - 16 * 60_000).toISOString(), 15), true, 'the minimum interval applies too')
})
