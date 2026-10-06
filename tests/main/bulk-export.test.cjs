'use strict'
// Bulk download: clips:bulkExport copies every selected clip into the picked
// folder with collision-safe names, pushes live per-clip progress events, and
// reports per-item failures instead of failing the whole batch.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

function writeMedia(dir, name, size) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, Buffer.alloc(size, 7))
  return file
}

function setup(t, files, dialog) {
  const temp = tempDir('bridgeclip-bulk-export-')
  t.after(temp.cleanup)
  const library = path.join(temp.dir, 'library')
  fs.mkdirSync(library, { recursive: true })
  const dest = path.join(temp.dir, 'export-target')
  fs.mkdirSync(dest, { recursive: true })
  for (const [name, size] of files) writeMedia(library, name, size)
  const fake = fakeElectron(temp.dir)
  const handlers = new Map()
  const security = loadMain("export * from './src/main/security'", { electron: {} })
  const ipc = loadMain("export * from './src/main/ipc-handlers'", {
    electron: {
      app: { isPackaged: false },
      shell: {},
      ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
      dialog: { showOpenDialog: async () => dialog(dest) }
    },
    './settings-store': { loadSettings: () => ({ outputDirectory: library }) },
    './security': {
      ...security,
      // One designated victim fails at open time (as a locked/missing file would).
      openAuthorizedMedia: async (p, dir) => {
        if (String(p).includes('locked')) throw new Error('file is locked')
        return security.openAuthorizedMedia(p, dir)
      }
    },
    './audio-library': { listAudioLibrary: async () => ({ tracks: [] }), removeAudioTrack: async () => true },
    './motion-studio': { planMotionShots: async () => null },
    './auto-import': { initAutoImport() {}, pollAutoImport: async () => null, autoImportStatus: () => null },
    './file-manager': {}, './output-storage': { measureOutputStorage: async (d) => ({ outputDirectory: d, bytes: 0 }) },
    './clip-editor': {}, './editor-ai': {}, './edit-inspector': { inspectEdits: async () => ({}) },
    './export-fcpxml': {}, './run-history': {}, './pipeline-runner': {}, './job-manager': { initJobManager() {} },
    './logger': {}, './network-policy': {}, './validation': {}, './templates-store': {}, './template-resolve': {},
    './openrouter-models': {}, './youtube-preview': {}, './tools': {}, './local-ai': { modelsDir: () => '/tmp/m' },
    './zernio/service': {}, './zernio/posts': {}, './zernio/analytics': {},
    './automations': {}, './library-posting': {}, './library-management': {}
  })
  ipc.registerIpcHandlers(() => fake.window)
  // The handle() wrapper enforces a trusted sender; build one from the fake window.
  fake.window.webContents.mainFrame = {}
  const trusted = { sender: fake.window.webContents, senderFrame: fake.window.webContents.mainFrame }
  const exportClips = (clips) => handlers.get('clips:bulkExport')(trusted, clips)
  return { exportClips, sent: fake.calls.sent, dest, library }
}

const progressEvents = (sent) => sent.filter((event) => event.channel === 'clips:bulkExportProgress').map((event) => event.payload)

test('bulk export copies every clip, reports per-clip progress, and names collisions safely', (t) => {
  const { exportClips, sent, dest, library } = setup(t, [
    ['empty.mp4', 0], ['speech.mp4', 200 * 1024], ['big.mp4', 300 * 1024]
  ], (target) => ({ canceled: false, filePaths: [target] }))
  const result = exportClips([
    { path: path.join(library, 'empty.mp4'), name: '#1 Empty' },
    { path: path.join(library, 'speech.mp4'), name: '#2 Speech' },
    { path: path.join(library, 'big.mp4'), name: '#2 Speech' } // same title → collision
  ])
  return result.then((out) => {
    assert.equal(out.success, true)
    assert.equal(out.count, 3)
    assert.equal(out.failedCount, 0)
    assert.deepEqual(out.failures, [])
    assert.deepEqual(fs.readdirSync(dest).sort(), ['#1 Empty.mp4', '#2 Speech (1).mp4', '#2 Speech.mp4'])
    assert.equal(fs.statSync(path.join(dest, '#2 Speech.mp4')).size, 200 * 1024)
    assert.equal(fs.statSync(path.join(dest, '#2 Speech (1).mp4')).size, 300 * 1024)
    assert.equal(fs.statSync(path.join(dest, '#1 Empty.mp4')).size, 0)

    const progress = progressEvents(sent)
    for (const index of [0, 1, 2]) {
      assert.equal(progress.filter((p) => p.index === index && p.status === 'done' && p.percent === 100).length, 1, `done for ${index}`)
    }
    // The multi-chunk file streamed increasing percents before completing.
    const percents = progress.filter((p) => p.index === 1 && p.status === 'copying').map((p) => p.percent)
    assert.ok(percents.length >= 1 && percents.every((value, i) => i === 0 || value > percents[i - 1]), `percent stream increases: ${percents.join(',')}`)
    assert.ok(progress.every((p) => p.total === 3 && typeof p.name === 'string'))
  })
})

test('bulk export isolates per-item failures and keeps copying the rest', (t) => {
  const { exportClips, sent, dest, library } = setup(t, [
    ['good.mp4', 1024], ['locked.mp4', 1024]
  ], (target) => ({ canceled: false, filePaths: [target] }))
  const result = exportClips([
    { path: path.join(library, 'good.mp4'), name: 'Good' },
    { path: path.join(library, 'locked.mp4'), name: 'Locked' }
  ])
  return result.then((out) => {
    assert.equal(out.count, 1)
    assert.equal(out.failedCount, 1)
    assert.deepEqual(out.failures, ['Locked'])
    assert.deepEqual(fs.readdirSync(dest), ['Good.mp4'])
    const failed = progressEvents(sent).filter((p) => p.index === 1)
    assert.deepEqual(failed.map((p) => p.status), ['copying', 'failed'])
    assert.equal(progressEvents(sent).filter((p) => p.index === 0 && p.status === 'done').length, 1)
  })
})

test('canceling the folder picker copies nothing and emits no progress', (t) => {
  const { exportClips, sent, library } = setup(t, [['a.mp4', 16]], () => ({ canceled: true, filePaths: [] }))
  return exportClips([{ path: path.join(library, 'a.mp4'), name: 'A' }]).then((out) => {
    assert.deepEqual(out, { success: false, count: 0, failedCount: 0 })
    assert.equal(progressEvents(sent).length, 0)
  })
})

test('the export selection is validated before any dialog opens', async (t) => {
  const { exportClips, library } = setup(t, [['a.mp4', 16]], () => ({ canceled: true, filePaths: [] }))
  await assert.rejects(() => exportClips(new Array(501).fill({ path: path.join(library, 'a.mp4'), name: 'x' })), /Invalid export selection/)
  await assert.rejects(() => exportClips([{ path: path.join(library, '..', 'outside.mp4'), name: 'x' }]), /Invalid|outside|authorized/i)
})
