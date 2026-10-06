/**
 * Offline smoke test: a fake BridgeClip library in a temp directory plus a real
 * MCP session over stdio. Verifies the handshake, the five tools, posted and
 * favorite markers, the transcript excerpt, search ranking, and path safety.
 *
 * Run: npm test   (from bridgeclip-mcp/)
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// ---- Fake BridgeClip library -------------------------------------------------

const library = mkdtempSync(join(tmpdir(), 'bridgeclip-mcp-'))
const runA = join(library, 'evening-parker-review')
const runB = join(library, 'morning-panel')
mkdirSync(runA); mkdirSync(runB)

writeFileSync(join(runA, 'job_output.json'), JSON.stringify({
  job_id: 'evening-parker-review',
  source_video_title: 'Evening Parker Show — season finale',
  editor_project: true,
  clips: [
    { clip_index: 0, s3_url: join(runA, 'clip_00.mp4'), duration_ms: 42000, start_time_ms: 120000,
      end_time_ms: 162000, virality_score: 8.5, layout_type: 'talking_head',
      summary: 'The budget meltdown explained in 40 seconds', tags: ['budget', 'politics'] },
    { clip_index: 1, s3_url: join(runA, 'clip_01.mp4'), duration_ms: 30000, start_time_ms: 300000,
      end_time_ms: 330000, virality_score: 6.1, layout_type: 'screen',
      summary: 'Audience reactions to the finale', tags: ['reactions'] }
  ]
}))
writeFileSync(join(runA, 'transcript.json'), JSON.stringify({ segments: [
  { start_time_ms: 120000, end_time_ms: 126000, text: 'Here is how the budget fell apart.', speaker_label: 'S1' },
  { start_time_ms: 126500, end_time_ms: 131000, text: 'Three numbers tell the whole story.' },
  { start_time_ms: 300000, end_time_ms: 305000, text: 'The crowd could not believe it.' }
] }))
writeFileSync(join(runA, '.bridgeclip-favorite'), '')
writeFileSync(join(runA, '.bridgeclip-posted-0'), '')

writeFileSync(join(runB, 'job_output.json'), JSON.stringify({
  job_id: 'morning-panel',
  source_video_title: 'Morning panel',
  clips: [
    { clip_index: 0, s3_url: join(runB, 'clip_00.mp4'), duration_ms: 25000, start_time_ms: 10000,
      end_time_ms: 35000, virality_score: 7.2, layout_type: 'two_shot',
      summary: 'Panelists argue about the defense budget', tags: ['defense'] }
  ]
}))
// runA is the favorite but must sort by recency first regardless.
const now = new Date()
utimesSync(runA, now, new Date(Date.now() - 3600_000))
utimesSync(runB, now, now)

// ---- Minimal MCP stdio client ------------------------------------------------

const child = spawn(process.execPath, [join(root, 'index.js')], {
  env: { ...process.env, BRIDGECLIP_LIBRARY: library },
  stdio: ['pipe', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`))

let buffer = ''
let nextId = 1
const pending = new Map()
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
})

function request(method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      // The SDK surfaces tool errors as isError results, not JSON-RPC errors.
      else if (message.result?.isError) reject(new Error(message.result.content?.[0]?.text ?? `${method} failed`))
      else resolve(message.result)
    })
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000).unref()
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

const call = async (name, args) => JSON.parse((await request('tools/call', { name, arguments: args })).content[0].text)

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' }
  })
  assert.equal(init.serverInfo.name, 'bridgeclip')
  notify('notifications/initialized', {})

  const tools = await request('tools/list', {})
  const names = tools.tools.map((tool) => tool.name)
  for (const expected of ['library_info', 'list_runs', 'list_clips', 'get_clip', 'search_clips',
    'get_editor_project', 'get_captions', 'update_caption']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }

  const info = await call('library_info', {})
  assert.equal(info.runs, 2)
  assert.equal(info.clips, 3)
  assert.equal(info.favorites, 1)
  assert.equal(info.editor_projects, 1)
  assert.equal(info.library, library)

  const runs = await call('list_runs', {})
  assert.equal(runs.runs[0].run, 'morning-panel', 'runs sort newest first')
  assert.equal(runs.runs[1].favorite, true)
  assert.match(runs.runs[1].title, /Evening Parker/)

  const favoriteOnly = await call('list_runs', { favorites_only: true })
  assert.deepEqual(favoriteOnly.runs.map((run) => run.run), ['evening-parker-review'])

  const clips = await call('list_clips', { run: 'evening-parker-review' })
  assert.equal(clips.clips.length, 2)
  assert.equal(clips.clips[0].posted, true, 'the posted marker is picked up')
  assert.equal(clips.clips[1].posted, false)
  assert.match(clips.clips[0].path, /clip_00\.mp4$/)

  const clip = await call('get_clip', { run: 'evening-parker-review', clip_index: 0 })
  assert.equal(clip.score, 8.5)
  assert.equal(clip.transcript.length, 2, 'only rows overlapping the clip window')
  assert.match(clip.transcript[0].text, /budget fell apart/)
  assert.equal(clip.transcript[0].speaker, 'S1')

  const search = await call('search_clips', { query: 'budget' })
  assert.equal(search.matches.length, 2)
  assert.equal(search.matches[0].score, 8.5, 'matches rank by virality score across runs')
  assert.deepEqual([...new Set(search.matches.map((match) => match.run))].sort(), ['evening-parker-review', 'morning-panel'])

  // Editor project: read captions, fix a typo, watch the revision bump.
  writeFileSync(join(runA, 'editor-project.json'), JSON.stringify({
    version: 1, revision: 4, aspect_ratio: '9:16', duration_ms: 340000,
    transcript: [
      { start_ms: 120000, end_ms: 126000, text: 'Here is how the budget fell apart.' },
      { start_ms: 126500, end_ms: 131000, text: 'Three nubmers tell the whole story.' }],
    candidates: [{ id: 'candidate-1', title: 'Budget meltdown', status: 'ready', score: 8.5,
      ranges: [[120000, 131000]], caption_edits: [] }]
  }))
  const project = await call('get_editor_project', { run: 'evening-parker-review' })
  assert.equal(project.revision, 4)
  assert.equal(project.clips[0].candidate_id, 'candidate-1')

  const captions = await call('get_captions', { run: 'evening-parker-review', clip_index: 0 })
  assert.equal(captions.captions[1].text, 'Three nubmers tell the whole story.')
  assert.equal(captions.captions[1].edited, false)

  const fixed = await call('update_caption', { run: 'evening-parker-review', clip_index: 0, segment: 1, text: 'Three numbers tell the whole story.' })
  assert.equal(fixed.revision, 5)
  const reread = await call('get_captions', { run: 'evening-parker-review', clip_index: 0 })
  assert.equal(reread.captions[1].text, 'Three numbers tell the whole story.')
  assert.equal(reread.captions[1].edited, true)
  assert.equal(reread.captions[0].edited, false, 'the untouched line gains no edit entry')
  await assert.rejects(call('update_caption', { run: 'evening-parker-review', clip_index: 0, segment: 9, text: 'x' }), /does not exist/)

  // Path safety: traversal and hidden names never reach the filesystem.
  for (const bad of ['../escape', '.deleting-abc', 'a/b', '']) {
    await assert.rejects(request('tools/call', { name: 'list_clips', arguments: { run: bad } }), /not in the library/)
  }
  await assert.rejects(request('tools/call', { name: 'get_clip', arguments: { run: 'evening-parker-review', clip_index: 9 } }), /no clip 9/)

  child.kill()

  // Auto-discovery: a second server reading settings.json from BRIDGECLIP_USER_DATA finds the same library.
  const userData = mkdtempSync(join(tmpdir(), 'bridgeclip-mcp-ud-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ outputDirectory: library }))
  const discovered = spawn(process.execPath, [join(root, 'index.js')], {
    env: { ...process.env, BRIDGECLIP_USER_DATA: userData },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let dBuffer = ''
  let dNextId = 1
  const dPending = new Map()
  discovered.stdout.on('data', (chunk) => {
    dBuffer += chunk.toString()
    let newline
    while ((newline = dBuffer.indexOf('\n')) >= 0) {
      const line = dBuffer.slice(0, newline).trim()
      dBuffer = dBuffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.id && dPending.has(message.id)) {
        dPending.get(message.id)(message)
        dPending.delete(message.id)
      }
    }
  })
  const dRequest = (method, params) => {
    const id = dNextId++
    discovered.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      dPending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolve(message.result)
      })
      setTimeout(() => reject(new Error(`${method} timed out`)), 15000).unref()
    })
  }
  try {
    await dRequest('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' }
    })
    const info = await dRequest('tools/call', { name: 'library_info', arguments: {} })
    const parsed = JSON.parse(info.content[0].text)
    assert.equal(parsed.library, library, 'settings.json outputDirectory is discovered without BRIDGECLIP_LIBRARY')
    assert.equal(parsed.runs, 2)
  } finally {
    discovered.kill()
  }

  console.log('bridgeclip-mcp smoke: all checks passed')
} finally {
  child.kill()
}
