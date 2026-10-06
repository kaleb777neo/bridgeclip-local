const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const fixture = require('../fixtures/editor/project.json')
const schema = loadMain("export * from './src/shared/clip-editor'")
const clone = () => structuredClone(fixture)

test('editor project validates cuts, geometry and candidate identity; strips extra authority', () => {
  const p = clone(); p.apiKey = 'secret'; p.candidates[0].sourcePath = '/private.mp4'
  const parsed = schema.parseEditorProject(p)
  assert.equal(parsed.candidates[0].review.questions.length, 8)
  assert.ok(!JSON.stringify(parsed).includes('secret'))
  assert.ok(!JSON.stringify(parsed).includes('/private'))
  for (const modify of [
    p => { p.version = 2 }, p => { p.width = Infinity }, p => { p.candidates[0].ranges[0][1] = NaN },
    p => { p.candidates[0].ranges[1][0] = 4000 }, p => { p.candidates[0].scenes[0].crops[0][0] = .9 },
    p => { p.candidates[0].scenes[0].at_ms = 1 }, p => { p.candidates[1].id = p.candidates[0].id },
    p => { p.candidates[0].captions = 'yes' }, p => { p.candidates[0].review.questions[0].probability = 1.5 }
  ]) { const p = clone(); modify(p); assert.throws(() => schema.parseEditorProject(p)) }
})

test('long display text with emoji is clamped by UTF-16 length instead of rejecting the project', () => {
  const p = clone()
  p.candidates[0].title = 'a'.repeat(199) + '😀'
  p.candidates[0].reason = 'r'.repeat(3999) + '👍🏽'
  p.title = 't'.repeat(1030)
  p.transcript[0].text = 'w'.repeat(19999) + '😀'
  const parsed = schema.parseEditorProject(p)
  assert.equal(parsed.candidates[0].title, 'a'.repeat(199))
  assert.equal(parsed.candidates[0].reason, 'r'.repeat(3999))
  assert.equal(parsed.title.length, 1024)
  assert.equal(parsed.transcript[0].text, 'w'.repeat(19999))
  assert.equal(schema.clampText('ab😀c', 4), 'ab😀')
  for (const bad of [null, 5, ['a']]) assert.throws(() => schema.clampText(bad, 10))
  const blank = clone(); blank.candidates[0].title = ' '.repeat(300)
  assert.throws(() => schema.parseEditorProject(blank))
})

test('editor progress prioritizes unfinished candidates, then baked ones, over discards', () => {
  for (const [statuses, remaining, initialCandidate] of [
    [['discarded', 'refining', 'ready'], 2, 1],
    [['baked', 'discarded', 'ready', 'refining'], 2, 2],
    [['discarded', 'baked'], 0, 1],
    [['discarded', 'discarded'], 0, 0],
    [[undefined, 'discarded'], 1, 0]
  ]) assert.deepEqual(schema.editorProgress(statuses.map(status => ({ status }))), { remaining, initialCandidate })
})

test('edit signature invalidates Jev after trims, titles or framing, and preserves it for caption settings', () => {
  const c = clone().candidates[0]
  assert.equal(JSON.stringify(JSON.parse(c.review.signature)), schema.editSignature(c))
  const key = schema.editSignature(c)
  c.captions = false; c.video_speed = 1.5
  assert.equal(schema.editSignature(c), key)
  c.ranges[0][0] = 1200
  assert.notEqual(schema.editSignature(c), key)
  assert.equal(schema.sceneAt(c, 9000).layout, 'split')
  assert.ok(schema.defaultCrop(1920, 1080, 9 / 16, 0)[0] === 0)
  assert.equal(schema.editDuration(c), 6800 / 1.5)
})

test('smooth movement preserves legacy projects and eases crops continuously through interrupted layouts', () => {
  const c = clone().candidates[0]
  const original = schema.editSignature(c)
  c.scenes[0].transition_ms = 0
  assert.equal(schema.editSignature(c), original)
  c.scenes = [
    { at_ms: 0, layout: 'fill', crops: [[0, 0, .4, 1]] },
    { at_ms: 2000, layout: 'fill', crops: [[.6, .5, .2, .5]], transition_ms: 1000 },
    { at_ms: 2500, layout: 'fill', crops: [[0, 0, .4, 1]], transition_ms: 1000 }
  ]
  assert.deepEqual(schema.framingAt(c, 2000).crops[0], [0, 0, .4, 1])
  assert.deepEqual(schema.framingAt(c, 2500).crops[0], [.3, .25, .30000000000000004, .75])
  assert.ok(Math.abs(schema.framingAt(c, 3000).crops[0][0] - .15) < 1e-9)
  assert.deepEqual(schema.framingAt(c, 3500).crops[0], [0, 0, .4, 1])
  assert.equal(schema.parseCandidateEdit(c, 12000).scenes[1].transition_ms, 1000)
  const animatedKey = schema.editSignature(c)
  c.scenes[1].transition_ms = 600
  assert.notEqual(schema.editSignature(c), animatedKey)
  for (const duration of [-1, 99, 5001, Infinity, NaN, '600', 600.5, null]) {
    c.scenes[1].transition_ms = duration
    assert.throws(() => schema.parseCandidateEdit(c, 12000))
  }
  c.scenes[1].transition_ms = 600; c.scenes[0].layout = 'fit'
  assert.throws(() => schema.parseCandidateEdit(c, 12000))
  c.scenes = schema.normalizeSceneTransitions(c.scenes)
  assert.equal(c.scenes[1].transition_ms, undefined)
  assert.equal(schema.parseCandidateEdit(c, 12000).scenes[2].transition_ms, 1000)
})

test('timeline edges extend to source limits without crossing other cuts or collapsing a cut', () => {
  const cuts = [[10000, 15000], [18000, 20000]]
  assert.deepEqual(schema.trimRange(cuts, 0, 0, -500, 60000), [[0, 15000], [18000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 1, 1, 70000, 60000), [[10000, 15000], [18000, 60000]])
  assert.deepEqual(schema.trimRange(cuts, 0, 1, 19000, 60000), [[10000, 18000], [18000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 1, 0, 0, 60000), [[10000, 15000], [15000, 20000]])
  assert.deepEqual(schema.trimRange(cuts, 0, 1, 0, 60000), [[10000, 10100], [18000, 20000]])
  assert.deepEqual(cuts, [[10000, 15000], [18000, 20000]])
})

test('layout start times move between neighbours without changing crops, motion or the initial layout', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  const scenes = [c.scenes[0], { ...c.scenes[0], at_ms: 3000, transition_ms: 700 }, { ...c.scenes[1], at_ms: 8000 }]
  const before = structuredClone(scenes)
  for (const [time, expected] of [[4000.4, 4000], [2500, 2500], [-1000, 1], [9000, 7999]]) {
    const moved = schema.retimeScene(scenes, 1, time, 12000)
    assert.equal(moved[1].at_ms, expected)
    assert.deepEqual({ ...moved[1], at_ms: 3000 }, scenes[1])
    assert.equal(moved[0], scenes[0]); assert.equal(moved[2], scenes[2])
    assert.doesNotThrow(() => schema.parseCandidateEdit({ ...c, scenes: moved }, 12000))
  }
  assert.equal(schema.retimeScene(scenes, 2, 20000, 12000)[2].at_ms, 11999)
  assert.equal(schema.retimeScene(scenes, 2, 0, 12000)[2].at_ms, 3001)
  for (const [index, time] of [[0, 5000], [-1, 2000], [3, 2000], [1, NaN], [1, Infinity], [1, 3000]]) {
    assert.equal(schema.retimeScene(scenes, index, time, 12000), scenes)
  }
  const adjacent = [scenes[0], { ...scenes[1], at_ms: 1 }, { ...scenes[2], at_ms: 2 }]
  assert.equal(schema.retimeScene(adjacent, 1, 1000, 12000), adjacent)
  assert.deepEqual(scenes, before)
  const approved = { ...c, status: 'ready', scenes }
  const moved = schema.refineEdit(approved, { scenes: schema.retimeScene(scenes, 1, 4000, 12000) })
  assert.equal(moved.status, 'refining')
  assert.notEqual(schema.editSignature(moved), schema.editSignature(approved))
})

test('each crop corner resizes proportionally while anchoring its opposite corner', () => {
  const original = [.25, .25, .2, .4], width = 640, height = 360
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
    for (const scale of [.75, 1.4]) {
      const next = schema.resizeCrop(original, corner, sx * original[2] * width * (scale - 1), sy * original[3] * height * (scale - 1), width, height)
      close(next[2], original[2] * scale); close(next[3], original[3] * scale)
      close(next[0] + (sx < 0 ? next[2] : 0), original[0] + (sx < 0 ? original[2] : 0))
      close(next[1] + (sy < 0 ? next[3] : 0), original[1] + (sy < 0 ? original[3] : 0))
    }
    // Vertical-only movement also resizes without stretching the output.
    const vertical = schema.resizeCrop(original, corner, 0, sy * -20, width, height)
    assert.ok(vertical[2] < original[2]); close(vertical[2] / vertical[3], original[2] / original[3])
  }
  assert.deepEqual(original, [.25, .25, .2, .4])
})

test('corner drags stop at source edges and zoom limits without flipping or producing invalid crops', () => {
  for (const [width, height] of [[1920, 1080], [1080, 1920], [1280, 720]]) for (const aspect of [9 / 16, 9 / 8, 16 / 9]) {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const original = schema.defaultCrop(width, height, aspect, .4, .6, 2)
      const sx = corner.endsWith('right') ? 1 : -1, sy = corner.startsWith('bottom') ? 1 : -1
      for (const distance of [-100000, -1, 0, 1, 100000]) {
        const next = schema.resizeCrop(original, corner, sx * distance, sy * distance, 640, 360)
        assert.ok(Math.abs(next[2] / next[3] - original[2] / original[3]) < 1e-9)
        assert.ok(next[0] >= 0 && next[1] >= 0 && next[0] + next[2] <= 1 && next[1] + next[3] <= 1)
        const full = schema.defaultCrop(width, height, aspect)
        assert.ok(next[2] >= full[2] / 4 - 1e-10 && next[3] >= full[3] / 4 - 1e-10)
        const c = schema.parseEditorProject(clone()).candidates[0]
        c.scenes = [{ at_ms: 0, layout: 'fill', crops: [next] }]
        assert.doesNotThrow(() => schema.parseCandidateEdit(c, 12000, 4))
      }
    }
  }
  const legacy = [.2, .2, .02, .04]
  assert.deepEqual(schema.resizeCrop(legacy, 'bottom-right', -10000, -10000, 640, 360), legacy)
  assert.deepEqual(schema.resizeCrop(legacy, 'top-left', 100, 100, 0, 360), legacy)
})

test('legacy candidates start refining; caption corrections are bounded and refer to unique source lines', () => {
  const parsed = schema.parseEditorProject(clone())
  assert.equal(parsed.candidates[0].status, 'refining')
  assert.deepEqual(parsed.candidates[0].caption_edits, [])
  const c = parsed.candidates[0]
  c.caption_edits = [{ segment: 2, text: '' }, { segment: 0, text: 'A corrected line.\nCafé 👋' }]
  assert.deepEqual(schema.parseCandidateEdit(c, 12000, 4).caption_edits.map(e => e.segment), [0, 2])
  for (const patch of [
    { status: 'published' }, { status: null }, { caption_edits: null },
    { caption_edits: [{ segment: 4, text: 'outside source' }] },
    { caption_edits: [{ segment: .5, text: 'fractional' }] },
    { caption_edits: [{ segment: 0, text: 'a' }, { segment: 0, text: 'b' }] },
    { caption_edits: [{ segment: 0, text: 'a'.repeat(2001) }] },
    { caption_edits: [{ segment: 0, text: 'bad\u0000text' }] },
    { caption_edits: Array.from({ length: 2001 }, (_, segment) => ({ segment, text: '' })) }
  ]) assert.throws(() => schema.parseCandidateEdit({ ...c, ...patch }, 12000, 4))
})

test('content changes return approved candidates to refining; status changes preserve source review', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  const patches = [{ title: 'Changed title' }, { ranges: [[1000, 4000]] }, { scenes: [c.scenes[0]] },
    { captions: false }, { caption_preset: 'minimal' }, { video_speed: 1.5 }, { caption_edits: [{ segment: 1, text: 'Correction' }] }]
  for (const status of ['ready', 'baked']) for (const patch of patches) {
    const next = schema.refineEdit({ ...c, status }, patch)
    assert.equal(next.status, 'refining')
    assert.deepEqual(next.review, c.review)
  }
  assert.equal(schema.refineEdit({ ...c, status: 'ready' }, { title: c.title }).status, 'ready')
  assert.equal(schema.refineEdit(c, { status: 'ready' }).status, 'ready')
  assert.equal(schema.refineEdit(c, { status: 'discarded' }).status, 'discarded')
  assert.equal(schema.editSignature(schema.refineEdit(c, patches.at(-1))), schema.editSignature(c))
})

function setup(overrides = {}) {
  const temp = tempDir('bridgeclip-editor-')
  const library = path.join(temp.dir, 'library'), run = path.join(library, 'review-run')
  fs.mkdirSync(run, { recursive: true })
  for (const file of ['editor-source.mp4', 'editor-preview.mp4']) fs.writeFileSync(path.join(run, file), 'video')
  fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(fixture))
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({ job_id: 'review-run', clips: [], editor_project: true }))
  const mocks = { electron: fakeElectron(temp.dir).electron, ...overrides }
  const source = "export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'; export { authorizeMedia } from './src/main/security'"
  const main = loadMain(source, mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, run, library, main, reload: () => loadMain(source, mocks) }
}

test('editor saves only editable fields, survives reload and refuses stale revisions', async () => {
  const f = setup()
  try {
    const opened = await f.main.openEditor(f.run)
    const edits = opened.project.candidates
    edits[0].title = 'A deliberate title'
    edits[0].status = 'ready'
    edits[0].caption_edits = [{ segment: 1, text: 'The correction happened.' }]
    edits[0].scenes.splice(1, 0, { ...structuredClone(edits[0].scenes[0]), at_ms: 3000, transition_ms: 600 })
    edits[0].review = null; edits[0].exports = [999]
    const saved = await f.main.saveEditor(f.run, 0, edits)
    assert.equal(saved.project.revision, 1)
    assert.equal(saved.project.candidates[0].title, 'A deliberate title')
    assert.ok(saved.project.candidates[0].review)
    assert.deepEqual(saved.project.candidates[0].exports, [])
    assert.equal(saved.project.candidates[0].status, 'ready')
    assert.deepEqual(saved.project.candidates[0].caption_edits, edits[0].caption_edits)
    assert.deepEqual(saved.project.transcript, fixture.transcript)
    assert.deepEqual(saved.project.candidates[1].caption_edits, [])
    assert.equal((await f.reload().openEditor(f.run)).project.candidates[0].title, 'A deliberate title')
    assert.equal((await f.reload().openEditor(f.run)).project.candidates[0].scenes[1].transition_ms, 600)
    await assert.rejects(f.main.saveEditor(f.run, 0, edits), /changed/)
    await assert.rejects(f.main.runEditor(f.run, 1, 'unknown', 'export'), /changed/)
  } finally { f.cleanup() }
})

test('only ready candidates render and only a completed render can mark a candidate baked', async () => {
  const f = setup()
  try {
    const project = (await f.main.openEditor(f.run)).project
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'export'), /Mark this clip ready/)
    project.candidates[0].status = 'baked'
    await assert.rejects(f.main.saveEditor(f.run, 0, project.candidates), /completed render/)
    project.candidates[0].status = 'discarded'
    await f.main.saveEditor(f.run, 0, project.candidates)
    await assert.rejects(f.main.runEditor(f.run, 1, 'candidate-1', 'export'), /Mark this clip ready/)
    // A genuine previous render can survive unchanged saves, never edited content.
    project.revision = 2; project.candidates[0].status = 'baked'; project.candidates[0].exports = [0]
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
    await f.main.saveEditor(f.run, 2, project.candidates)
    project.candidates[0].caption_edits = [{ segment: 1, text: 'New words' }]
    await assert.rejects(f.main.saveEditor(f.run, 3, project.candidates), /completed render/)
    project.candidates[0].status = 'refining'
    const saved = await f.main.saveEditor(f.run, 3, project.candidates)
    assert.equal(saved.project.candidates[0].status, 'refining')
    assert.deepEqual(saved.project.candidates[0].exports, [0])
  } finally { f.cleanup() }
})

test('editor rejects external roots and symlinked source/project files', async () => {
  const f = setup()
  try {
    await assert.rejects(f.main.openEditor(f.dir))
    await assert.rejects(f.main.openEditor(f.library))
    const target = path.join(f.dir, 'external.json'); fs.writeFileSync(target, JSON.stringify(fixture))
    const project = path.join(f.run, 'editor-project.json'); fs.unlinkSync(project); fs.symlinkSync(target, project)
    await assert.rejects(f.main.openEditor(f.run))
    fs.unlinkSync(project); fs.writeFileSync(project, JSON.stringify(fixture))
    const source = path.join(f.run, 'editor-source.mp4'); fs.unlinkSync(source); fs.symlinkSync(target, source)
    await assert.rejects(f.main.openEditor(f.run))
    assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(fixture))
  } finally { f.cleanup() }
})

test('editor review requires Jev even with automatic review off and locks the project', async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  let release, entered, config, workerEnv
  const started = new Promise((r) => { entered = r })
  const f = setup({ child_process: { ...require('node:child_process'), spawn: (_cmd, _args, options) => {
    workerEnv = options.env
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      config = JSON.parse(data); entered()
      release = () => { child.stdout.write('{"ok":true}'); child.emit('close', 0) }
    }
    return child
  } } })
  try {
    f.main.settings.replaceApiKey('openrouterApiKey', 'fixture-key')
    f.main.settings.savePublicSettings({ outputDirectory: f.library, pythonPath: 'python3', jevEnabled: 'off' })
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'review')
    await started
    assert.equal(config.action, 'review')
    assert.equal(workerEnv.JEV_ENABLED, 'true')
    assert.equal(f.main.settings.loadSettings().jevEnabled, 'off')
    assert.equal(config.library, fs.realpathSync(f.library))
    assert.equal((await f.main.openEditor(f.run)).operation, 'review')
    await assert.rejects(f.main.saveEditor(f.run, 0, fixture.candidates), /Wait/)
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'export'), /already running/)
    release(); await pending
    assert.equal((await f.main.openEditor(f.run)).operation, null)
    f.main.settings.savePublicSettings({ outputDirectory: f.library, pythonPath: 'python3', jevEnabled: 'off' })
    f.main.settings.replaceApiKey('openrouterApiKey', '')
    await assert.rejects(f.main.runEditor(f.run, 0, 'candidate-1', 'review'), /OpenRouter key/)
  } finally { f.cleanup() }
})

test('caption suppression validates source intervals and changes render state without changing review evidence', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  assert.deepEqual(c.caption_suppression_ranges, [])
  const ranges = [[0, 2000], [4000, 7000], [11000, 12000]]
  const next = schema.refineEdit({ ...c, status: 'ready' }, { caption_suppression_ranges: ranges })
  assert.equal(next.status, 'refining')
  assert.equal(schema.editSignature(next), schema.editSignature(c))
  assert.deepEqual(schema.parseCandidateEdit(next, 12000).caption_suppression_ranges, ranges)
  for (const value of [null, 'bad', [[0]], [[0, 100, 200]], [[-1, 1000]], [[0, 12001]], [[0, 99]],
    [[1000, 1000]], [[2000, 3000], [1000, 2000]], [[0, 2000], [1000, 3000]], [[NaN, 1000]],
    [[0, Infinity]], [[true, 1000]], Array.from({ length: 201 }, (_, i) => [i * 100, i * 100 + 100])]) {
    assert.throws(() => schema.parseCandidateEdit({ ...c, caption_suppression_ranges: value }, 12000))
  }
})

test('caption suppression persists per candidate through save and reopen without modifying text or cuts', async () => {
  const f = setup()
  try {
    const opened = await f.main.openEditor(f.run)
    const c = opened.project.candidates[0]
    c.caption_suppression_ranges = [[2000, 4000], [6000, 9000]]
    await f.main.saveEditor(f.run, 0, opened.project.candidates)
    const saved = (await f.reload().openEditor(f.run)).project
    assert.deepEqual(saved.candidates[0].caption_suppression_ranges, c.caption_suppression_ranges)
    assert.deepEqual(saved.candidates[1].caption_suppression_ranges, [])
    assert.deepEqual(saved.candidates[0].ranges, c.ranges)
    assert.deepEqual(saved.transcript, opened.project.transcript)
    assert.deepEqual(saved.candidates[0].review, c.review)
  } finally { f.cleanup() }
})


test('older main-process sessions and empty caption suppression have the same render identity', () => {
  const c = schema.parseEditorProject(clone()).candidates[0]
  const legacy = { ...c }
  delete legacy.caption_suppression_ranges
  assert.deepEqual(schema.candidateEdit(legacy).caption_suppression_ranges, [])
  assert.equal(schema.renderEditKey(legacy), schema.renderEditKey(c))
  assert.equal(schema.refineEdit({ ...legacy, status: 'ready' }, { caption_suppression_ranges: [] }).status, 'ready')
  assert.equal(schema.refineEdit({ ...legacy, status: 'ready' }, { caption_suppression_ranges: [[1000, 2000]] }).status, 'refining')
})


test('additional caption-free sections use available retained footage without replacing previous ranges', () => {
  const { nextCaptionRange } = loadMain("export * from './src/renderer/lib/caption-ranges'")
  const cuts = [[2000, 5000], [7000, 10000]]
  const ranges = [[3000, 4500]]
  assert.deepEqual(nextCaptionRange(ranges, cuts, 3500), [4500, 5000])
  assert.deepEqual(nextCaptionRange(ranges, cuts, 5500), [7000, 9000])
  assert.deepEqual(nextCaptionRange(ranges, cuts, 11000), [2000, 3000])
  assert.deepEqual(nextCaptionRange([[0, 6000]], cuts, 3500), [7000, 9000])
  assert.deepEqual(nextCaptionRange([[3000, 4500], [4500, 5000]], cuts, 4500), [7000, 9000])
  assert.equal(nextCaptionRange([[0, 12000]], cuts, 3500), null)
  assert.equal(nextCaptionRange([[2000, 4950], [7000, 10000]], cuts, 4000), null)
  assert.deepEqual(ranges, [[3000, 4500]])
})

function batchSetup() {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const workers = []
  const f = setup({ child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      const config = JSON.parse(data)
      workers.push({ config, write: (data) => child.stdout.write(data), close: (code) => child.emit('close', code), finish(ok = true) {
        if (ok) {
          const file = path.join(f.run, 'editor-project.json')
          const project = JSON.parse(fs.readFileSync(file))
          assert.equal(config.revision, project.revision)
          const candidate = project.candidates.find(c => c.id === config.candidate_id)
          assert.equal(candidate.status, 'ready')
          candidate.status = 'baked'; candidate.exports.push(project.revision)
          project.revision++
          fs.writeFileSync(file, JSON.stringify(project))
        }
        child.stdout.write(JSON.stringify({ ok })); child.emit('close', ok ? 0 : 1)
      } })
    }
    return child
  } } })
  const project = schema.parseEditorProject(clone())
  project.candidates = ['refining', 'ready', 'baked', 'discarded', 'ready'].map((status, i) => ({
    ...structuredClone(project.candidates[0]), id: `candidate-${i}`, status,
    captions: i !== 4, caption_suppression_ranges: i === 1 ? [[2000, 3000], [7000, 9000]] : []
  }))
  fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
  return { ...f, workers }
}
const nextWorker = async (workers, count) => {
  const deadline = Date.now() + 5000
  while (workers.length < count && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
  assert.equal(workers.length, count)
  return workers[count - 1]
}

test('batch bakes only ready clips sequentially, keeps caption settings, revisions and project lock', async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, 'candidate-0', 'export-all')
    const first = await nextWorker(f.workers, 1)
    assert.equal(first.config.candidate_id, 'candidate-1')
    assert.equal(first.config.action, 'export')
    assert.deepEqual((await f.main.openEditor(f.run)).batch, { completed: 0, total: 2 })
    await assert.rejects(f.main.saveEditor(f.run, 0, []), /Wait/)
    await assert.rejects(f.main.runEditor(f.run, 0, '', 'export-all'), /already running/)
    first.finish()
    const second = await nextWorker(f.workers, 2)
    assert.equal(second.config.candidate_id, 'candidate-4')
    assert.equal(second.config.revision, 1)
    const reopened = await f.main.openEditor(f.run)
    assert.equal(reopened.operation, 'export-all')
    assert.deepEqual(reopened.batch, { completed: 1, total: 2 })
    assert.equal(reopened.project.candidates[4].captions, false)
    assert.deepEqual(reopened.project.candidates[1].caption_suppression_ranges, [[2000, 3000], [7000, 9000]])
    second.finish()
    const done = await pending
    assert.equal(done.operation, null)
    assert.equal(done.project.revision, 2)
    assert.deepEqual(done.project.candidates.map(c => c.status), ['refining', 'baked', 'baked', 'discarded', 'baked'])
    await assert.rejects(f.main.runEditor(f.run, 2, '', 'export-all'), /at least one clip ready/)
    await assert.rejects(f.main.runEditor(f.run, 0, '', 'export-all'), /changed/)
    assert.equal(f.workers.length, 2)
  } finally { f.cleanup() }
})

for (const cancelled of [false, true]) test(`batch ${cancelled ? 'cancellation' : 'failure'} preserves completed exports and leaves unfinished clips ready`, async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, '', 'export-all')
    const rejected = assert.rejects(pending, cancelled ? /Baked 1 of 2.*cancelled/ : /Baked 1 of 2 ready clips\. Could not bake “[^”]+”: Export stopped or failed.*still ready/)
    ;(await nextWorker(f.workers, 1)).finish()
    const second = await nextWorker(f.workers, 2)
    if (cancelled) f.main.cancelEditor(f.run)
    second.finish(false)
    await rejected
    const reopened = await f.main.openEditor(f.run)
    assert.equal(reopened.operation, null)
    assert.equal(reopened.project.candidates[1].status, 'baked')
    assert.equal(reopened.project.candidates[4].status, 'ready')
    const retry = f.main.runEditor(f.run, 1, '', 'export-all')
    const remaining = await nextWorker(f.workers, 3)
    assert.equal(remaining.config.candidate_id, 'candidate-4')
    remaining.finish()
    await retry
  } finally { f.cleanup() }
})

test('cancelling between batch clips never starts the next worker', async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, '', 'export-all')
    const rejected = assert.rejects(pending, /Baked 1 of 2.*cancelled/)
    ;(await nextWorker(f.workers, 1)).finish()
    f.main.cancelEditor(f.run)
    await rejected
    assert.equal(f.workers.length, 1)
    assert.equal((await f.main.openEditor(f.run)).project.candidates[4].status, 'ready')
  } finally { f.cleanup() }
})

test('source generations cannot supply arbitrary media paths', () => {
  for (const source_id of ['../private', '/outside', 'a'.repeat(31), 123, null]) {
    assert.throws(() => schema.parseEditorProject({ ...clone(), source_id }))
  }
  assert.equal(schema.parseEditorProject({ ...clone(), source_id: 'a'.repeat(32) }).source_id, 'a'.repeat(32))
})

for (const outcome of ['success', 'failure', 'cancelled', 'committed-before-exit']) test(`source replacement ${outcome} preserves the correct media pair and edits`, async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  let complete, config, started
  const entered = new Promise(r => { started = r })
  const f = setup({ child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = data => {
      config = JSON.parse(data)
      complete = () => {
        const preview = path.join(f.run, `editor-preview-${config.source_id}.mp4`)
        fs.writeFileSync(preview, 'new preview')
        if (outcome === 'success' || outcome === 'committed-before-exit') {
          const project = JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json')))
          project.source_id = config.source_id; project.revision++; project.width = 3840; project.height = 2160
          fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
        }
        child.stdout.write(JSON.stringify({ ok: outcome === 'success', error: outcome === 'failure' ? 'duration' : undefined }))
        child.emit('close', outcome === 'success' ? 0 : 1)
      }
      started()
    }
    return child
  } } })
  try {
    const replacement = path.join(f.dir, 'higher-quality.mp4')
    fs.writeFileSync(replacement, 'higher resolution source')
    await assert.rejects(f.main.replaceEditorSource(f.run, 0, replacement), /outside/)
    f.main.authorizeMedia(replacement)
    await assert.rejects(f.main.replaceEditorSource(f.run, 999, replacement), /changed/)
    await assert.rejects(f.main.runEditor(f.run, 0, '', 'replace-source'), /Invalid/)
    const pending = f.main.replaceEditorSource(f.run, 0, replacement)
    const result = outcome === 'success' ? pending : assert.rejects(pending, outcome === 'failure' ? /different duration/ : outcome === 'cancelled' ? /replacement cancelled\. The previous source is still in use/ : /replacement stopped/)
    await entered
    assert.equal(config.action, 'replace-source')
    assert.equal(fs.readFileSync(path.join(f.run, `editor-source-${config.source_id}.mp4`), 'utf8'), 'higher resolution source')
    assert.equal((await f.main.openEditor(f.run)).operation, 'replace-source')
    assert.equal((await f.main.openEditor(f.run)).sourcePath, fs.realpathSync(path.join(f.run, 'editor-source.mp4')))
    await assert.rejects(f.main.saveEditor(f.run, 0, fixture.candidates), /Wait/)
    await assert.rejects(f.main.replaceEditorSource(f.run, 0, replacement), /already running/)
    if (outcome === 'cancelled') f.main.cancelEditor(f.run)
    complete(); await result
    const reopened = await f.main.openEditor(f.run)
    assert.equal(reopened.operation, null)
    const committed = ['success', 'committed-before-exit'].includes(outcome)
    assert.equal(reopened.project.source_id, committed ? config.source_id : undefined)
    assert.equal(fs.existsSync(path.join(f.run, 'editor-source.mp4')), !committed)
    assert.equal(fs.existsSync(path.join(f.run, `editor-source-${config.source_id}.mp4`)), committed)
    assert.equal(fs.existsSync(path.join(f.run, `editor-preview-${config.source_id}.mp4`)), committed)
    const saved = await f.main.saveEditor(f.run, reopened.project.revision, reopened.project.candidates)
    assert.equal(saved.project.source_id, reopened.project.source_id)
    assert.deepEqual(saved.project.candidates, reopened.project.candidates)
    assert.equal(fs.readFileSync(replacement, 'utf8'), 'higher resolution source')
  } finally { f.cleanup() }
})

test('camera markers retain exact frame times and dismissals do not invalidate baked clips or reviews', () => {
  const p = clone(), c = p.candidates[0]
  c.status = 'baked'
  c.camera_scan = { start_ms: 1000, end_ms: 12000, frames: [1001, 1042.708, 1084.417, 2002, 2043.708], markers: [{ at_ms: 1042.708, score: .1 }, { at_ms: 2002, score: .04 }] }
  c.scenes[1].at_ms = 1042.708
  p.preview_id = 'a'.repeat(32); p.frame_preview = true
  const parsed = schema.parseEditorProject(p)
  assert.equal(parsed.candidates[0].scenes[1].at_ms, 1042.708)
  assert.deepEqual(parsed.candidates[0].camera_scan, c.camera_scan)
  const before = schema.renderEditKey(c), signature = schema.editSignature(c)
  const dismissed = schema.refineEdit(c, { dismissed_camera_markers: [1042.708] })
  assert.equal(dismissed.status, 'baked')
  assert.equal(schema.renderEditKey(dismissed), before)
  assert.equal(schema.editSignature(dismissed), signature)
  assert.equal(schema.cameraMarkers(c, .08).length, 1)
  assert.equal(schema.cameraMarkers(dismissed, .08).length, 0)
  assert.equal(schema.cameraMarkers(dismissed, .025).length, 1)
  assert.ok(!schema.candidateEdit(c).camera_scan)
  for (const mutate of [p => { p.preview_id = '../outside' }, p => { p.candidates[0].camera_scan.frames = [1001, 1001] },
    p => { p.candidates[0].camera_scan.markers[0].at_ms = 1100 }, p => { p.candidates[0].camera_scan.markers[0].score = NaN },
    p => { p.candidates[0].dismissed_camera_markers = [-1] }]) {
    const bad = structuredClone(p); mutate(bad); assert.throws(() => schema.parseEditorProject(bad))
  }
})

test('frame stepping and layout snapping use presentation timestamps including variable frame durations', () => {
  const frames = [0, 41.708, 83.417, 125.125, 208.542, 250.25]
  assert.equal(schema.stepFrame(frames, 83.417, -1), 41.708)
  assert.equal(schema.stepFrame(frames, 83.416999, 1), 125.125)
  assert.equal(schema.stepFrame(frames, 170, -1), 125.125)
  assert.equal(schema.stepFrame(frames, 170, 1), 208.542)
  assert.equal(schema.snapFrame(frames, 202), 208.542)
  assert.equal(schema.snapFrame(frames, 900), 900)
  const scenes = [{ at_ms: 0, layout: 'fit', crops: [[0, 0, 1, 1]] }, { at_ms: 125.125, layout: 'fit', crops: [[0, 0, 1, 1]] }]
  assert.equal(schema.retimeScene(scenes, 1, 202, 1000, frames)[1].at_ms, 208.542)
  assert.equal(schema.retimeScene(scenes, 1, 0, 1000, frames), scenes)
})

test('frame navigation can cross scan edges and recover in either direction', () => {
  const frames = [1000, 1041.708, 1083.417, 1125.125]
  const step = 1000 / 30
  assert.equal(schema.stepFrame(frames, 1000, -1), 1000 - step)
  assert.equal(schema.stepFrame(frames, 1125.125, 1), 1125.125 + step)
  assert.equal(schema.stepFrame(frames, 900, 1), 900 + step)
  assert.equal(schema.stepFrame(frames, 1200, -1), 1200 - step)
  assert.equal(schema.stepFrame(frames, 990, 1), 1000, 're-enter at the first known frame')
  assert.equal(schema.stepFrame(frames, 1140, -1), 1125.125, 're-enter at the last known frame')
  assert.equal(schema.stepFrame(frames, 1125.126, -1), 1083.417, 'browser timestamp noise must not trap the playhead')
  assert.equal(schema.stepFrame([], 3000, -1), 3000 - step)
})

test('saved camera dismissals persist while scan results and preview paths stay main-owned', async () => {
  const f = setup()
  try {
    const p = clone(), c = p.candidates[0]
    c.status = 'baked'
    c.camera_scan = { start_ms: 0, end_ms: 12000, frames: [0, 1001, 1042.708], markers: [{ at_ms: 1042.708, score: .3 }] }
    p.preview_id = 'b'.repeat(32); p.frame_preview = true
    fs.writeFileSync(path.join(f.run, `editor-preview-${p.preview_id}.mp4`), 'precise preview')
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(p))
    const opened = await f.main.openEditor(f.run)
    assert.ok(opened.previewPath.endsWith(`editor-preview-${p.preview_id}.mp4`))
    const edits = structuredClone(opened.project.candidates)
    edits[0].dismissed_camera_markers = [1042.708]
    edits[0].camera_scan = { arbitrary: 'forged' }
    const saved = await f.main.saveEditor(f.run, opened.project.revision, edits)
    assert.deepEqual(saved.project.candidates[0].camera_scan, c.camera_scan)
    assert.equal(saved.project.candidates[0].status, 'baked')
    assert.deepEqual((await f.reload().openEditor(f.run)).project.candidates[0].dismissed_camera_markers, [1042.708])
  } finally { f.cleanup() }
})

test('camera scan locks edits, needs no provider key, and cancellation cleans only the uncommitted preview', async () => {
  const f = batchSetup()
  try {
    const before = fs.readFileSync(path.join(f.run, 'editor-project.json'), 'utf8')
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'scan-cameras')
    const rejected = assert.rejects(pending, /Camera scan cancelled\. Your edits and previous markers are saved/)
    const worker = await nextWorker(f.workers, 1)
    assert.equal(worker.config.action, 'scan-cameras')
    assert.match(worker.config.preview_id, /^[a-f0-9]{32}$/)
    assert.equal((await f.main.openEditor(f.run)).operation, 'scan-cameras')
    await assert.rejects(f.main.saveEditor(f.run, 0, []), /Wait/)
    const pendingPreview = path.join(f.run, `editor-preview-${worker.config.preview_id}.mp4.partial.mp4`)
    fs.writeFileSync(pendingPreview, 'partial')
    f.main.cancelEditor(f.run); worker.finish(false); await rejected
    assert.equal(fs.readFileSync(path.join(f.run, 'editor-project.json'), 'utf8'), before)
    assert.equal(fs.existsSync(pendingPreview), false)
    assert.equal(fs.existsSync(path.join(f.run, 'editor-preview.mp4')), true)
    assert.equal((await f.main.openEditor(f.run)).operation, null)
  } finally { f.cleanup() }
})


test('camera progress streams across chunks, reconnects, stays monotonic, and clears on completion', async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'scan-cameras')
    const worker = await nextWorker(f.workers, 1)
    const progress = async () => (await f.main.openEditor(f.run)).progress
    assert.deepEqual(await progress(), { phase: 'scan', percent: 0 })
    worker.write('{"type":"progress","phase":"scan","per')
    assert.equal((await progress()).percent, 0)
    worker.write('cent":43}\n{"type":"progress","phase":"scan","percent":60}\n')
    assert.deepEqual(await progress(), { phase: 'scan', percent: 60 })
    for (const percent of [20, -1, 101, '90', null]) worker.write(JSON.stringify({ type: 'progress', phase: 'scan', percent }) + '\n')
    assert.equal((await progress()).percent, 60)
    worker.write('{"type":"progress","phase":"preview","percent":0}\n')
    worker.write('{"type":"progress","phase":"scan","percent":100}\n')
    worker.write('{"type":"progress","phase":"preview","percent":24}\n')
    assert.deepEqual(await progress(), { phase: 'preview', percent: 24 })
    worker.write('{"ok":true}\n'); worker.close(0)
    await pending
    assert.equal(await progress(), undefined)
  } finally { f.cleanup() }
})

for (const output of ['malformed\n', 'x'.repeat(16385)]) test('invalid editor progress protocol fails safely: ' + output.length, async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'scan-cameras')
    const rejected = assert.rejects(pending, /Camera scan stopped/)
    const worker = await nextWorker(f.workers, 1)
    worker.write(output); worker.write('\n{"ok":true}\n'); worker.close(0)
    await rejected
    assert.equal((await f.main.openEditor(f.run)).progress, undefined)
  } finally { f.cleanup() }
})

test('one failed clip does not stop "Bake all"; the report names it and it stays ready', async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, '', 'export-all')
    const rejected = assert.rejects(pending, (error) => {
      assert.match(error.message, /^Baked 1 of 2 ready clips\. Could not bake “The result”: /)
      assert.doesNotMatch(error.message, /System check/)
      assert.match(error.message, /still ready/)
      return true
    })
    ;(await nextWorker(f.workers, 1)).finish(false)
    const second = await nextWorker(f.workers, 2)
    assert.deepEqual((await f.main.openEditor(f.run)).batch, { completed: 0, total: 2, failed: 1 })
    second.finish()
    await rejected
    const reopened = await f.main.openEditor(f.run)
    assert.deepEqual(reopened.project.candidates.map(c => c.status), ['refining', 'ready', 'baked', 'discarded', 'baked'])
  } finally { f.cleanup() }
})

test('worker failures map fixed codes to specific messages and log only a redacted stderr tail', async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  let spawned
  const f = setup({ child_process: { ...require('node:child_process'), spawn: (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    spawned = { command, args, options, child }
    return child
  } } })
  try {
    const project = JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json')))
    project.candidates[0].status = 'ready'
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
    for (const [code, expected] of [['render_failed', /^Rendering failed\. Your edits are saved\..*Show Logs/], ['source_missing', /Replace source/],
      ['engine_unavailable', /System check/], ['/private/forged', /^Export stopped or failed\. Your edits are saved/]]) {
      const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'export')
      const deadline = Date.now() + 5000
      while (!spawned && Date.now() < deadline) await new Promise(r => setTimeout(r, 5))
      const { child, options } = spawned; spawned = undefined
      assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1')
      child.stderr.write('2026-09-28 10:00:00,000 - editor_runner - ERROR - Editor export failed (render_failed)\n')
      child.stderr.write("RenderingError: Error opening /Users/someone/Movies/clip.mp4 api_key=sk-or-v1-abcdef123456 https://example.com/x\nNo such filter: 'perspective'\n") // gitleaks:allow -- synthetic credential exercises log redaction
      child.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n'); child.emit('close', 1, null)
      const error = await pending.then(() => null, (e) => e)
      assert.match(error.message, expected)
      if (code !== 'engine_unavailable') assert.doesNotMatch(error.message, /System check/)
    }
    const log = fs.readFileSync(path.join(f.dir, 'logs', 'bridgeclip.log'), 'utf8')
    assert.match(log, /"code":"render_failed"/)
    assert.match(log, /No such filter: 'perspective'/)
    assert.doesNotMatch(log, /someone|sk-or|example\.com/)
  } finally { f.cleanup() }
})

test('progress summaries report counts without the project and refresh when the file changes', async () => {
  const f = setup()
  try {
    const first = await f.main.readEditorProgress(f.run)
    assert.deepEqual({ ...first, previewPath: path.basename(first.previewPath) }, {
      total: 2, remaining: 2, initialCandidate: 0, counts: { refining: 2, ready: 0, baked: 0, discarded: 0 },
      previewPath: 'editor-preview.mp4', thumbnailMs: fixture.candidates[0].ranges[0][0], mediaFreed: false,
      previewStartMs: 0, previewEndMs: 12000, operation: null })
    assert.equal(JSON.stringify(first).includes('transcript'), false)
    const project = (await f.main.openEditor(f.run)).project
    project.candidates[0].status = 'discarded'
    await f.main.saveEditor(f.run, 0, project.candidates)
    const second = await f.main.readEditorProgress(f.run)
    assert.deepEqual([second.remaining, second.initialCandidate, second.counts.discarded], [1, 1, 1])
    await assert.rejects(f.main.readEditorProgress(path.join(f.dir, 'elsewhere')), /./)
  } finally { f.cleanup() }
})

test('idle editor runs sweep temporary folders and unreferenced media, never the active pair', async () => {
  const f = setup()
  try {
    const stale = ['.editor-export-abc/clip.mp4', '.editor-review-x/frame.jpg', `.editor-${'1'.repeat(8)}.tmp`,
      `editor-source-${'a'.repeat(32)}.mp4`, `editor-preview-${'b'.repeat(32)}.mp4.partial.mp4`, 'editor-preview.mp4.partial.mp4']
    for (const file of stale) { fs.mkdirSync(path.dirname(path.join(f.run, file)), { recursive: true }); fs.writeFileSync(path.join(f.run, file), 'x') }
    fs.writeFileSync(path.join(f.run, 'clip_00.mp4'), 'export')
    fs.writeFileSync(path.join(f.run, 'editor-notes.mp4'), 'unrelated')
    await f.main.openEditor(f.run)
    const left = fs.readdirSync(f.run).sort()
    assert.deepEqual(left, ['clip_00.mp4', 'editor-notes.mp4', 'editor-preview.mp4', 'editor-project.json', 'editor-source.mp4', 'job_output.json'])
  } finally { f.cleanup() }
})

test('undoing "Refine again" can restore Baked only for the exact baked render', async () => {
  const f = setup()
  try {
    const project = JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json')))
    Object.assign(project.candidates[0], { status: 'baked', exports: [0] })
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
    const baked = (await f.main.openEditor(f.run)).project.candidates
    const refining = structuredClone(baked); refining[0].status = 'refining'
    let saved = await f.main.saveEditor(f.run, 0, refining)
    assert.match(saved.project.candidates[0].baked_hash, /^[a-f0-9]{64}$/)
    const changed = structuredClone(refining); changed[0].title = 'Different'; changed[0].status = 'baked'
    await assert.rejects(f.main.saveEditor(f.run, 1, changed), /completed render/)
    saved = await f.main.saveEditor(f.run, 1, baked)
    assert.equal(saved.project.candidates[0].status, 'baked')
    assert.equal(saved.project.candidates[0].baked_hash, undefined)
  } finally { f.cleanup() }
})

test('editor media can be freed only when nothing is left to finish, and the project becomes read-only', async () => {
  const f = setup()
  try {
    await assert.rejects(f.main.freeEditorMedia(f.run, 0), /Bake or discard every clip/)
    const project = JSON.parse(fs.readFileSync(path.join(f.run, 'editor-project.json')))
    project.candidates[0].status = 'discarded'; Object.assign(project.candidates[1], { status: 'baked', exports: [0] })
    fs.writeFileSync(path.join(f.run, 'editor-project.json'), JSON.stringify(project))
    assert.equal((await f.main.openEditor(f.run)).mediaBytes, 10)
    await assert.rejects(f.main.freeEditorMedia(f.run, 7), /changed/)
    const freed = await f.main.freeEditorMedia(f.run, 0)
    assert.equal(freed.project.media_freed, true)
    assert.deepEqual([freed.sourcePath, freed.previewPath], ['', ''])
    assert.equal(fs.existsSync(path.join(f.run, 'editor-source.mp4')) || fs.existsSync(path.join(f.run, 'editor-preview.mp4')), false)
    assert.equal((await f.main.readEditorProgress(f.run)).previewPath, null)
    await assert.rejects(f.main.saveEditor(f.run, 1, freed.project.candidates), /read-only/)
    await assert.rejects(f.main.runEditor(f.run, 1, 'candidate-2', 'export'), /read-only/)
  } finally { f.cleanup() }
})

// A finished automatic run: clips on disk, but no editor project and no source kept.
function importSetup(sourceUrl = 'https://youtu.be/dQw4w9WgXcQ') {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const temp = tempDir('bridgeclip-import-')
  const library = path.join(temp.dir, 'library'), run = path.join(library, 'auto-run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({
    job_id: 'auto-run', source_video_url: sourceUrl, clips: [{ clip_index: 0, s3_url: `file:///${run.replace(/\\/g, '/')}/clip_00.mp4`,
      duration_ms: 5000, start_time_ms: 1000, end_time_ms: 6000, virality_score: .8, layout_type: 'talking_head', summary: 'First', tags: [] }], metrics: {}
  }))
  let config
  // Mimic the engine: the import commits a project, flips the flag, and leaves both media files.
  const worker = { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      config = JSON.parse(data)
      if (!fs.existsSync(path.join(run, 'editor-source.mp4'))) fs.writeFileSync(path.join(run, 'editor-source.mp4'), 'downloaded')
      fs.writeFileSync(path.join(run, 'editor-preview.mp4'), 'preview')
      fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(fixture))
      const out = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json')))
      out.editor_project = true; fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(out))
      child.stdout.write('{"ok":true}'); setImmediate(() => child.emit('close', 0))
    }
    return child
  } }
  const mocks = { electron: fakeElectron(temp.dir).electron, child_process: worker }
  const source = "export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'; export { authorizeMedia } from './src/main/security'"
  const main = loadMain(source, mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  return { ...temp, run, library, main, get config() { return config }, reload: () => loadMain(source, mocks) }
}

test('importing an automatic run re-downloads a web source and commits the editor project', async () => {
  const f = importSetup()
  try {
    assert.equal(f.main.editorBusy(f.run), false)
    const session = await f.main.createEditorProject(f.run)
    assert.equal(f.config.action, 'create-project')
    assert.equal(f.config.source.kind, 'url')
    assert.equal(f.config.source.url, 'https://youtu.be/dQw4w9WgXcQ')
    assert.equal(session.project.candidates.length, fixture.candidates.length)
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.run, 'job_output.json'))).editor_project, true)
    assert.equal(f.main.editorBusy(f.run), false)
  } finally { f.cleanup() }
})

test('importing a run picked from disk streams the chosen file in as the editor source', async () => {
  const f = importSetup('C:\\someone\\private\\talk.mp4')
  try {
    // A local path is not re-downloadable: main asks the renderer for the file before spawning anything.
    await assert.rejects(f.main.createEditorProject(f.run), /__editor_needs_source__/)
    assert.equal(f.config, undefined)
    assert.equal(fs.existsSync(path.join(f.run, 'editor-project.json')), false)
    const picked = path.join(f.dir, 'talk.mp4'); fs.writeFileSync(picked, 'the original bytes')
    f.main.authorizeMedia(picked)
    const session = await f.main.createEditorProject(f.run, picked)
    assert.equal(f.config.source.kind, 'file')
    assert.equal(fs.readFileSync(path.join(f.run, 'editor-source.mp4'), 'utf8'), 'the original bytes')
    assert.ok(session.project)
  } finally { f.cleanup() }
})

test('import rejects a missing path, an already-imported run and a run without clips', async () => {
  const f = importSetup()
  try {
    await assert.rejects(f.main.createEditorProject(path.join(f.library, 'no-such-run')), /outside the library|ENOENT/)
  } finally { f.cleanup() }

  const already = importSetup()
  try {
    await already.main.createEditorProject(already.run)
    await assert.rejects(already.main.createEditorProject(already.run), /already has an editor project/)
  } finally { already.cleanup() }

  const empty = importSetup()
  try {
    fs.writeFileSync(path.join(empty.run, 'job_output.json'), JSON.stringify({ job_id: 'auto-run', source_video_url: 'https://youtu.be/dQw4w9WgXcQ', clips: [], metrics: {} }))
    await assert.rejects(empty.main.createEditorProject(empty.run), /no clips/)
  } finally { empty.cleanup() }
})

test('import keeps the run locked while the worker runs', async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const temp = tempDir('bridgeclip-import-')
  const library = path.join(temp.dir, 'library'), run = path.join(library, 'auto-run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({
    job_id: 'auto-run', source_video_url: 'https://youtu.be/dQw4w9WgXcQ', clips: [{ clip_index: 0, s3_url: `file:///${run.replace(/\\/g, '/')}/clip_00.mp4`,
      duration_ms: 5000, start_time_ms: 1000, end_time_ms: 6000, virality_score: .8, layout_type: 'talking_head', summary: 'First', tags: [] }], metrics: {} }))
  let release, entered
  const started = new Promise((r) => { entered = r })
  const mocks = { electron: fakeElectron(temp.dir).electron, child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = () => { entered(); release = () => { child.stdout.write('{"ok":true}'); child.emit('close', 0) } }
    return child
  } } }
  const main = loadMain("export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'", mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  try {
    const pending = main.createEditorProject(run)
    await started
    assert.equal(main.editorBusy(run), true)
    await assert.rejects(main.createEditorProject(run), /already running/)
    release()
    await assert.rejects(pending, /no editor project|Editor project is outside/) // this mock never commits the project
    assert.equal(main.editorBusy(run), false)
  } finally { temp.cleanup() }
})


test('a fast import\'s preview window parses, defaults to the whole source, and rejects nonsense', () => {
  const p = clone(); p.preview_start_ms = 4000; p.preview_end_ms = 9000
  const parsed = schema.parseEditorProject(p)
  assert.deepEqual(schema.previewWindow(parsed), { startMs: 4000, endMs: 9000 })
  assert.equal(schema.previewWindow(schema.parseEditorProject(clone())), null)
  const whole = clone(); whole.preview_start_ms = 0; whole.preview_end_ms = 12000
  assert.equal(schema.previewWindow(schema.parseEditorProject(whole)), null, 'a window over the whole source is not partial')
  for (const modify of [
    p2 => { p2.preview_start_ms = 4000 }, // one edge alone
    p2 => { p2.preview_start_ms = 4000; p2.preview_end_ms = 12001 }, // outside the source
    p2 => { p2.preview_start_ms = 5000; p2.preview_end_ms = 5050 }, // too short to scrub
    p2 => { p2.preview_start_ms = '4000'; p2.preview_end_ms = 9000 }
  ]) { const p2 = clone(); modify(p2); assert.throws(() => schema.parseEditorProject(p2)) }
})

test('import status turns worker progress into download bytes, rate and preview percent copy', () => {
  assert.deepEqual(schema.editorImportStatus(), { label: 'Preparing an editable copy from the original video…', percent: null })
  assert.deepEqual(schema.editorImportStatus({ phase: 'scan', percent: 50 }), { label: 'Downloading the original video', percent: 50 })
  assert.deepEqual(schema.editorImportStatus({ phase: 'scan', percent: 50, downloadedBytes: 1.2e9, totalBytes: 2.4e9, bytesPerSecond: 5e6 }),
    { label: 'Downloading the original video · 1.2 GB of 2.4 GB · 5.0 MB/s', percent: 50 })
  assert.deepEqual(schema.editorImportStatus({ phase: 'scan', percent: 0, downloadedBytes: 6e8, totalBytes: 2.4e9 }),
    { label: 'Downloading the original video · 600.0 MB of 2.4 GB', percent: 25 })
  assert.deepEqual(schema.editorImportStatus({ phase: 'preview', percent: 43 }), { label: 'Preparing the editable preview · 43%', percent: 43 })
})

test('importing for one reel passes the clip index through and validates it', async () => {
  const f = importSetup()
  try {
    const session = await f.main.createEditorProject(f.run, undefined, 0)
    assert.equal(f.config.action, 'create-project')
    assert.equal(f.config.focus_clip, 0)
    assert.ok(session.project)
  } finally { f.cleanup() }
  const bad = importSetup()
  try {
    // null means "no focus" like an absent mediaPath; nonsense values never spawn a worker.
    for (const focus of [-1, 1.5, '0']) await assert.rejects(bad.main.createEditorProject(bad.run, undefined, focus), /Invalid clip for this edit/)
    assert.equal(bad.config, undefined, 'nothing spawns before the clip index validates')
  } finally { bad.cleanup() }
})

test('import progress exposes download bytes and rate before the project exists', async () => {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const temp = tempDir('bridgeclip-import-progress-')
  const library = path.join(temp.dir, 'library'), run = path.join(library, 'auto-run')
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify({
    job_id: 'auto-run', source_video_url: 'https://youtu.be/dQw4w9WgXcQ', clips: [{ clip_index: 0, s3_url: `file:///${run.split(path.sep).join('/')}/clip_00.mp4`,
      duration_ms: 5000, start_time_ms: 1000, end_time_ms: 6000, virality_score: .8, layout_type: 'talking_head', summary: 'First', tags: [] }], metrics: {}
  }))
  const workers = []
  const mocks = { electron: fakeElectron(temp.dir).electron, child_process: { ...require('node:child_process'), spawn: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.end = (data) => {
      workers.push({ config: JSON.parse(data), write: (line) => child.stdout.write(line), close: (code) => child.emit('close', code) })
    }
    return child
  } } }
  const source = "export * from './src/main/clip-editor'; export * as settings from './src/main/settings-store'"
  const main = loadMain(source, mocks)
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3' })
  const settle = () => new Promise((r) => setTimeout(r, 10))
  try {
    const pending = main.createEditorProject(run, undefined, 0)
    while (!workers.length) await settle()
    const worker = workers[0]
    assert.equal(worker.config.focus_clip, 0)
    worker.write('{"type":"progress","phase":"scan","percent":10,"downloaded_bytes":240000000,"total_bytes":2400000000,"speed":8000000}\n')
    await settle()
    // The waiting screen polls this while the project JSON does not exist yet.
    const live = main.editorOperationProgress(run)
    assert.equal(live.operation, 'create-project')
    assert.deepEqual(live.progress, { phase: 'scan', percent: 10, downloadedBytes: 240000000, totalBytes: 2400000000, bytesPerSecond: 8000000 })
    // A negative rate is dropped; a regressing percent never rewinds the bar.
    worker.write('{"type":"progress","phase":"scan","percent":50,"downloaded_bytes":1200000000,"total_bytes":2400000000,"speed":-5}\n')
    worker.write('{"type":"progress","phase":"scan","percent":40}\n')
    await settle()
    assert.deepEqual(main.editorOperationProgress(run).progress, { phase: 'scan', percent: 50, downloadedBytes: 1200000000, totalBytes: 2400000000 })
    // Commit like the engine does, then report success.
    fs.writeFileSync(path.join(run, 'editor-source.mp4'), 'downloaded')
    fs.writeFileSync(path.join(run, 'editor-preview.mp4'), 'preview')
    fs.writeFileSync(path.join(run, 'editor-project.json'), JSON.stringify(fixture))
    const out = JSON.parse(fs.readFileSync(path.join(run, 'job_output.json')))
    out.editor_project = true; fs.writeFileSync(path.join(run, 'job_output.json'), JSON.stringify(out))
    worker.write('{"ok":true}\n'); worker.close(0)
    await pending
    assert.deepEqual(main.editorOperationProgress(run), { operation: null })
  } finally { temp.cleanup() }
})

test('"prepare full preview" runs the build-preview worker and swaps the preview pointer', async () => {
  const f = batchSetup()
  try {
    const pending = f.main.runEditor(f.run, 0, 'candidate-1', 'build-preview')
    const worker = await nextWorker(f.workers, 1)
    assert.equal(worker.config.action, 'build-preview')
    assert.equal(worker.config.revision, 0)
    assert.match(worker.config.preview_id, /^[a-f0-9]{32}$/)
    // The engine commits the upgraded preview pointer before reporting success.
    const file = path.join(f.run, 'editor-project.json')
    const project = JSON.parse(fs.readFileSync(file))
    project.preview_id = worker.config.preview_id; project.frame_preview = true; project.revision++
    delete project.preview_start_ms; delete project.preview_end_ms
    fs.writeFileSync(file, JSON.stringify(project))
    fs.writeFileSync(path.join(f.run, `editor-preview-${worker.config.preview_id}.mp4`), 'full preview')
    worker.write('{"ok":true}\n'); worker.close(0)
    const session = await pending
    assert.equal(session.project.frame_preview, true)
    assert.equal(session.project.preview_id, worker.config.preview_id)
    assert.equal(session.previewPath.endsWith(`editor-preview-${worker.config.preview_id}.mp4`), true)
  } finally { f.cleanup() }
})

test('a reel only plays when the fast preview window covers its whole cut', () => {
  const window = { startMs: 10000, endMs: 30000 }
  assert.equal(schema.previewCoversReel([[20000, 24000]], window), true)
  assert.equal(schema.previewCoversReel([[10000, 30000]], window), true, 'the window edges themselves count')
  assert.equal(schema.previewCoversReel([[1000, 6000]], window), false, 'a reel before the window')
  assert.equal(schema.previewCoversReel([[25000, 32000]], window), false, 'a reel past the window')
  assert.equal(schema.previewCoversReel([[20000, 24000], [26000, 31000]], window), false, 'a later cut past the window')
  assert.equal(schema.previewCoversReel([[1000, 6000]], null), true, 'a full-source preview covers everything')
  assert.equal(schema.previewCoversReel([], window), true)
})

test('the engine framing verdict survives project reloads; anything else is stripped', () => {
  for (const value of ['tracked', 'centered']) {
    const p = clone()
    p.candidates[0].framing = value
    assert.equal(schema.parseEditorProject(p).candidates[0].framing, value)
  }
  const p = clone()
  p.candidates[0].framing = 'magic'
  p.candidates[1].framing = 7
  const parsed = schema.parseEditorProject(p)
  assert.equal('framing' in parsed.candidates[0], false)
  assert.equal('framing' in parsed.candidates[1], false)
  // A UI save never carries the verdict back in: it is engine-owned.
  const edit = schema.parseCandidateEdit(schema.candidateEdit(parsed.candidates[1]), parsed.duration_ms, parsed.transcript.length)
  assert.equal('framing' in edit, false)
})

test('text-driven cutting subtracts transcript time from the kept ranges', () => {
  const ranges = [[1000, 6000], [10000, 15000]]
  // A middle cut splits a section; edge-touching cuts trim it.
  assert.deepEqual(schema.cutRanges(ranges, 3000, 4000), [[1000, 3000], [4000, 6000], [10000, 15000]])
  assert.deepEqual(schema.cutRanges(ranges, 1000, 2000), [[2000, 6000], [10000, 15000]])
  assert.deepEqual(schema.cutRanges(ranges, 14000, 15000), [[1000, 6000], [10000, 14000]])
  assert.deepEqual(schema.cutRanges(ranges, 6000, 10000), ranges, 'a gap cut changes nothing')
  assert.deepEqual(schema.cutRanges(ranges, 0, 1000), ranges, 'cuts outside the clip are inert')
  assert.deepEqual(schema.cutRanges(ranges, 5000, 5000), ranges, 'an empty cut is inert')
  // Slivers the parser would reject are absorbed into the cut.
  assert.deepEqual(schema.cutRanges(ranges, 5950, 6050), [[1000, 5950], [10000, 15000]])
  assert.deepEqual(schema.cutRanges(ranges, 1000, 1050), [[1050, 6000], [10000, 15000]])
  assert.deepEqual(schema.cutRanges(ranges, 1050, 1090), [[1090, 6000], [10000, 15000]], 'a narrow interior cut drops only the sliver below the piece minimum')
  // Whole-line deletes that would empty the clip or burst the section cap are refused.
  assert.throws(() => schema.cutRanges([[1000, 2000]], 1000, 2000), /cannot become empty/)
  const many = Array.from({ length: 24 }, (_, i) => [i * 2000, i * 2000 + 1000])
  assert.throws(() => schema.cutRanges(many, 400, 600), /at most 24 sections/, 'splitting one of 24 sections would burst the cap')
  // Results always parse as a candidate.
  const c = schema.parseEditorProject(clone()).candidates[0]
  assert.doesNotThrow(() => schema.parseCandidateEdit({ ...c, ranges: schema.cutRanges(c.ranges, 4000, 5000) }, 12000, 4))
})

test('restore re-inserts cut text, skipping anything already covered', () => {
  const ranges = [[1000, 3000], [9000, 12000]]
  assert.deepEqual(schema.restoreRange(ranges, 3000, 9000, 20000), [[1000, 12000]], 'a fully cut span comes back as one piece')
  assert.deepEqual(schema.restoreRange(ranges, 0, 2000, 20000), [[0, 3000], [9000, 12000]])
  assert.equal(schema.restoreRange(ranges, 1000, 2500, 20000), ranges, 'already covered text restores nothing')
  assert.equal(schema.restoreRange(ranges, 15000, 16000, 12000), ranges, 'spans outside the source clamp to nothing new')
  const c = schema.parseEditorProject(clone()).candidates[0]
  assert.doesNotThrow(() => schema.parseCandidateEdit({ ...c, ranges: schema.restoreRange(c.ranges, 9000, 11000, 12000) }, 12000, 4))
})

test('transcript lines report kept, partial or cut against the clip, word-wise too', () => {
  const ranges = [[2000, 8000]]
  assert.equal(schema.lineCutState({ start_ms: 3000, end_ms: 7000 }, ranges), 'kept')
  assert.equal(schema.lineCutState({ start_ms: 0, end_ms: 9000 }, ranges), 'partial')
  assert.equal(schema.lineCutState({ start_ms: 9000, end_ms: 12000 }, ranges), 'cut')
  const words = [{ start_ms: 2000, end_ms: 3000, text: 'Keep' }, { start_ms: 9000, end_ms: 10000, text: 'Cut' }]
  assert.equal(schema.wordIsCut(words[0], ranges), false)
  assert.equal(schema.wordIsCut(words[1], ranges), true)
})

test('a word cut rewrites the burned caption; restoring cleans up only its own edit', () => {
  const words = [
    { start_ms: 1000, end_ms: 2000, text: 'Delete' }, { start_ms: 2000, end_ms: 3000, text: 'this' },
    { start_ms: 3000, end_ms: 4000, text: 'word' }, { start_ms: 4000, end_ms: 5000, text: 'please' }]
  const ranges = [[1000, 5000]]
  const mid = schema.cutWords(ranges, [], 7, words, 1, 2)
  assert.deepEqual(mid.ranges, [[1000, 2000], [4000, 5000]])
  assert.deepEqual(mid.caption_edits, [{ segment: 7, text: 'Delete please' }], 'kept words become the caption')
  // Restoring drops the auto caption exactly while it matches the kept text.
  const back = schema.restoreWords(mid.ranges, mid.caption_edits, 7, words, 5000)
  assert.deepEqual(back.ranges, ranges)
  assert.deepEqual(back.caption_edits, [])
  // A manually corrected caption is left alone when its span is already covered.
  const custom = [{ segment: 7, text: 'Custom words' }]
  assert.deepEqual(schema.restoreWords(ranges, custom, 7, words, 5000).caption_edits, custom, 'a covered restore no-ops and keeps the custom caption')
  // Cutting the whole line would empty the clip and is refused.
  assert.throws(() => schema.cutWords(ranges, mid.caption_edits, 7, words, 0, 3), /cannot become empty/)
  // Word-timed projects parse: valid words survive (words may be short), malformed ones reject.
  const p = clone(); p.transcript[0].words = [{ start_ms: 1000, end_ms: 2000, text: 'Hi' }]
  assert.deepEqual(schema.parseEditorProject(p).transcript[0].words, [{ start_ms: 1000, end_ms: 2000, text: 'Hi' }])
  assert.deepEqual(schema.parseEditorProject(clone()).transcript[0].words, undefined, 'wordless projects stay wordless')
  const empty = clone(); empty.transcript[0].words = []
  assert.deepEqual(schema.parseEditorProject(empty).transcript[0].words, [])
  for (const ws of ['x', [{ start_ms: 2000, end_ms: 1000, text: 'backwards' }], [{ start_ms: 0, end_ms: 120000, text: 'x' }], [{ start_ms: 0, end_ms: 50 }]]) {
    const bad = clone(); bad.transcript[0].words = ws
    assert.throws(() => schema.parseEditorProject(bad))
  }
})

test('the active speaker at the playhead feeds the preview chip', () => {
  const transcript = [{ start_ms: 0, end_ms: 4000, text: 'a', speaker: 'S1' }, { start_ms: 4000, end_ms: 8000, text: 'b' }]
  assert.equal(schema.speakerAt(transcript, 1000), 'S1')
  assert.equal(schema.speakerAt(transcript, 4000), undefined, 'an unlabeled line has no speaker')
  assert.equal(schema.speakerAt(transcript, 9000), undefined, 'silence between lines has no speaker')
})

test('audio library entries parse defensively and audio import failures map to clear messages', () => {
  const track = { id: 'a'.repeat(32), title: 'Song', duration_ms: 180000, origin: 'link', added_at: 5 }
  const parsed = schema.parseAudioTracks([track, null, 'nope', { id: 'bad', title: 'x', duration_ms: 1, origin: 'file', added_at: 1 },
    { ...track, id: 'b'.repeat(32), title: '' }, { ...track, title: 'y'.repeat(500) },
    { ...track, id: 'b'.repeat(32), title: 'Second', added_at: 9 }, { ...track, id: 'c'.repeat(32), duration_ms: 99999999 }])
  assert.deepEqual(parsed.map((t) => [t.id, t.title]), [['a'.repeat(32), 'Song'], ['b'.repeat(32), 'Second']])
  assert.deepEqual(schema.parseAudioTracks(Array.from({ length: 350 }, (_, i) =>
    ({ ...track, id: String(i).padStart(32, '0') }))).length, [300][0])
  assert.equal(schema.editorFailureMessage('import-audio', 'cancelled'), 'Audio import was cancelled.')
  assert.match(schema.editorFailureMessage('import-audio', 'source_missing'), /link could not be downloaded/)
  assert.match(schema.editorFailureMessage('import-audio', 'invalid'), /no usable audio/)
  assert.match(schema.editorFailureMessage('import-audio', 'render_failed'), /extract the audio/)
  assert.match(schema.editorFailureMessage('import-audio'), /Could not import the audio/)
})

function fakeAudioWorker(childPlan) {
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  const requests = []
  const state = { run: '', requests, progress: [] }
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough()
    child.stdin.on('data', (chunk) => {
      requests.push(JSON.parse(chunk))
      for (const line of childPlan(state)) child.stdout.write(line + '\n')
      child.emit('close', 0, null)
    })
    return child
  }
  return { state, spawn }
}

test('importing audio from a link extracts it, mirrors it into the library and returns the asset', async () => {
  const plan = (state) => {
    const asset = 'c'.repeat(32) + '.m4a'
    fs.writeFileSync(path.join(state.run, `editor-asset-${asset}`), 'extracted audio')
    state.progress.push(JSON.stringify({ type: 'progress', phase: 'audio', percent: 40 }))
    state.progress.push(JSON.stringify({ ok: true, asset, title: 'My Song', duration_ms: 180000 }))
    return state.progress
  }
  const { state, spawn } = fakeAudioWorker(plan)
  const f = setup({ child_process: { ...require('node:child_process'), spawn } })
  try {
    state.run = f.run
    const imported = await f.main.importEditorAudio(f.run, { kind: 'link', url: 'https://example.com/song' })
    assert.match(imported.asset, /^[a-f0-9]{32}\.m4a$/)
    assert.equal(imported.name, 'My Song')
    assert.equal(imported.durationMs, 180000)
    assert.deepEqual(state.requests, [{ run: f.run, library: f.library, action: 'import-audio',
      source: { kind: 'url', url: 'https://example.com/song' }, title: 'Imported audio' }])
    // The extracted asset stays in the run for the renderer to set as the clip's music…
    assert.equal(fs.readFileSync(path.join(f.run, `editor-asset-${imported.asset}`), 'utf8'), 'extracted audio')
    // …and is mirrored into the cross-project audio library.
    const stored = JSON.parse(fs.readFileSync(path.join(f.dir, 'userData', 'audio-library.json'), 'utf8'))
    assert.equal(stored.tracks.length, 1)
    assert.equal(stored.tracks[0].title, 'My Song')
    assert.equal(stored.tracks[0].origin, 'link')
    assert.equal(fs.readFileSync(path.join(f.dir, 'userData', 'audio-library', `${stored.tracks[0].id}.m4a`), 'utf8'), 'extracted audio')
  } finally { f.cleanup() }
})

test('importing audio from a picked file stages it into the run and cleans the staging copy', async () => {
  const plan = (state) => {
    const staged = state.requests[0].source.name
    assert.match(staged, /^editor-asset-[a-f0-9]{32}\.mp3$/)
    const asset = 'd'.repeat(32) + '.m4a'
    fs.writeFileSync(path.join(state.run, `editor-asset-${asset}`), 'extracted audio')
    return [JSON.stringify({ ok: true, asset, title: 'Stage Song', duration_ms: 42000 })]
  }
  const { state, spawn } = fakeAudioWorker(plan)
  const f = setup({ child_process: { ...require('node:child_process'), spawn } })
  try {
    state.run = f.run
    const picked = path.join(f.dir, 'picked', 'Episode 1.mp3')
    fs.mkdirSync(path.dirname(picked), { recursive: true })
    fs.writeFileSync(picked, 'mp3 bytes')
    f.main.authorizeMedia(picked)
    const imported = await f.main.importEditorAudio(f.run, { kind: 'file', path: picked })
    assert.equal(imported.name, 'Stage Song')
    assert.equal(imported.track.origin, 'file')
    assert.equal(fs.readdirSync(f.run).filter((n) => n.endsWith('.mp3')).length, 0, 'the staging copy is removed')
    assert.equal(fs.readFileSync(picked, 'utf8'), 'mp3 bytes', 'the picked file itself is untouched')
  } finally { f.cleanup() }
})

test('audio import validates the link and the project location before spawning a worker', async () => {
  let spawns = 0
  const f = setup({ child_process: { ...require('node:child_process'), spawn: () => { spawns++; throw new Error('must not spawn') } } })
  try {
    await assert.rejects(f.main.importEditorAudio(f.run, { kind: 'link', url: 'not a link' }), /Paste a valid/)
    await assert.rejects(f.main.importEditorAudio(f.run, { kind: 'link', url: 'https://x/' + 'a'.repeat(2100) }), /Paste a valid/)
    fs.mkdirSync(path.join(f.dir, 'elsewhere', 'run'), { recursive: true })
    await assert.rejects(f.main.importEditorAudio(path.join(f.dir, 'elsewhere', 'run'), { kind: 'link', url: 'https://example.com/s' }), /library/)
    assert.equal(spawns, 0)
  } finally { f.cleanup() }
})

test('a library track attaches to a project like a fresh upload', async () => {
  const f = setup()
  try {
    const track = { id: 'd'.repeat(32), title: 'Saved Song', duration_ms: 2000, origin: 'file', added_at: 1 }
    fs.mkdirSync(path.join(f.dir, 'userData', 'audio-library'), { recursive: true })
    fs.writeFileSync(path.join(f.dir, 'userData', 'audio-library', `${track.id}.m4a`), 'library bytes')
    fs.writeFileSync(path.join(f.dir, 'userData', 'audio-library.json'), JSON.stringify({ version: 1, tracks: [track] }))
    const attached = await f.main.attachEditorAudio(f.run, track.id)
    assert.match(attached.asset, /^[a-f0-9]{32}\.m4a$/)
    assert.equal(attached.name, 'Saved Song')
    assert.equal(fs.readFileSync(path.join(f.run, `editor-asset-${attached.asset}`), 'utf8'), 'library bytes')
    await assert.rejects(f.main.attachEditorAudio(f.run, 'e'.repeat(32)), /no longer in the library/)
    await assert.rejects(f.main.attachEditorAudio(f.run, 'garbage'), /no longer in the library/)
  } finally { f.cleanup() }
})

test('lower third presets round-trip, reject unknown styles and count as asset references', () => {
  const base = { text: 'Tanya', start_ms: 500, end_ms: 2500, position: 'bottom-left' }
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const parsed = schema.parseCandidateEdit({ ...overlay, text_overlays: [
    { ...base, preset: 'name-classic', variant: 'solid', sub: 'Creator of the year' },
    { ...base, preset: 'loc-ticker', variant: 'color', color: '#B3261E', text: 'Los Angeles' },
    { ...base, preset: 'loc-spotlight', variant: 'image', image: 'a'.repeat(32) + '.png' },
    base] }, 12000, 4)
  assert.equal(parsed.text_overlays.length, 4)
  assert.deepEqual(parsed.text_overlays[0], { ...base, preset: 'name-classic', variant: 'solid', sub: 'Creator of the year' })
  assert.equal(parsed.text_overlays[1].color, '#B3261E', 'the color variant keeps the exact hex')
  assert.equal(parsed.text_overlays[2].image, 'a'.repeat(32) + '.png')
  assert.equal(parsed.text_overlays[3].preset, undefined, 'plain cards stay plain')
  for (const patch of [{ preset: 'nope' }, { preset: 7 }, { preset: 'name-classic', variant: 'neon' },
    { preset: 'name-classic', color: 'red' }, { preset: 'name-classic', color: '#12345' },
    { preset: 'name-classic', image: 'nope.png' }, { preset: 'name-classic', sub: 'bad\u0000sub' },
    { preset: 'name-classic', sub: 42 }]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, text_overlays: [{ ...base, ...patch }] }, 12000, 4))
  }
  // A picture band's asset survives the sweep like every referenced upload.
  const project = schema.parseEditorProject(clone())
  project.candidates[0].text_overlays = [{ ...base, preset: 'loc-spotlight', variant: 'image', image: 'c'.repeat(32) + '.png' }]
  assert.ok(schema.assetRefs(project).includes('c'.repeat(32) + '.png'))
})

test('Motion Studio plans shots through the configured provider and enforces the caps', async () => {
  const studio = loadMain("export * from './src/main/motion-studio'", { electron: fakeElectron(tempDir('bridgeclip-motion-').dir).electron })
  const references = [{ asset: 'a'.repeat(32) + '.png', name: 'logo.png', kind: 'image' },
    { asset: 'b'.repeat(32) + '.m4a', name: 'bed.m4a', kind: 'audio' }]
  const good = JSON.stringify({ title: 'Brand intro', audio: true, shots: [
    { kind: 'title', text: 'Meet the product', duration_ms: 2000, motion: 'none' },
    { kind: 'still', asset: 'a'.repeat(32) + '.png', duration_ms: 4000, motion: 'zoom-in' }] })
  const calls = []
  const plan = await studio.planMotionShots({ idea: 'Brand intro', references, style: 'clean', lengthMs: 6000 },
    { chat: async (_settings, request) => { calls.push(request); return good } })
  assert.equal(plan.generator, 'ffmpeg-motion')
  assert.equal(plan.shots.length, 2)
  assert.equal(plan.shots[1].asset, 'a'.repeat(32) + '.png')
  assert.equal(plan.audio, true)
  assert.match(calls[0].messages[0].content, /1 to 8 shots/)
  assert.match(calls[0].messages[1].content, /logo\.png/)
  let attempts = 0
  await assert.rejects(studio.planMotionShots({ idea: 'x', references, style: 'auto', lengthMs: 6000 },
    { chat: async () => { attempts++; return 'not json' } }), /could not read/)
  assert.equal(attempts, 2, 'one stricter retry follows a malformed answer')
  const rogue = JSON.stringify({ title: 'x', audio: false, shots: [
    { kind: 'still', asset: 'f'.repeat(32) + '.png', duration_ms: 1000, motion: 'zoom-in' }] })
  await assert.rejects(studio.planMotionShots({ idea: 'x', references, style: 'auto', lengthMs: 6000 },
    { chat: async () => rogue }), /rules/)
})

test('Motion Studio renders a reviewed plan into a new asset for the b-roll track', async () => {
  const workerPlan = (state) => {
    const asset = 'f'.repeat(32) + '.mp4'
    fs.writeFileSync(path.join(state.run, `editor-asset-${asset}`), 'motion clip')
    state.progress.push(JSON.stringify({ type: 'progress', phase: 'motion', percent: 55 }))
    state.progress.push(JSON.stringify({ ok: true, asset, duration_ms: 6000 }))
    return state.progress
  }
  const { state, spawn } = fakeAudioWorker(workerPlan)
  const f = setup({ child_process: { ...require('node:child_process'), spawn } })
  try {
    state.run = f.run
    const shots = [
      { kind: 'title', text: 'Opener', duration_ms: 2000, motion: 'none' },
      { kind: 'still', asset: 'a'.repeat(32) + '.png', duration_ms: 4000, motion: 'zoom-in' }]
    const result = await f.main.renderMotionClip(f.run,
      { title: 'Intro', audio: false, generator: 'ffmpeg-motion', shots }, 'c'.repeat(32) + '.m4a')
    assert.equal(result.asset, 'f'.repeat(32) + '.mp4')
    assert.equal(result.durationMs, 6000)
    assert.equal(state.requests[0].action, 'motion-render')
    assert.deepEqual(state.requests[0].plan.shots, shots)
    assert.equal(state.requests[0].audio_asset, 'c'.repeat(32) + '.m4a')
    assert.equal(fs.readFileSync(path.join(f.run, `editor-asset-${result.asset}`), 'utf8'), 'motion clip')
    await assert.rejects(f.main.renderMotionClip(f.run, { title: 'x', audio: false, generator: 'ffmpeg-motion', shots: [] }), /1 to 8 shots/)
    await assert.rejects(f.main.renderMotionClip(f.run,
      { title: 'x', audio: false, generator: 'ffmpeg-motion', shots: [{ kind: 'title', text: 'x', duration_ms: 9000, motion: 'none' }] }), /0.5 to 8 seconds/)
  } finally { f.cleanup() }
})

test('speech enhancement sliders round-trip, reject out-of-range values and demote baked clips', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const parsed = schema.parseCandidateEdit({ ...overlay, speech_denoise: 0.4, speech_enhance: 0.9 }, 12000, 4)
  assert.equal(parsed.speech_denoise, 0.4)
  assert.equal(parsed.speech_enhance, 0.9)
  const plain = schema.parseCandidateEdit(overlay, 12000, 4)
  assert.equal(plain.speech_denoise, undefined)
  for (const patch of [{ speech_denoise: 1.5 }, { speech_enhance: -0.1 }, { speech_denoise: 'high' }]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, ...patch }, 12000, 4))
  }
  // A slider move is a content change: baked clips return to refining.
  const baked = { ...overlay, status: 'baked', exports: [0] }
  assert.equal(schema.refineEdit(baked, { speech_enhance: 0.5 }).status, 'refining')
})

test('Brand Vocabulary additions merge deduped into the saved settings', (t) => {
  const temp = tempDir('bridgeclip-vocab-')
  t.after(temp.cleanup)
  const store = loadMain("export * from './src/main/settings-store'", { electron: fakeElectron(temp.dir).electron })
  assert.deepEqual(store.addVocabularyTerm('  Grok   AI ').terms, ['Grok AI'])
  assert.deepEqual(store.addVocabularyTerm('grok ai').terms, ['Grok AI'], 'case-insensitive dedupe')
  assert.deepEqual(store.addVocabularyTerm('BridgeMind').terms, ['Grok AI', 'BridgeMind'])
  assert.throws(() => store.addVocabularyTerm('a b c d e f'), /five words/)
  assert.throws(() => store.addVocabularyTerm(42), /word/)
  const persisted = JSON.parse(fs.readFileSync(path.join(temp.dir, 'userData', 'settings.json'), 'utf8'))
  assert.equal(persisted.customVocabulary, 'Grok AI\nBridgeMind')
})

test('music fades round-trip and stay within five seconds per side', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const parsed = schema.parseCandidateEdit({ ...overlay, music: { asset: 'a'.repeat(32) + '.mp3', gain: .3, fade_in_ms: 2000, fade_out_ms: 4500 } }, 12000, 4)
  assert.deepEqual(parsed.music, { asset: 'a'.repeat(32) + '.mp3', gain: .3, fade_in_ms: 2000, fade_out_ms: 4500 })
  assert.equal(schema.parseCandidateEdit({ ...overlay, music: { asset: 'a'.repeat(32) + '.mp3', gain: .3 } }, 12000, 4).music.fade_in_ms, undefined)
  for (const patch of [{ fade_in_ms: 6000 }, { fade_out_ms: -1 }, { fade_in_ms: 'slow' }]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, music: { asset: 'a'.repeat(32) + '.mp3', gain: .3, ...patch } }, 12000, 4))
  }
})

test('range effects parse with caps, unique ids and a CSS preview mapping', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const edits = [
    { id: 'a'.repeat(32), kind: 'warm', intensity: .6, start_ms: 500, end_ms: 2500 },
    { id: 'b'.repeat(32), kind: 'blur', intensity: .8, start_ms: 3000, end_ms: 4000, region: [0, 0, 1, 1 / 3] }]
  const parsed = schema.parseCandidateEdit({ ...overlay, range_edits: edits }, 12000, 4)
  assert.deepEqual(parsed.range_edits, edits)
  const plain = schema.parseCandidateEdit(overlay, 12000, 4)
  assert.equal(plain.range_edits, undefined)
  for (const patch of [
    { range_edits: [{ ...edits[0], kind: 'explode' }] },
    { range_edits: [{ ...edits[0], id: 'short' }] },
    { range_edits: [{ ...edits[0], intensity: 0 }] },
    { range_edits: [{ ...edits[0], start_ms: 0, end_ms: 50 }] },
    { range_edits: [{ ...edits[0], region: [0, 0, .5, .5] }] },
    { range_edits: [edits[0], { ...edits[0] }] },
    { range_edits: Array.from({ length: 9 }, (_, i) => ({ ...edits[0], id: String(i).padStart(32, '0') })) }
  ]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, ...patch }, 12000, 4))
  }
  assert.equal(schema.rangeEffectPreview(edits, 1000), 'saturate(1.18) sepia(0.150)')
  assert.equal(schema.rangeEffectPreview(edits, 3500), '')
  assert.equal(schema.rangeEffectPreview([], 1000), '')
})

test('b-roll layouts keep fill implicit, split carries swap and 16:9 hides split in the UI data', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const parsed = schema.parseCandidateEdit({ ...overlay, brolls: [
    { asset: 'a'.repeat(32) + '.mp4', start_ms: 0, end_ms: 2000 },
    { asset: 'b'.repeat(32) + '.mp4', start_ms: 2000, end_ms: 4000, layout: 'pip' },
    { asset: 'c'.repeat(32) + '.mp4', start_ms: 4000, end_ms: 5000, layout: 'split', swap: true }] }, 12000, 4)
  assert.equal(parsed.brolls[0].layout, undefined)
  assert.equal(parsed.brolls[1].layout, 'pip')
  assert.deepEqual(parsed.brolls[2], { asset: 'c'.repeat(32) + '.mp4', start_ms: 4000, end_ms: 5000, layout: 'split', swap: true })
  for (const patch of [
    { brolls: [{ asset: 'a'.repeat(32) + '.mp4', start_ms: 0, end_ms: 1000, layout: 'window' }] },
    { brolls: [{ asset: 'a'.repeat(32) + '.mp4', start_ms: 0, end_ms: 1000, layout: 'fill', swap: true }] },
    { brolls: [{ asset: 'a'.repeat(32) + '.mp4', start_ms: 0, end_ms: 1000, layout: 'split', swap: 'yes' }] }
  ]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, ...patch }, 12000, 4))
  }
})

test('speech cleanup detects filler words, phrases, stutters and pauses from word timings', () => {
  const word = (text, start, end) => ({ text, start_ms: start, end_ms: end })
  const transcript = [
    { start_ms: 0, end_ms: 5000, text: 'So um I I think you know this this is the best take',
      words: [word('So', 0, 300), word('um', 400, 600), word('I', 1000, 1100), word('I', 1150, 1250),
        word('think', 1300, 1800), word('you', 1900, 2000), word('know', 2050, 2300),
        word('this', 2400, 2600), word('this', 2650, 2850), word('is', 2900, 3000), word('best', 3100, 3600), word('take', 3650, 4000)] },
    { start_ms: 5500, end_ms: 9000, text: 'Then a long pause happens here',
      words: [word('Then', 5600, 5900), word('a', 8000, 8100), word('pause', 8150, 8500)] }]
  const fillers = schema.detectFillers(transcript)
  assert.deepEqual(fillers.map((hit) => hit.text), ['um', 'I I', 'you know', 'this this'])
  const um = fillers[0]
  assert.deepEqual([um.segment, um.word_from, um.word_to], [0, 1, 1])
  const pauses = schema.detectPauses(transcript, 500)
  // Gaps ≥ 500 ms: between the lines (5000→5500) and inside line 2 (5900→8000).
  assert.deepEqual(pauses, [{ start_ms: 5000, end_ms: 5500 }, { start_ms: 5900, end_ms: 8000 }])
  assert.deepEqual(schema.detectPauses(transcript, 3000), [], 'the threshold is the user’s dial')
  // Rows without word timings are skipped for fillers, still pause-checked between lines.
  assert.deepEqual(schema.detectFillers([{ start_ms: 0, end_ms: 1000, text: 'um uh' }]), [])
})

test('voiceover config round-trips with bounds and keeps the preview audio referenced', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const config = { script: 'Hello from the voiceover studio.', voice: 'Microsoft Zira Desktop', rate: 1.5,
    pronunciations: [{ word: 'BridgeClip', say: 'Bridge Clip' }], audio_asset: 'a'.repeat(32) + '.wav',
    start_ms: 1500, duration_ms: 4200, gain: 0.8 }
  const parsed = schema.parseCandidateEdit({ ...overlay, voiceover: config }, 12000, 4)
  assert.deepEqual(parsed.voiceover, config)
  for (const patch of [
    { voiceover: { ...config, script: '   ' } },
    { voiceover: { ...config, rate: 3 } },
    { voiceover: { ...config, pronunciations: [{ word: '', say: 'x' }] } },
    { voiceover: { ...config, audio_asset: 'not-a-ref.wav' } },
    { voiceover: { ...config, start_ms: -1 } },
    { voiceover: { ...config, duration_ms: 50 } },
    { voiceover: { ...config, gain: 2.5 } }
  ]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, ...patch }, 12000, 4))
  }
  const project = schema.parseEditorProject(clone())
  project.candidates[0].voiceover = { ...config }
  assert.ok(schema.assetRefs(project).includes('a'.repeat(32) + '.wav'), 'the preview audio survives the sweep')
})

test('snap editing locks to the nearest edge within the window and collects every target', () => {
  const points = [0, 1000, 2500, 4000]
  assert.equal(schema.snapTo(points, 900, 150), 1000, 'locks onto the cut edge inside the window')
  assert.equal(schema.snapTo(points, 1800, 150), 1800, 'outside every window the time passes through')
  assert.equal(schema.snapTo(points, 2450, 100), 2500)
  assert.equal(schema.snapTo(points, 1200, 100), 1200)
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const transcript = [{ start_ms: 0, end_ms: 2000 }, { start_ms: 3000, end_ms: 5000 }]
  const points2 = schema.snapPoints(overlay, transcript, 12000)
  assert.deepEqual(points2, [...new Set([0, 12000, ...overlay.ranges.flat(), 0, 2000, 3000, 5000, ...overlay.scenes.map((s) => s.at_ms)])].sort((a, b) => a - b),
    'cut edges, speech lines, scene changes and clip ends are all targets, sorted and deduped')
})

test('styled text boxes round-trip, cap at five simultaneous boxes and sweep-count correctly', () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  const style = { font: 'poppins', size: 0.04, color: '#ffffff', background: '#14161c', radius: 12, padding: 1.2, align: 'left' }
  const box = (start, end) => ({ text: `Box ${start}`, start_ms: start, end_ms: end, position: 'bottom-left' })
  const parsed = schema.parseCandidateEdit({ ...overlay, text_overlays: [
    { ...box(0, 4000), style },
    { ...box(0, 2000), style: { ...style, font: 'archivo', align: 'right' } }] }, 12000, 4)
  assert.equal(parsed.text_overlays[0].style.font, 'poppins')
  assert.equal(parsed.text_overlays[1].style.align, 'right')
  assert.deepEqual(schema.parseCandidateEdit({ ...overlay, text_overlays: [box(0, 1000)] }, 12000, 4).text_overlays[0].style, undefined)
  for (const patch of [
    { text_overlays: [{ ...box(0, 1000), style: { ...style, font: 'comic' } }] },
    { text_overlays: [{ ...box(0, 1000), style: { ...style, size: 0.5 } }] },
    { text_overlays: [{ ...box(0, 1000), style: { ...style, color: 'red' } }] },
    { text_overlays: [{ ...box(0, 1000), style: { ...style, padding: 9 } }] }
  ]) {
    assert.throws(() => schema.parseCandidateEdit({ ...overlay, ...patch }, 12000, 4))
  }
  assert.equal(schema.maxSimultaneousTextOverlays([box(0, 4000), box(1000, 2000), box(3000, 5000)]), 2)
  assert.equal(schema.maxSimultaneousTextOverlays([1000, 2000, 3000, 4000, 5000].map((end, i) =>
    ({ ...box(0, end), position: 'top-left' }))), 5, 'five boxes sharing a moment is the cap')
})

test('the word menu corrects a word on its line, everywhere via caption edits', async () => {
  const overlay = schema.parseEditorProject(clone()).candidates[0]
  // Line 0 of the fixture transcript contains "First" as its first word.
  const update = (text) => schema.parseCandidateEdit({ ...overlay,
    caption_edits: [{ segment: 0, text }] }, 12000, 4)
  const corrected = update('First line, corrected.')
  assert.equal(corrected.caption_edits[0].text, 'First line, corrected.')
  assert.equal(corrected.caption_edits.length, 1)
})
