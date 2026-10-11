'use strict'
// The Import tab's drop handler: main infers the asset kind (image/video/audio)
// from the dropped file's extension and routes it through addEditorAsset.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

function loadSource(file, mocks = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => mocks[id] ?? require(id), URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout, __dirname: path.join(__dirname, '../../src/main') })
  return module.exports
}

const clipEditor = {
  assetKinds: {
    image: { exts: ['png', 'jpg', 'jpeg', 'webp'], maxBytes: 15 * 1024 * 1024 },
    video: { exts: ['mp4', 'm4v', 'mov', 'mkv', 'webm'], maxBytes: 250 * 1024 * 1024 },
    audio: { exts: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'], maxBytes: 40 * 1024 * 1024 }
  },
  addEditorAsset: async (_run, kind, source) => ({ asset: `ref.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'm4a'}`, name: path.basename(source), kind })
}
const calls = []
clipEditor.addEditorAsset = async (run, kind, source) => { calls.push([run, kind, source]); return { asset: `ref-${calls.length}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'm4a'}`, name: path.basename(String(source)) } }

function loadHandlers() {
  return loadSource('ipc-handlers.ts', {
    electron: { app: { isPackaged: false }, ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) }, dialog: {}, shell: {} },
    './settings-store': { loadSettings: () => ({ outputDirectory: os.tmpdir() }) },
    './audio-library': { listAudioLibrary: async () => ({ tracks: [] }), removeAudioTrack: async () => true },
    './motion-studio': { planMotionShots: async () => null },
    './auto-import': { initAutoImport() {}, pollAutoImport: async () => null, autoImportStatus: () => null },
    './file-manager': {}, './output-storage': { measureOutputStorage: async (d) => ({ outputDirectory: d, bytes: 0 }) },
    './clip-editor': clipEditor, './editor-ai': {}, './edit-inspector': { inspectEdits: async () => ({}) },
    './export-fcpxml': {}, './run-history': {}, './pipeline-runner': {}, './job-manager': { initJobManager() {} },
    './logger': {}, './security': { authorizeMedia: (p) => { if (!fs.existsSync(p)) throw new Error('The media file could not be read'); return p }, assertTrustedSender() {}, assertAbsolutePath(p) { return p }, isWebUrl: () => true, isTrustedExternalUrl: () => true, openAuthorizedMedia: async () => { throw new Error('unused') } },
    './network-policy': {}, './validation': {}, './templates-store': {}, './caption-styles-store': {}, './template-resolve': {},
    './openrouter-models': {}, './youtube-preview': {}, './tools': {}, './local-ai': { modelsDir: () => '/tmp/m' },
    './zernio/service': {}, './zernio/posts': {}, './zernio/analytics': {},
    './automations': {}, './library-posting': {}, './library-management': {}
  })
}

const handlers = new Map()
const ipc = loadHandlers()
ipc.registerIpcHandlers(() => ({ webContents: { mainFrame: {} }, isDestroyed: () => false }))

test('the import drop handler infers image/video/audio kinds from the extension', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-import-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const drop = handlers.get('editor:addAssetDropped')
  assert.equal(typeof drop, 'function')
  for (const [file, kind] of [['b-roll.png', 'image'], ['take.mp4', 'video'], ['broll.mkv', 'video'], ['bed.mp3', 'audio'], ['voice.m4a', 'audio']]) {
    const p = path.join(root, file)
    fs.writeFileSync(p, 'x')
    const out = await drop(null, 'run-dir', p)
    assert.equal(out.asset.split('.').pop(), kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'm4a', file)
  }
  assert.deepEqual(calls.map((c) => c[1]), ['image', 'video', 'video', 'audio', 'audio'])
  // The run folder and the authorized path travel together.
  assert.ok(calls.every((c) => c[0] === 'run-dir' && path.isAbsolute(c[2])))
  // Unsupported extensions fail with the friendly message; so do non-strings and missing files.
  const txt = path.join(root, 'notes.txt')
  fs.writeFileSync(txt, 'x')
  await assert.rejects(() => drop(null, 'run-dir', txt), /file type can't be used here/i)
  await assert.rejects(() => drop(null, 'run-dir', path.join(root, 'gone.mp4')), /could not be read/i)
  await assert.rejects(() => drop(null, 'run-dir', 7), /not a supported media file/i)
})
