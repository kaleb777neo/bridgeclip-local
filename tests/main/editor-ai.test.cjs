'use strict'
const test = require('node:test')
const { after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadMain, tempDir, fakeElectron } = require('../zernio/support/load-main.cjs')
const project = require('../fixtures/editor/project.json')
const SOURCE = "export * from './src/main/editor-ai'; export * as settings from './src/main/settings-store'"

function setup(overrides = {}) {
  const temp = tempDir('bridgeclip-editor-ai-')
  const mocks = { electron: fakeElectron(temp.dir).electron, ...overrides }
  const main = loadMain(SOURCE, mocks)
  return { ...temp, main, reload: () => loadMain(SOURCE, mocks) }
}

/** Swap global.fetch for the test run; returns nothing, restores automatically. */
async function withFetch(handler, run) {
  const oldFetch = global.fetch
  const requests = []
  global.fetch = async (url, init) => { requests.push({ url, init }); return handler(url, init) }
  try { return { result: await run(), requests } } finally { global.fetch = oldFetch }
}

// ---------------------------------------------------------------------------
// Shared response parsing / validation (no network, no Electron state)
// ---------------------------------------------------------------------------

const f = setup()
const main = f.main
after(() => f.cleanup())

test('sanitizeHook keeps one plain line: strips quotes, emoji, bullets and labels, clamps to 120', () => {
  assert.equal(main.sanitizeHook('“Ship it in one line”'), 'Ship it in one line')
  assert.equal(main.sanitizeHook('🔥 Hook: “Do this now” 👍'), 'Do this now')
  assert.equal(main.sanitizeHook('- 12. Second-line filler\nignored'), 'Second-line filler')
  assert.equal(main.sanitizeHook('Title: the real hook'), 'the real hook')
  assert.equal(main.sanitizeHook('   '), '')
  assert.equal(main.sanitizeHook('"'.repeat(300)).length, 0, 'quote-only answers collapse to empty')
  const long = main.sanitizeHook('a'.repeat(500))
  assert.equal(long.length, 120)
  assert.equal(main.sanitizeHook('ab😀c'), 'abc', 'emoji are removed, not counted')
})

test('parseJsonObject accepts bare, fenced and padded JSON answers; rejects malformed ones', () => {
  assert.deepEqual(main.parseJsonObject('{"title":"T","caption_edits":[]}'), { title: 'T', caption_edits: [] })
  assert.deepEqual(main.parseJsonObject('```json\n{"title":"T"}\n```'), { title: 'T' })
  assert.deepEqual(main.parseJsonObject('Sure! Here is the JSON: {"title":"T"} — enjoy!'), { title: 'T' })
  for (const bad of ['', 'no json here', '{broken', '["array"]', '{"unclosed": ']) assert.equal(main.parseJsonObject(bad), null)
})

test('coveredSegments and openingText use the candidate ranges in clip time', () => {
  const candidate1 = project.candidates[0], candidate2 = project.candidates[1]
  assert.deepEqual(main.coveredSegments(project, candidate1).map(({ segment }) => segment), [0, 1, 2, 3])
  // candidate-2 starts exactly where row 1 ends: touching is not covering.
  assert.deepEqual(main.coveredSegments(project, candidate2).map(({ segment }) => segment), [2, 3])
  assert.equal(main.openingText(project, candidate2), 'That explains the result. The qualification matters.')
  // The 12s clip fits inside 15s, so candidate-1's opening is the whole cover.
  assert.equal(main.openingText(project, candidate1),
    'Here is the setup. The event happened. That explains the result. The qualification matters.')
  const long = { ...project, candidates: [{ ...candidate1, ranges: [[0, 60_000]] }],
    transcript: Array.from({ length: 40 }, (_, i) => ({ start_ms: i * 2000, end_ms: i * 2000 + 2000, text: `line ${i} `.repeat(40) })) }
  const opening = main.openingText(long, long.candidates[0])
  assert.ok(opening.startsWith('line 0') && opening.includes('line 7') && !opening.includes('line 8'), 'first ~15s of clip time only')
  assert.ok(opening.length <= 2000)
})

test('validateEnhanceReply drops edits outside the candidate ranges, empty text and duplicates; clamps title and text', () => {
  const candidate = project.candidates[1] // covers segments 2 and 3 only
  const ok = main.validateEnhanceReply({
    title: `  Sharper ${'x'.repeat(250)}  `,
    caption_edits: [
      { segment: 3, text: '  Fixed the qualification.  ' },
      { segment: 0, text: 'outside the candidate ranges' },
      { segment: 99, text: 'outside the transcript' },
      { segment: 2.5, text: 'fractional' },
      { segment: 2, text: '' },
      { segment: 2, text: 'first' }, { segment: 2, text: 'duplicate dropped' },
      ...Array.from({ length: 9 }, (_, i) => ({ segment: i < 5 ? 2 : 3, text: `${i}` }))
    ]
  }, project, candidate)
  assert.equal(ok.title.length, 200)
  assert.deepEqual(ok.caption_edits, [{ segment: 2, text: 'first' }, { segment: 3, text: 'Fixed the qualification.' }])
  assert.deepEqual(main.validateEnhanceReply({ title: 'T' }, project, candidate).caption_edits, [])
  assert.deepEqual(main.validateEnhanceReply({ title: 'T', caption_edits: 'not an array' }, project, candidate).caption_edits, [])
  const huge = main.validateEnhanceReply({ title: 'T', caption_edits: [{ segment: 2, text: 'a'.repeat(3000) }] }, project, candidate)
  assert.equal(huge.caption_edits[0].text.length, 2000)
  const cap = main.validateEnhanceReply({ title: 'T', caption_edits: [
    { segment: 2, text: 'a' }, { segment: 3, text: 'b' }, { segment: 2, text: 'c' }
  ] }, project, candidate)
  assert.equal(cap.caption_edits.length, 2)
  for (const bad of [{}, { title: '   ' }, { title: 5 }]) {
    assert.throws(() => main.validateEnhanceReply(bad, project, candidate), /Settings/)
  }
  assert.throws(() => main.validateEnhanceReply({ caption_edits: [] }, project, candidate), /did not suggest a title/)
})

// ---------------------------------------------------------------------------
// Generators with an injected chat stub (prompt building + reply handling)
// ---------------------------------------------------------------------------

const localSettings = { aiProvider: 'local', localLlmBaseUrl: 'http://127.0.0.1:11434', localPlannerModel: 'qwen3:8b' }

test('generateEditorHook prompts with title, first-15s transcript and keywords, and clamps the reply', async () => {
  const calls = []
  const keywords = { ...project, keywords: ['kubernetes', 'costs'] }
  const chat = async (settings, request) => { calls.push({ settings, request }); return '  “Kubernetes bills you cannot explain”  \nextra line' }
  const result = await main.generateEditorHook(keywords, 'candidate-1', { settings: localSettings, chat })
  assert.equal(result.text, 'Kubernetes bills you cannot explain')
  assert.equal(calls[0].settings, localSettings)
  const user = JSON.parse(calls[0].request.messages.at(-1).content)
  assert.equal(user.title, 'The result')
  assert.equal(user.keywords.join(','), 'kubernetes,costs')
  assert.ok(user.opening.includes('Here is the setup.'))
  assert.match(calls[0].request.messages[0].content, /one hook line/i)
  assert.match(calls[0].request.messages[0].content, /90 characters/i)
  await assert.rejects(main.generateEditorHook(project, 'nope', { settings: localSettings, chat }), /could not find this clip/)
  await assert.rejects(main.generateEditorHook(project, 'candidate-1', { settings: localSettings, chat: async () => '👍 “”' }), /Settings → AI/)
})

test('generateTitleByStyle rewrites per style, sanitizes and fails friendly', async () => {
  const calls = []
  const localSettings = { aiProvider: 'local', localPlannerModel: 'llama3' }
  const chat = async (settings, request) => { calls.push({ settings, request }); return '  “The Serious Truth About Costs”  \nextra' }
  const result = await main.generateTitleByStyle({ title: 'The result', caption: 'A caption with #tags' }, 'serious', { settings: localSettings, chat })
  assert.equal(result.title, 'The Serious Truth About Costs')
  assert.equal(calls[0].settings, localSettings)
  const user = JSON.parse(calls[0].request.messages.at(-1).content)
  assert.equal(user.title, 'The result')
  assert.match(user.caption, /#tags/)
  for (const [style, word] of [['catchy', /punchy, viral-friendly/i], ['question', /compelling question/i], ['interesting', /curiosity-gap/i]]) {
    calls.length = 0
    await main.generateTitleByStyle({ title: 'T', caption: 'C' }, style, { settings: localSettings, chat })
    assert.match(calls[0].request.messages[0].content, word, style)
    assert.match(calls[0].request.messages[0].content, /200 characters/i)
  }
  await assert.rejects(main.generateTitleByStyle({ title: 'T', caption: 'C' }, 'serious', { settings: localSettings, chat: async () => '“”' }), /Settings → AI/)
})

test('generateEditorEnhance asks for JSON, retries malformed replies once with a stricter reminder, then fails friendly', async () => {
  const replies = ['Sure! The title is "Sharper" and some edits in prose.', '```json\n{"title":"Sharper","caption_edits":[{"segment":2,"text":"Clean line."}]}\n```']
  const calls = []
  const chat = async (settings, request) => { calls.push(request); return replies[calls.length - 1] }
  const result = await main.generateEditorEnhance(project, 'candidate-2', { settings: localSettings, chat })
  assert.deepEqual(result, { title: 'Sharper', caption_edits: [{ segment: 2, text: 'Clean line.' }] })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].schemaName, 'editor_enhance')
  const segments = JSON.parse(calls[0].messages.at(-1).content).segments
  assert.deepEqual(segments.map((s) => s.segment), [2, 3], 'covered rows are given with their transcript indices')
  assert.match(calls[1].messages.at(-1).content, /JSON only/i)
  let always = 0
  await assert.rejects(main.generateEditorEnhance(project, 'candidate-1', { settings: localSettings, chat: async () => { always++; return 'not json' } }),
    (error) => { assert.match(error.message, /could not read/i); assert.match(error.message, /Settings → AI/); return true })
  assert.equal(always, 2, 'exactly one stricter retry')
})

// ---------------------------------------------------------------------------
// Provider branching with mocked fetch
// ---------------------------------------------------------------------------

test('editorAiChat routes the local provider to Ollama /api/chat with schema, model and a bounded signal', async () => {
  const { result, requests } = await withFetch(
    () => Response.json({ message: { content: 'hello' } }),
    () => main.editorAiChat(localSettings, { messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, maxTokens: 50 })
  )
  assert.equal(result, 'hello')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.model, 'qwen3:8b')
  assert.deepEqual(body.format, { type: 'object' })
  assert.ok(requests[0].init.signal instanceof AbortSignal, 'requests are timeout-bounded')
})

test('editorAiChat routes NVIDIA to the NIM endpoint with the key; a plain-text ask sends no response_format', async () => {
  const nvidia = { ...localSettings, aiProvider: 'nvidia', nvidiaApiKey: 'nv-key', nvidiaPlannerModel: 'meta/llama-3.3-70b-instruct' }
  const { result, requests } = await withFetch(
    () => Response.json({ choices: [{ message: { content: 'nim answer' } }] }),
    () => main.editorAiChat(nvidia, { messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })
  )
  assert.equal(result, 'nim answer')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://integrate.api.nvidia.com/v1/chat/completions')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer nv-key')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.model, 'meta/llama-3.3-70b-instruct')
  assert.ok(!('response_format' in body))
  const schema = await withFetch(() => Response.json({ choices: [{ message: { content: '{}' } }] }),
    () => main.editorAiChat(nvidia, { messages: [{ role: 'user', content: 'x' }], schema: { type: 'object' }, schemaName: 'editor_enhance', maxTokens: 50 }))
  assert.equal(JSON.parse(schema.requests[0].init.body).response_format.json_schema.name, 'editor_enhance')
  await assert.rejects(main.editorAiChat({ ...nvidia, nvidiaApiKey: '' }, { messages: [], maxTokens: 1 }), /Settings/)
})

test('editorAiChat falls back to OpenRouter only for cloud users with a key, and says Settings → AI otherwise', async () => {
  const cloud = { ...localSettings, aiProvider: 'cloud', openrouterApiKey: 'or-key' }
  const { result, requests } = await withFetch(
    () => Response.json({ choices: [{ message: { content: 'cloud answer' } }] }),
    () => main.editorAiChat(cloud, { messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })
  )
  assert.equal(result, 'cloud answer')
  assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(requests[0].init.headers.Authorization, 'Bearer or-key')
  await assert.rejects(main.editorAiChat({ ...cloud, openrouterApiKey: '' }, { messages: [], maxTokens: 1 }),
    /No AI provider is ready.*Settings → Local AI/)
})

test('unreachable providers surface a friendly Settings → AI error instead of raw network text', async () => {
  const { result } = await withFetch(async () => { throw new TypeError('fetch failed') },
    () => main.editorAiChat(localSettings, { messages: [{ role: 'user', content: 'x' }], maxTokens: 50 }).then(() => null, (error) => error.message))
  assert.match(result, /Editor AI could not reach the local model.*Check Settings → AI/)
})

// ---------------------------------------------------------------------------
// Default wiring: settings store + provider without injected deps
// ---------------------------------------------------------------------------

test('generateEditorHook without injected deps reads Settings → AI and answers through Ollama', async () => {
  const library = path.join(f.dir, 'library'); fs.mkdirSync(library, { recursive: true })
  main.settings.savePublicSettings({ outputDirectory: library, pythonPath: 'python3', aiProvider: 'local', localPlannerModel: 'qwen3:8b' })
  const { result, requests } = await withFetch(
    () => Response.json({ message: { content: '“The one metric that flips the launch”' } }),
    () => main.generateEditorHook(project, 'candidate-1')
  )
  assert.equal(result.text, 'The one metric that flips the launch')
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/chat')
})

test('bad takes detection flags only covered spans, caps their length and merges overlaps', async () => {
  const candidate = project.candidates.find((c) => c.id === 'candidate-1') ?? project.candidates[0]
  const good = JSON.stringify({ takes: [
    { start_segment: 0, end_segment: 1, reason: 'restart' },
    { start_segment: 1, end_segment: 2, reason: 'overlaps the first — merged' },
    { start_segment: 2, end_segment: 2, reason: 'dup inside a merged span — dropped' },
    { start_segment: 3, end_segment: 99, reason: 'end outside the clip — dropped' },
    { start_segment: 900, end_segment: 901, reason: 'outside the clip — dropped' },
    { start_segment: 0, end_segment: 1, reason: '' }
  ] })
  const takes = await main.detectBadTakes(project, candidate.id, { chat: async () => good })
  assert.equal(takes.length, 1)
  assert.deepEqual(takes[0], { start: 0, end: 2, reason: 'restart' })
  await assert.rejects(
    main.detectBadTakes(project, candidate.id, { chat: async () => 'not json at all' }),
    /could not read/)
})

test('the ten new caption presets exist in every surface that validates them', async () => {
  const presets = ['glitch', 'bounce', 'quake', 'blurswitch', 'highlighter', 'simple', 'ticker', 'retro', 'mono', 'duo']
  const editorSchema = loadMain("export * from './src/shared/clip-editor'")
  const overlay = editorSchema.parseEditorProject(project).candidates[0]
  for (const preset of presets) {
    const parsed = editorSchema.parseCandidateEdit({ ...overlay, caption_preset: preset }, 12000, 4)
    assert.equal(parsed.caption_preset, preset)
  }
  // ...and the Brand Vocabulary template ids validate them too (shared/templates).
  const templates = loadMain("export * from './src/main/templates-store'", { electron: fakeElectron(tempDir('bridgeclip-presets-').dir).electron })
  for (const preset of presets) {
    const saved = templates.saveTemplate({ id: `pack-${preset}`, name: `Pack ${preset}`, captionPresetId: preset, formats: ['9:16'] })
    assert.equal(saved.captionPresetId, preset)
    assert.equal(templates.getTemplate(`pack-${preset}`).captionPresetId, preset)
  }
})

test('the job start path validates the uploaded .srt and passes it to the engine config', async () => {
  const validation = loadMain("export * from './src/main/validation'", { electron: fakeElectron(tempDir('bridgeclip-srt-').dir).electron })
  const base = { workflow: 'automatic', videoUrl: 'https://youtube.com/watch?v=abcdefghijk', maxClips: null, autoClipCount: true,
    durationRanges: null, aspectRatio: '9:16', layoutStyle: 'auto', layoutVision: false, pacing: 'tight',
    videoSpeed: 1, includeCaptions: true, captionPreset: 'pop', startTimeSeconds: null, endTimeSeconds: null,
    bannerPlatform: null, bannerChannelUrl: null }
  const valid = { ...base, srtPath: 'C:\clips\my subs.srt' }
  const checked = validation.validateJobConfig(valid)
  assert.equal(checked.srtPath, 'C:\clips\my subs.srt')
  assert.throws(() => validation.validateJobConfig({ ...base, srtPath: 'C:\clips\subs.vtt' }), /\.srt/)
  assert.throws(() => validation.validateJobConfig({ ...base, srtPath: 42 }), /\.srt/)
})
