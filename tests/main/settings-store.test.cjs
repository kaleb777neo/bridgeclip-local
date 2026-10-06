'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

function loadShared(file) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared', file), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(js, { module, exports: module.exports, require: (id) => id.startsWith('./') ? loadShared(`${id.slice(2)}.ts`) : require(id), URL })
  return module.exports
}

/**
 * settings-store with its userData pointed at a temp dir and encryption off —
 * the empty-string keys never reach safeStorage, so no OS keychain is needed.
 */
function loadSettingsStore(userDataDir) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main/settings-store.ts'), 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const electron = {
    app: { isReady: () => true, getPath: (name) => (name === 'userData' ? userDataDir : path.join(userDataDir, name)) },
    safeStorage: { isEncryptionAvailable: () => false }
  }
  const module = { exports: {} }
  vm.runInNewContext(js, {
    module, exports: module.exports,
    require: (id) => id === 'electron' ? electron : id === '../shared/jev-settings' ? loadShared('jev-settings.ts') : require(id),
    URL, Set, Map, process, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.join(__dirname, '../../src/main')
  })
  return module.exports
}

function tempLibrary(userDataDir) {
  const lib = path.join(userDataDir, 'library')
  fs.mkdirSync(lib)
  return lib
}

test('default template and auto import settings survive a restart', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-settings-'))
  try {
    const first = loadSettingsStore(userData)
    const saved = first.savePublicSettings({
      outputDirectory: tempLibrary(userData), pythonPath: 'python', customVocabulary: '',
      defaultTemplateId: 'brand-1',
      autoImportPlaylists: 'PL123\nPL456', autoImportEnabled: true, autoImportIntervalMinutes: 30
    })
    assert.equal(saved.defaultTemplateId, 'brand-1', 'returned settings report the new default')

    // A fresh module over the same userData is the restart path: the values
    // must come back from settings.json, not from process memory.
    const second = loadSettingsStore(userData)
    const reloaded = second.loadSettings()
    assert.equal(reloaded.defaultTemplateId, 'brand-1')
    assert.equal(reloaded.autoImportEnabled, true)
    assert.equal(reloaded.autoImportIntervalMinutes, 30)
    assert.equal(reloaded.autoImportPlaylists, 'PL123\nPL456')
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('a default template id outside the id shape falls back to none', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-settings-'))
  try {
    const store = loadSettingsStore(userData)
    const saved = store.savePublicSettings({
      outputDirectory: tempLibrary(userData), pythonPath: 'python', customVocabulary: '',
      defaultTemplateId: '../evil'
    })
    assert.equal(saved.defaultTemplateId, '')
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})
