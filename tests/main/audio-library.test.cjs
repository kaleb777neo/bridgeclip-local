'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')

const source = "export * from './src/main/audio-library'"
const hex32 = (c) => c.repeat(32)

function workspace(t) {
  const temp = tempDir('bridgeclip-audio-')
  t.after(temp.cleanup)
  const userData = path.join(temp.dir, 'userData')
  fs.mkdirSync(userData, { recursive: true })
  return { ...temp, store: loadMain(source, { electron: fakeElectron(temp.dir).electron }), userData }
}

test('imported tracks are copied into the library and listed with their metadata', (t) => {
  const w = workspace(t)
  const staged = path.join(w.dir, 'staged.m4a')
  fs.writeFileSync(staged, 'audio bytes')
  const track = w.store.addToAudioLibrary(staged, '  My Song  ', 180000.4, 'link')
  assert.match(track.id, /^[a-f0-9]{32}$/)
  assert.equal(track.title, 'My Song')
  assert.equal(track.duration_ms, 180000)
  assert.equal(track.origin, 'link')
  assert.equal(fs.readFileSync(path.join(w.userData, 'audio-library', `${track.id}.m4a`), 'utf8'), 'audio bytes')
  // The listing carries the stored file so the editor can preview it.
  assert.deepEqual(w.store.listAudioLibrary(), [{ ...track, file: path.join(w.userData, 'audio-library', `${track.id}.m4a`) }])
  const persisted = JSON.parse(fs.readFileSync(path.join(w.userData, 'audio-library.json'), 'utf8'))
  assert.equal(persisted.version, w.store.AUDIO_LIBRARY_VERSION)
  assert.deepEqual(Object.keys(persisted).sort(), ['tracks', 'version'])
  // The run's asset is mirrored, not moved.
  assert.equal(fs.readFileSync(staged, 'utf8'), 'audio bytes')
})

test('a corrupt entry never hides the rest of the library', (t) => {
  const w = workspace(t)
  const good = { id: hex32('a'), title: 'Good', duration_ms: 1000, origin: 'file', added_at: 5 }
  fs.writeFileSync(path.join(w.userData, 'audio-library.json'), JSON.stringify({ version: 1, tracks: [
    good, null, 'nope', { id: 'short', title: 'Bad id', duration_ms: 1, origin: 'file', added_at: 1 },
    { ...good, id: hex32('b'), title: '' }, { ...good, title: 'y'.repeat(500) },
    { ...good, id: hex32('b'), title: 'Second', added_at: 9 }, { ...good, id: hex32('c'), duration_ms: 99999999 }] }))
  const tracks = w.store.listAudioLibrary()
  assert.deepEqual(tracks.map((track) => [track.id, track.title]), [[hex32('a'), 'Good'], [hex32('b'), 'Second']])
  assert.equal(tracks[1].title.length, 'Second'.length, 'the long title belongs to the skipped duplicate, not this one')
})

test('a track resolves to its file, and removal cleans both the entry and the file', (t) => {
  const w = workspace(t)
  const staged = path.join(w.dir, 'song.m4a')
  fs.writeFileSync(staged, 'bytes')
  const track = w.store.addToAudioLibrary(staged, 'Song', 1000, 'file')
  assert.equal(w.store.getAudioTrack(track.id).title, 'Song')
  assert.equal(w.store.getAudioTrack('nope'), null)
  assert.equal(fs.existsSync(w.store.audioTrackFile(track.id)), true)
  assert.equal(w.store.audioTrackFile(hex32('f')), null, 'an unknown id has no file')
  // A link planted in the library folder is never handed out (junctions need no privileges on Windows).
  fs.symlinkSync(w.dir, path.join(w.userData, 'audio-library', `${hex32('e')}.m4a`), 'junction')
  assert.equal(w.store.audioTrackFile(hex32('e')), null)
  assert.equal(w.store.removeAudioTrack('missing'), false)
  assert.equal(w.store.removeAudioTrack(track.id), true)
  assert.equal(fs.existsSync(path.join(w.userData, 'audio-library', `${track.id}.m4a`)), false)
  assert.deepEqual(w.store.listAudioLibrary(), [])
})

test('imports validate the staged file, the title, the duration and the origin', (t) => {
  const w = workspace(t)
  const file = path.join(w.dir, 'a.m4a')
  fs.writeFileSync(file, 'bytes')
  assert.throws(() => w.store.addToAudioLibrary('relative.m4a', 'T', 1, 'file'), /Invalid audio import result/)
  assert.throws(() => w.store.addToAudioLibrary(path.join(w.dir, 'missing.m4a'), 'T', 1, 'file'), /vanished/)
  assert.throws(() => w.store.addToAudioLibrary(file, '   ', 1, 'file'), /title/)
  assert.throws(() => w.store.addToAudioLibrary(file, 'T', -5, 'file'), /duration/)
  assert.throws(() => w.store.addToAudioLibrary(file, 'T', 1, 'youtube'), /origin/)
})

test('the library caps at 300 tracks instead of growing without bound', (t) => {
  const w = workspace(t)
  const staged = path.join(w.dir, 'a.m4a')
  fs.writeFileSync(staged, 'bytes')
  for (let i = 0; i < 300; i++) w.store.addToAudioLibrary(staged, `Track ${i}`, 1000, 'file')
  assert.throws(() => w.store.addToAudioLibrary(staged, 'One more', 1000, 'file'), /full/)
  assert.equal(w.store.listAudioLibrary().length, 300)
})
