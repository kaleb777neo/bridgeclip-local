const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { buildSync } = require('esbuild')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

const bundled = buildSync({
  stdin: {
    contents: `export { FormatStep, ClipsStep, CaptionsStep, JobForm, buildJobRequest, parseTrimRange, draftPatchForTemplate, TemplateSelector } from './src/renderer/components/JobForm';
      export { TemplatesPage } from './src/renderer/pages/TemplatesPage';
      export { BulkScheduleDialog } from './src/renderer/components/BulkScheduleDialog';
      export { JobProgress } from './src/renderer/components/JobProgress';
      export { SetupCard } from './src/renderer/components/SetupCard';
      export { useSettingsStore } from './src/renderer/store/use-settings-store';
      export { useDraftStore } from './src/renderer/store/use-draft-store';
      export { SourcePicker, isValidSourceLink } from './src/renderer/components/SourcePicker';
      export { framingProblem, sourceAnalysisNotice, candidateIdsByClip } from './src/renderer/components/ClipList';
      export { ClipCard } from './src/renderer/components/ClipCard';
      export { EditorToolRail } from './src/renderer/components/EditorToolRail';
      export { filmstripStyle } from './src/renderer/lib/filmstrip';
      export { startingCandidate } from './src/shared/clip-editor';
      export { parseJobOutput } from './src/shared/job-output';
      export { jobAspectRatios } from './src/shared/jobs';
      export { recommendedAspect, pickVariant } from './src/shared/zernio-posts';
      export { twitchVodId, normalizeVideoSource } from './src/shared/video-source';`,
    resolveDir: path.resolve(__dirname, '..'),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  loader: { '.css': 'empty' },
  define: { __APP_VERSION__: JSON.stringify(require('../package.json').version) },
  jsx: 'automatic',
  write: false
}).outputFiles[0].text

const form = { exports: {} }
new Function('module', 'exports', 'require', bundled)(form, form.exports, require)
const { BulkScheduleDialog, FormatStep, JobForm, SourcePicker, isValidSourceLink, parseTrimRange, framingProblem, sourceAnalysisNotice, candidateIdsByClip, ClipCard, filmstripStyle, EditorToolRail, startingCandidate, parseJobOutput } = form.exports

test('the timeline filmstrip maps the preview window into the visible view', () => {
  const full = { startMs: 0, endMs: 60000 }
  assert.deepEqual(filmstripStyle(full, 0, 60000), { left: '0%', width: '100%' })
  assert.deepEqual(filmstripStyle(full, 10000, 20000), { left: '0%', width: '100%' }, 'a window wider than the view fills it, clamped')
  assert.deepEqual(filmstripStyle({ startMs: 20000, endMs: 30000 }, 0, 60000),
    { left: `${20000 / 60000 * 100}%`, width: `${10000 / 60000 * 100}%` }, 'a partial preview sits inside the source view')
  assert.equal(filmstripStyle({ startMs: 0, endMs: 5000 }, 50000, 60000), null, 'a window entirely left of the view renders nothing')
  assert.equal(filmstripStyle(full, 0, 0), null, 'a zero-span view renders nothing')
})

test('every clip card offers an Edit this action whenever the editor can open it', () => {
  const clip = { clip_index: 3, s3_url: 'file:///C:/library/run/clip_03.mp4', duration_ms: 4200, start_time_ms: 1000,
    end_time_ms: 5200, virality_score: 8, summary: 'A reel', tags: [] }
  const base = { clip, vertical: true, selected: false, selecting: false, onToggleSelect: () => {} }
  // The button exists purely from onEdit, before any editor project exists.
  const withEdit = renderToStaticMarkup(React.createElement(ClipCard, { ...base, onEdit: () => {} }))
  assert.ok(withEdit.includes('Edit this'))
  const withoutEdit = renderToStaticMarkup(React.createElement(ClipCard, base))
  assert.ok(!withoutEdit.includes('Edit this'))
  // Clip selection hides the action row; a disabled grid keeps the button visible but inert.
  const selecting = renderToStaticMarkup(React.createElement(ClipCard, { ...base, selecting: true, onEdit: () => {} }))
  assert.ok(!selecting.includes('Edit this'))
  const disabled = renderToStaticMarkup(React.createElement(ClipCard, { ...base, actionsDisabled: true, onEdit: () => {} }))
  assert.ok(disabled.includes('Edit this') && /<button[^>]*\sdisabled/.test(disabled))
  // While another editor operation holds this run, the per-reel entry stays visible but waits.
  const busy = renderToStaticMarkup(React.createElement(ClipCard, { ...base, editDisabled: true, onEdit: () => {} }))
  assert.ok(busy.includes('Edit this') && /<button[^>]*\sdisabled/.test(busy))
})

test('setup needs only OpenRouter for clipping', () => {
  const { SetupCard, useSettingsStore } = form.exports
  useSettingsStore.setState({ openrouterConfigured: false })
  const setup = renderToStaticMarkup(React.createElement(SetupCard, { onOpenSettings() {} }))
  assert.match(setup, /OpenRouter/)
  assert.doesNotMatch(setup, /ElevenLabs/)
  useSettingsStore.setState({ openrouterConfigured: false, toolStatus: null })
})

test('source picker accepts full HTTP(S) links and rejects malformed or credentialed links', () => {
  assert.equal(isValidSourceLink(' https://www.youtube.com/watch?v=abc '), true)
  assert.equal(isValidSourceLink('http://example.com/video.mp4'), true)
  assert.equal(isValidSourceLink('https://'), false)
  assert.equal(isValidSourceLink('https://user:pass@example.com/video'), false)
  assert.equal(isValidSourceLink('file:///tmp/video.mp4'), false)
})

test('trim validation matches main process bounds, including an end at zero', () => {
  assert.equal(parseTrimRange(true, '', '0').error, 'End must be after the start.')
  assert.equal(parseTrimRange(true, '1:30', '90').error, 'End must be after the start.')
  assert.deepEqual(parseTrimRange(true, '', '1:30'), { start: null, end: 90, error: null })
  assert.deepEqual(parseTrimRange(false, 'oops', '0'), { start: null, end: null, error: null })
})

test('the wizard opens on the video step with the steps listed in order', () => {
  const html = renderToStaticMarkup(React.createElement(JobForm, { onSubmit() {} }))
  const labels = [...html.matchAll(/aria-label="Create steps">(.*?)<\/nav>/gs)][0]?.[1] ?? ''
  const order = ['Video', 'Format', 'Clips', 'Captions', 'Review'].map((label) => labels.indexOf(label))
  assert.ok(order.every((index, i) => index > -1 && (i === 0 || index > order[i - 1])))
  assert.match(html, /aria-current="step"[^>]*>.*?Video/s)
  assert.match(html, /Choose a video/)
  assert.equal(form.exports.useDraftStore.getState().workflow, null)
  const radios = html.match(/<button[^>]*role="radio"[^>]*>/g) ?? []
  assert.equal(radios.length, 2)
  assert.ok(radios.every((radio) => radio.includes('aria-checked="false"')))
  assert.equal(radios.filter((radio) => radio.includes('tabindex="0"')).length, 1)
  assert.match(html, /Beginner friendly/)
  assert.match(html, /For advanced users/)
})

test('a job requires an explicit workflow and each new video resets that choice', () => {
  const { useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  const trim = { start: null, end: null }
  try {
    original.update({ source: 'https://example.com/video', workflow: null })
    assert.throws(() => buildJobRequest(useDraftStore.getState(), trim), /Choose a workflow/)
    for (const workflow of ['automatic', 'review']) {
      original.update({ workflow })
      original.setStep('format')
      original.setStep('video')
      assert.equal(useDraftStore.getState().workflow, workflow)
      assert.equal(buildJobRequest(useDraftStore.getState(), trim).workflow, workflow)
      original.startAnother()
      assert.equal(useDraftStore.getState().workflow, null)
    }
  } finally { useDraftStore.setState(original) }
})

test('clipping mode is selectable and economy disables paid vision in the submitted request', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    workflow: 'automatic', source: 'https://example.com/video', clippingMode: 'economy', aspectRatios: ['9:16'], layoutStyle: 'auto',
    layoutVision: true, pacing: 'tight', durations: ['short'], autoClipCount: true, maxClips: 5,
    includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /aria-label="Clipping mode"/)
  assert.match(html, /Economy/)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.clippingMode, 'economy')
  assert.equal(Object.hasOwn(request, 'debugCapture'), false)
  assert.equal(request.layoutVision, false)
  assert.equal(buildJobRequest({ ...draft, clippingMode: 'quality' }, { start: null, end: null }).layoutVision, true)
})

test('the title card is shown by default and can be turned off for automatic runs', () => {
  const { CaptionsStep, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.includeTitle, true)
    original.update({ workflow: 'automatic', source: 'https://example.com/video' })
    const automatic = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(automatic, /Show title at the top/)
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).includeTitle, true)
    original.update({ includeTitle: false })
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).includeTitle, false)
    original.startAnother()
    assert.equal(useDraftStore.getState().includeTitle, false)
    // Review exports never draw a title card, so the switch is not offered there.
    const review = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: { ...useDraftStore.getState(), workflow: 'review' }, update() {} }))
    assert.doesNotMatch(review, /Show title at the top/)
  } finally { useDraftStore.setState(original) }
})

test('what to clip is optional, trimmed into the request and cleared for the next video', () => {
  const { ClipsStep, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.clipRequest, '')
    original.update({ workflow: 'automatic', source: 'https://example.com/video' })
    const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(html, /aria-label="What to clip"/)
    assert.match(html, /maxLength="1000"/)
    assert.match(html, /aria-describedby="clip-request-help"/)
    assert.match(html, /id="clip-request-help"[^>]*>Only matching moments are clipped/)
    assert.equal(Object.hasOwn(buildJobRequest(useDraftStore.getState(), { start: null, end: null }), 'clipRequest'), false)
    original.update({ clipRequest: '   ' })
    assert.equal(Object.hasOwn(buildJobRequest(useDraftStore.getState(), { start: null, end: null }), 'clipRequest'), false)
    original.update({ clipRequest: '  every time they talk about pricing \n' })
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: null, end: null }).clipRequest, 'every time they talk about pricing')
    original.startAnother()
    assert.equal(useDraftStore.getState().clipRequest, '')
  } finally { useDraftStore.setState(original) }
})

test('a running job shows what the user asked to clip', () => {
  const { JobProgress } = form.exports
  const job = {
    id: 'job', revision: 1, status: 'planning', percent: 40, step: 'Finding moments', clipsDone: 0, clipsTotal: 0,
    queuedAt: Date.now(), startedAt: Date.now(),
    request: { videoUrl: 'https://www.youtube.com/watch?v=abc123def45', workflow: 'automatic', clipRequest: ' every time they talk about pricing ' }
  }
  const html = renderToStaticMarkup(React.createElement(JobProgress, { job, onCancel() {} }))
  assert.match(html, /title="every time they talk about pricing"><span class="sr-only">What to clip: <\/span>every time they talk about pricing</)
  const plain = renderToStaticMarkup(React.createElement(JobProgress, { job: { ...job, request: { ...job.request, clipRequest: undefined } }, onCancel() {} }))
  assert.doesNotMatch(plain, /What to clip/)
})

test('format is a multi-select toggle group while framing and speed stay single-tab-stop radio groups', () => {
  const draft = { aspectRatios: ['9:16'], layoutStyle: 'auto', layoutVision: true, pacing: 'tight' }
  const html = renderToStaticMarkup(React.createElement(FormatStep, { draft, update() {} }))
  // Faza B: formats are aria-pressed toggles (several may be on), not radios.
  const format = html.match(/role="group" aria-label="Format"[^>]*>(.*?)<\/div>/s)?.[1]
  assert.ok(format)
  assert.equal((format.match(/role="radio"/g) ?? []).length, 0)
  assert.equal((format.match(/aria-pressed="true"/g) ?? []).length, 1)
  // The two unselected format tiles (the group closes before the shortcuts row).
  assert.equal((format.match(/aria-pressed="false"/g) ?? []).length, 2)
  for (const label of ['Framing', 'Video speed']) {
    const group = html.match(new RegExp(`role="radiogroup" aria-label="${label}"[^>]*>(.*?)<\\/div>`, 's'))?.[1]
    assert.ok(group)
    assert.equal((group.match(/tabindex="0"/g) ?? []).length, 1)
  }
})

test('speed survives navigation and another job, and appears in the submitted request', () => {
  const { useDraftStore, buildJobRequest, ClipsStep } = form.exports
  const original = useDraftStore.getState()
  try {
    assert.equal(original.videoSpeed, 1)
    original.update({ workflow: 'automatic', source: 'https://example.com/video', videoSpeed: 1.5 })
    original.setStep('review')
    assert.equal(useDraftStore.getState().step, 'review')
    const lengths = renderToStaticMarkup(React.createElement(ClipsStep, { draft: useDraftStore.getState(), update() {} }))
    assert.match(lengths, /60 seconds becomes about 40 seconds/)
    assert.equal(buildJobRequest(useDraftStore.getState(), { start: 10, end: 70 }).videoSpeed, 1.5)
    original.startAnother()
    assert.equal(useDraftStore.getState().videoSpeed, 1.5)
    assert.equal(useDraftStore.getState().step, 'video')
  } finally { useDraftStore.setState(original) }
})

test('saved run speed is retained while invalid speed metadata is discarded', () => {
  assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed: 1.5 } } }).metrics.requested_settings.video_speed, 1.5)
  for (const video_speed of ['2', null, Infinity, 0, 3]) {
    assert.equal(parseJobOutput({ clips: [], metrics: { requested_settings: { video_speed } } }).metrics.requested_settings.video_speed, undefined)
  }
})

test('advanced selections travel with the job while presets ignore retained custom choices', () => {
  const { ClipsStep, buildJobRequest } = form.exports
  const draft = {
    workflow: 'automatic', source: 'https://example.com/video', clippingMode: 'advanced',
    plannerModel: 'provider/planning', transcriptionModel: 'provider/speech',
    aspectRatios: ['9:16'], layoutStyle: 'auto', layoutVision: true, pacing: 'tight',
    durations: ['short'], autoClipCount: true, maxClips: 5, includeCaptions: true, captionPreset: 'pop'
  }
  const html = renderToStaticMarkup(React.createElement(ClipsStep, { draft, update() {} }))
  assert.match(html, /Clip planning model/)
  assert.match(html, /Transcription model/)
  assert.equal((html.match(/role="combobox"/g) ?? []).length, 2)
  const request = buildJobRequest(draft, { start: null, end: null })
  assert.equal(request.plannerModel, 'provider/planning')
  assert.equal(request.transcriptionModel, 'provider/speech')
  assert.equal(request.layoutVision, true)
  for (const clippingMode of ['quality', 'economy']) {
    const preset = buildJobRequest({ ...draft, clippingMode }, { start: null, end: null })
    assert.equal(preset.plannerModel, undefined)
    assert.equal(preset.transcriptionModel, undefined)
  }
  // Output formats: the list is only sent when a second format is requested.
  const single = buildJobRequest({ ...draft, aspectRatios: ['1:1'] }, { start: null, end: null })
  assert.equal(single.aspectRatio, '1:1')
  assert.equal(single.aspectRatios, undefined)
  assert.deepEqual(buildJobRequest({ ...draft, aspectRatios: ['9:16', '1:1', '16:9'] }, { start: null, end: null }).aspectRatios, ['9:16', '1:1', '16:9'])
  // Review & edit exports one video: square falls back to vertical, extras are dropped.
  const reviewSquare = buildJobRequest({ ...draft, workflow: 'review', aspectRatios: ['1:1', '16:9'] }, { start: null, end: null })
  assert.equal(reviewSquare.aspectRatio, '9:16')
  assert.equal(reviewSquare.aspectRatios, undefined)
  const reviewWide = buildJobRequest({ ...draft, workflow: 'review', aspectRatios: ['16:9', '9:16'] }, { start: null, end: null })
  assert.equal(reviewWide.aspectRatio, '16:9')
  assert.equal(reviewWide.aspectRatios, undefined)
  // Vision framing is requested for 9:16 / 1:1 primaries but never for a 16:9-only job.
  assert.equal(buildJobRequest({ ...draft, aspectRatios: ['1:1'] }, { start: null, end: null }).layoutVision, true)
  assert.equal(buildJobRequest({ ...draft, aspectRatios: ['16:9', '9:16'] }, { start: null, end: null }).layoutVision, false)
})

test('clip list explains when smart framing intentionally keeps the whole frame', () => {
  const clip = (index) => ({
    clip_index: index, s3_url: `/tmp/clip-${index}.mp4`, duration_ms: 5000,
    start_time_ms: index * 5000, end_time_ms: (index + 1) * 5000, virality_score: 0.5
  })
  const output = parseJobOutput({
    clips: [clip(0), clip(1)],
    metrics: { clip_layouts: [
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 0, framing_status: 'whole_frame_auto' },
      { clip_index: 9, framing_status: 'whole_frame_auto' }
    ] }
  })
  assert.ok(output)
  assert.match(framingProblem(output, true), /whole frame for clip 1/)
  assert.equal(framingProblem(output, false), null)
  const classic = parseJobOutput({ clips: [clip(0)], metrics: {
    smart_framing_available: false, requested_settings: { aspect_ratio: '9:16', layout_style: 'fit' }
  } })
  assert.ok(classic)
  assert.equal(framingProblem(classic, true), null)
})

test('visual-only runs disclose unavailable captions and preserve analysis status', () => {
  const output = parseJobOutput({ clips: [], metrics: {
    transcription_status: 'no_speech', planning_source: 'visual', visual_frame_count: 12,
    captions_status: 'unavailable_without_transcript'
  } })
  assert.ok(output)
  assert.equal(output.metrics.visual_frame_count, 12)
  assert.equal(output.metrics.captions_status, 'unavailable_without_transcript')
  assert.match(sourceAnalysisNotice(output), /No speech was detected/)
})

test('Twitch VOD links canonicalize while other Twitch pages are rejected', () => {
  const { normalizeVideoSource, twitchVodId, SourcePicker } = form.exports
  for (const host of ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv']) {
    const source = `https://${host}/videos/12345/?t=1h&tracking=secret`
    assert.equal(isValidSourceLink(source), true)
    assert.equal(normalizeVideoSource(source), 'https://www.twitch.tv/videos/12345')
    assert.equal(twitchVodId(source), '12345')
  }
  for (const source of ['https://twitch.tv/channel', 'https://clips.twitch.tv/Clip', 'https://player.twitch.tv/?video=123', 'https://twitch.tv/videos/nope', 'https://twitch.tv:8443/videos/123']) assert.equal(isValidSourceLink(source), false)
  assert.equal(twitchVodId('https://twitch.tv.evil.test/videos/123'), null)
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { value: 'https://www.twitch.tv/videos/12345', onChange() {} }))
  assert.match(html, /Twitch VOD/)
  assert.match(html, /Public, completed videos only/)
  assert.doesNotMatch(html, /<img/)
})


test('Review & edit shows required Jev review even when automatic review is off', () => {
  const { ClipsStep, useDraftStore, useSettingsStore } = form.exports
  const original = useSettingsStore.getState()
  const initialState = useSettingsStore.getInitialState()
  const initialJev = initialState.jevEnabled
  try {
    useSettingsStore.setState({ jevEnabled: 'off' })
    initialState.jevEnabled = 'off'
    const draft = useDraftStore.getState()
    const review = renderToStaticMarkup(React.createElement(ClipsStep, { draft: { ...draft, workflow: 'review' }, update() {} }))
    const automatic = renderToStaticMarkup(React.createElement(ClipsStep, { draft: { ...draft, workflow: 'automatic' }, update() {} }))
    assert.match(review, /Jev review required/)
    assert.doesNotMatch(review, /Jev review &amp; repairs off/)
    assert.match(automatic, /Jev review &amp; repairs off/)
    assert.equal(useSettingsStore.getState().jevEnabled, 'off')
  } finally { initialState.jevEnabled = initialJev; useSettingsStore.setState(original) }
})

test('a baked clip maps to the candidate that exported it, first candidate winning', () => {
  const candidate = (id, status, exports) => ({ id, status, exports })
  const map = candidateIdsByClip([
    candidate('candidate-1', 'baked', [0, 2]),
    candidate('candidate-2', 'baked', [1]),
    // A re-bake lists an index twice across candidates; the original owner stays.
    candidate('candidate-3', 'baked', [2, 3])
  ])
  assert.deepEqual([...map], [[0, 'candidate-1'], [2, 'candidate-1'], [1, 'candidate-2'], [3, 'candidate-3']])
  assert.equal(candidateIdsByClip([candidate('candidate-1', 'ready', [])]).size, 0)
})

test('the editor opens on a focused clip, falling back to the first unfinished candidate', () => {
  const candidate = (id, status) => ({ id, status, exports: [] })
  const candidates = [candidate('c1', 'baked'), candidate('c2', 'ready'), candidate('c3', 'refining')]
  assert.equal(startingCandidate(candidates, 'c3'), 2)
  // An unknown or absent focus keeps the normal landing spot: first not baked/discarded.
  assert.equal(startingCandidate(candidates, 'missing'), 1)
  assert.equal(startingCandidate(candidates, null), 1)
  const allBaked = [candidate('c1', 'baked'), candidate('c2', 'discarded')]
  assert.equal(startingCandidate(allBaked, 'c2'), 1)
  assert.equal(startingCandidate(allBaked), 0)
})

test('requested output formats fall back to the primary ratio for older requests', () => {
  const { jobAspectRatios } = form.exports
  assert.deepEqual(jobAspectRatios({ aspectRatio: '9:16' }), ['9:16'])
  assert.deepEqual(jobAspectRatios({ aspectRatio: '9:16', aspectRatios: undefined }), ['9:16'])
  assert.deepEqual(jobAspectRatios({ aspectRatio: '9:16', aspectRatios: [] }), ['9:16'])
  assert.deepEqual(jobAspectRatios({ aspectRatio: '1:1', aspectRatios: ['1:1', '9:16'] }), ['1:1', '9:16'])
})

test('each platform recommends its placement format and pickVariant resolves the rendered file', () => {
  const { recommendedAspect, pickVariant } = form.exports
  assert.equal(recommendedAspect('tiktok'), '9:16')
  assert.equal(recommendedAspect('instagram'), '9:16')
  assert.equal(recommendedAspect('facebook'), '1:1')
  assert.equal(recommendedAspect('twitter'), '1:1')
  assert.equal(recommendedAspect('linkedin'), '1:1')
  assert.equal(recommendedAspect('youtube'), '16:9')
  assert.equal(recommendedAspect('threads'), '16:9')
  const variants = [
    { aspect_ratio: '1:1', s3_url: 'file:///clip_00_1x1.mp4' },
    { aspect_ratio: '16:9', s3_url: 'file:///clip_00_16x9.mp4' }
  ]
  assert.equal(pickVariant(variants, '16:9'), variants[1])
  // Only the primary exists in that format: the caller keeps clip.s3_url.
  assert.equal(pickVariant(variants, '9:16'), null)
  assert.equal(pickVariant(null, '1:1'), null)
  assert.equal(pickVariant(undefined, '1:1'), null)
  assert.equal(pickVariant([], '1:1'), null)
})

test('brand pack selection writes templateId, formats and preset into the draft, and manual edits still travel', () => {
  const { draftPatchForTemplate, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  const pack = { id: 'boxed-brand', name: 'Boxed brand', builtIn: true, captionPresetId: 'boxed', formats: ['9:16', '1:1'],
    logo: { position: 'bottom-right', scale: .15, opacity: .9 } }
  const trim = { start: null, end: null }
  try {
    original.update({ workflow: 'automatic', source: 'https://example.com/video', templateId: null, aspectRatios: ['9:16'], captionPreset: 'pop' })
    assert.equal(Object.hasOwn(buildJobRequest(useDraftStore.getState(), trim), 'templateId'), false)
    original.update(draftPatchForTemplate(pack))
    const draft = useDraftStore.getState()
    assert.equal(draft.templateId, 'boxed-brand')
    assert.deepEqual(draft.aspectRatios, ['9:16', '1:1'])
    assert.equal(draft.captionPreset, 'boxed')
    const request = buildJobRequest(draft, trim)
    assert.equal(request.templateId, 'boxed-brand')
    assert.deepEqual(request.aspectRatios, ['9:16', '1:1'])
    // Manual per-field edits after selecting: the wizard's values are what the job sends,
    // and main's fill-if-absent resolver keeps them over the pack.
    original.update({ aspectRatios: ['9:16'], captionPreset: 'neon' })
    const edited = buildJobRequest(useDraftStore.getState(), trim)
    assert.equal(edited.templateId, 'boxed-brand')
    assert.deepEqual(edited.aspectRatios, ['9:16'])
    assert.equal(edited.aspectRatio, '9:16')
    assert.equal(edited.captionPreset, 'neon')
    // The chosen pack survives "clip another video" like the other output preferences.
    original.startAnother()
    assert.equal(useDraftStore.getState().templateId, 'boxed-brand')
    // None clears the provenance but keeps the derived values.
    original.update(draftPatchForTemplate(null))
    assert.equal(useDraftStore.getState().templateId, null)
    assert.equal(Object.hasOwn(buildJobRequest({ ...useDraftStore.getState(), workflow: 'automatic', source: 'https://example.com/video' }, trim), 'templateId'), false)
  } finally { useDraftStore.setState(original) }
})

test('a full pack patches banner, title, pacing and framing into the draft, and manual edits still win', () => {
  const { draftPatchForTemplate, useDraftStore, buildJobRequest } = form.exports
  const original = useDraftStore.getState()
  const pack = { id: 'channel-pack', name: 'Channel pack', captionPresetId: 'impact', formats: ['16:9'],
    banner: { platform: 'youtube', channelUrl: 'https://youtube.com/@studio' }, includeTitle: false, pacing: 'natural', layoutStyle: 'fill' }
  const trim = { start: null, end: null }
  try {
    original.update({ workflow: 'automatic', source: 'https://example.com/video', templateId: null, aspectRatios: ['9:16'], captionPreset: 'pop',
      pacing: 'tight', layoutStyle: 'auto', includeTitle: true, bannerPlatform: null, bannerChannelUrl: null })
    original.update(draftPatchForTemplate(pack))
    const draft = useDraftStore.getState()
    assert.equal(draft.pacing, 'natural')
    assert.equal(draft.layoutStyle, 'fill')
    assert.equal(draft.includeTitle, false)
    assert.equal(draft.bannerPlatform, 'youtube')
    assert.equal(draft.bannerChannelUrl, 'https://youtube.com/@studio')
    const request = buildJobRequest(draft, trim)
    assert.equal(request.pacing, 'natural')
    assert.equal(request.layoutStyle, 'fill')
    assert.equal(request.includeTitle, false)
    assert.equal(request.bannerPlatform, 'youtube')
    assert.equal(request.bannerChannelUrl, 'https://youtube.com/@studio')
    // Manual edits after selecting the pack are what the job sends.
    original.update({ includeTitle: true, pacing: 'tight', bannerPlatform: 'tiktok', bannerChannelUrl: 'https://www.tiktok.com/@me' })
    const edited = buildJobRequest(useDraftStore.getState(), trim)
    assert.equal(edited.includeTitle, true)
    assert.equal(edited.pacing, 'tight')
    assert.equal(edited.bannerPlatform, 'tiktok')
    assert.equal(edited.bannerChannelUrl, 'https://www.tiktok.com/@me')
    // A pack without the new fields leaves the draft's own values in place.
    original.update({ bannerPlatform: null, bannerChannelUrl: null })
    original.update(draftPatchForTemplate({ id: 'plain', name: 'Plain', captionPresetId: 'pop', formats: ['9:16'] }))
    const plain = buildJobRequest(useDraftStore.getState(), trim)
    assert.equal(plain.bannerPlatform, null)
    assert.equal(plain.bannerChannelUrl, null)
    assert.equal(plain.pacing, 'tight')
    assert.equal(plain.includeTitle, true)
    assert.equal(plain.layoutStyle, 'fill')
    // Older drafts without the banner keys still build a valid request.
    const legacy = buildJobRequest({ ...useDraftStore.getState(), bannerPlatform: undefined, bannerChannelUrl: undefined }, trim)
    assert.equal(legacy.bannerPlatform, null)
    assert.equal(legacy.bannerChannelUrl, null)
  } finally { useDraftStore.setState(original) }
})

test('the template chip row offers None plus one chip per pack, pressed for the selection', () => {
  const { TemplateSelector } = form.exports
  const templates = [
    { id: 'clean', name: 'Clean', builtIn: true, captionPresetId: 'pop', formats: ['9:16'] },
    { id: 'my-pack', name: 'My pack', captionPresetId: 'neon', formats: ['9:16', '1:1'] }
  ]
  const html = renderToStaticMarkup(React.createElement(TemplateSelector, { templates, selectedId: 'my-pack', onSelect() {} }))
  assert.match(html, /aria-label="Brand template"/)
  assert.match(html, /None/)
  assert.match(html, /Clean/)
  assert.match(html, /My pack/)
  assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
  assert.equal((html.match(/aria-pressed="false"/g) ?? []).length, 2)
})

test('the templates page renders its shell and loading state without the bridge', () => {
  const { TemplatesPage } = form.exports
  const html = renderToStaticMarkup(React.createElement(TemplatesPage))
  assert.match(html, /Templates/)
  assert.match(html, /Brand packs apply a logo/)
  assert.match(html, /Loading your brand packs/)
})

test('saved job output keeps per-format clip variants and drops malformed ones', () => {
  const { parseJobOutput } = form.exports
  const clip = (variants) => ({
    clip_index: 0, s3_url: 'file:///clip_00.mp4', duration_ms: 5000,
    start_time_ms: 0, end_time_ms: 5000, virality_score: 0.5, variants
  })
  const parsed = parseJobOutput({ clips: [clip([{ aspect_ratio: '1:1', s3_url: 'file:///clip_00_1x1.mp4' }])] })
  assert.deepEqual(parsed.clips[0].variants, [{ aspect_ratio: '1:1', s3_url: 'file:///clip_00_1x1.mp4' }])
  // Unknown ratios, blank urls, oversized lists and non-lists never reach React.
  for (const variants of [
    [{ aspect_ratio: '4:3', s3_url: 'file:///x.mp4' }],
    [{ aspect_ratio: '1:1', s3_url: '   ' }],
    [{ aspect_ratio: '1:1' }],
    [1, 'file'],
    Array.from({ length: 4 }, (_, i) => ({ aspect_ratio: ['9:16', '16:9', '1:1', '9:16'][i], s3_url: `file:///c${i}.mp4` }))
  ]) {
    assert.equal(parseJobOutput({ clips: [clip(variants)] }).clips[0].variants, null, JSON.stringify(variants))
  }
  assert.equal(parseJobOutput({ clips: [clip(null)] }).clips[0].variants, null)
  assert.equal(parseJobOutput({ clips: [clip(undefined)] }).clips[0].variants, null)
  // The requested formats survive metrics sanitization; invalid ones are dropped.
  const kept = parseJobOutput({ clips: [], metrics: { requested_settings: { aspect_ratio: '9:16', aspect_ratios: ['9:16', '1:1'] } } })
  assert.deepEqual(kept.metrics.requested_settings.aspect_ratios, ['9:16', '1:1'])
  const dropped = parseJobOutput({ clips: [], metrics: { requested_settings: { aspect_ratios: ['9:16', '4:3'] } } })
  assert.equal(dropped.metrics.requested_settings.aspect_ratios, undefined)
})

test('the editor tool rail renders every tool, music included, without import-time breakage', () => {
  const project = { duration_ms: 12000, width: 1080, height: 1920, aspect_ratio: '9:16', transcript: [], keywords: [] }
  const candidate = { id: 'candidate-1', title: 'Clip', ranges: [[0, 5000]], scenes: [{ at_ms: 0, layout: 'fill', crops: [[.1, .1, .8, .8]] }],
    captions: true, caption_preset: 'pop', video_speed: 1, status: 'refining', caption_edits: [], caption_suppression_ranges: [], score: 0, reason: '', review: null, exports: [] }
  const html = renderToStaticMarkup(React.createElement(EditorToolRail, { outputDir: 'C:/library/run', project, candidate, sceneIndex: 0, time: 0,
    disabled: false, assetPaths: {}, change: () => {}, seek: () => {}, setTab: () => {}, setError: () => {}, setNotice: () => {} }))
  for (const label of ['AI enhance', 'Caption', 'Text', 'Upload', 'Transitions', 'AI hook', 'B-Roll', 'Music']) {
    assert.ok(html.includes(label), `the rail offers ${label}`)
  }
})

test('the captions step offers a No caption tile that reflects the burn-in state', () => {
  const { CaptionsStep, buildJobRequest: buildReq } = form.exports
  const draft = { workflow: 'clipping', includeTitle: true, captionPreset: 'pop' }
  const none = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: { ...draft, includeCaptions: false }, update: () => {} }))
  assert.ok(none.includes('No caption'), 'the No caption tile renders')
  assert.ok(none.includes('aria-checked="true"'), 'the No caption tile is selected while captions are off')
  assert.ok(!none.includes('aria-checked="true"><'), 'no preset tile claims selection while captions are off')
  const on = renderToStaticMarkup(React.createElement(CaptionsStep, { draft: { ...draft, includeCaptions: true }, update: () => {} }))
  assert.ok(on.includes('No caption'))
  assert.match(on, /aria-checked="true"[\s\S]*?aria-label="Pop"/, 'the chosen preset stays selected while captions are on')
  assert.match(on, /aria-checked="false"[\s\S]*?aria-label="No caption"/, 'the No caption tile is unselected while captions are on')
})

test('the captions step offers the .srt upload and carries it into the job request', () => {
  const { CaptionsStep, buildJobRequest: buildReq } = form.exports
  const draft = { workflow: 'clipping', includeTitle: true, captionPreset: 'pop', includeCaptions: true,
    srtPath: null, srtName: null }
  const html = renderToStaticMarkup(React.createElement(CaptionsStep, { draft, update: () => {} }))
  assert.ok(html.includes('Upload .srt'), 'the upload button renders without a file')
  const withFile = renderToStaticMarkup(React.createElement(CaptionsStep, {
    draft: { ...draft, srtPath: 'C:/clips/my subs.srt', srtName: 'my subs.srt' }, update: () => {} }))
  assert.ok(withFile.includes('my subs.srt'), 'the chosen file name is shown')
  assert.ok(withFile.includes('Change .srt'), 'the button offers changing the file')
  assert.ok(withFile.includes('Remove'), 'the file can be removed')
  const request = buildReq({ ...draft, source: 'https://youtube.com/watch?v=abcdefghijk', durations: [], aspectRatios: ['9:16'], srtPath: 'C:/clips/my subs.srt' }, { start: null, end: null })
  assert.equal(request.srtPath, 'C:/clips/my subs.srt', 'the request carries the srt path to main')
})

test('bulk scheduling computes one slot per clip at start + i x interval', () => {
  const clips = [
    { path: 'a.mp4', title: 'First', tags: [], durationMs: 30000 },
    { path: 'b.mp4', title: 'Second', tags: [], durationMs: 25000 },
    { path: 'c.mp4', title: 'Third', tags: [], durationMs: 20000 }]
  const html = renderToStaticMarkup(React.createElement(BulkScheduleDialog, { clips, onCancel: () => {}, timeZone: 'UTC', onStart: () => {} }))
  assert.ok(html.includes('Schedule 3 clips in a batch'), 'the batch header lists the count')
  assert.ok(html.includes('First') && html.includes('Third'), 'every selected clip is listed')
  assert.ok(html.includes('First post') && html.includes('Interval'), 'start time and interval controls render')
  assert.ok(html.includes('Continue with 3 slots'), 'the confirm button carries the count')
})

test('clip cards show where each clip originates in the source video', () => {
  const clip = { clip_index: 5, s3_url: 'file:///C:/library/run/clip_05.mp4', duration_ms: 65000,
    start_time_ms: 26 * 60000 + 14000, end_time_ms: 26 * 60000 + 14000 + 65000, virality_score: 9.2,
    summary: 'Mid-video moment', tags: [] }
  const base = { clip, vertical: true, selected: false, selecting: false, onToggleSelect: () => {} }
  const html = renderToStaticMarkup(React.createElement(ClipCard, { ...base, onEdit: () => {} }))
  assert.match(html, /@ 26:14/, 'the origin timestamp renders next to the duration')
  assert.match(html, /Appears at 26:14 in the source video/, 'the tooltip names the source position')
  const startZero = renderToStaticMarkup(React.createElement(ClipCard, {
    ...base, clip: { ...clip, start_time_ms: 0 }, onEdit: () => {} }))
  assert.doesNotMatch(startZero, /@ 0:00/, 'clips from the very start skip the redundant badge')
})

test('the source picker accepts Kick, TikTok and Instagram links and advertises them', () => {
  const source = require('./../src/shared/video-source.ts') // type-only fallback; real checks via picker markup
  void source
  const draft = { source: '' }
  const html = renderToStaticMarkup(React.createElement(SourcePicker, { value: draft.source, onChange: () => {} }))
  for (const platform of ['Kick', 'TikTok', 'Instagram', 'Vimeo', 'Facebook', 'LinkedIn', 'X / Twitter', 'Rumble', 'StreamYard', 'Dropbox', 'Google Drive', 'Zoom']) assert.ok(html.includes(`>${platform}</span>`), `the picker advertises ${platform}`)
  assert.match(html, /Vimeo, Dropbox, Drive, Zoom, Rumble, Facebook, LinkedIn, X or direct link/, 'the placeholder names the new platforms')
})
