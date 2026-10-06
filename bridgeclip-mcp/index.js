#!/usr/bin/env node
/**
 * BridgeClip MCP server — BridgeClip as an AI-assistant connector.
 *
 * A read-only, local, zero-credential stdio MCP server over the BridgeClip
 * clip library: runs, clips (scores, summaries, tags, paths), transcript
 * excerpts and cross-run search, so MCP clients (Claude, ZCode, …) can use
 * BridgeClip's best features simply by prompting. Nothing here writes, calls
 * the network, or needs the app to be running.
 *
 * Tools: library_info, list_runs, list_clips, get_clip, search_clips,
 * get_editor_project, get_captions, update_caption.
 *
 * Configuration (environment):
 *   BRIDGECLIP_LIBRARY    use this library directory directly.
 *   BRIDGECLIP_USER_DATA  read settings.json from this app-data directory.
 * Otherwise the server auto-discovers the app's settings (BridgeClip's
 * userData) and falls back to the default library at ~/BridgeClip.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const MAX_JSON_BYTES = 32 * 1024 * 1024
/** Tool output cap: MCP results are read by a model, keep them bounded. */
const MAX_TOOL_TEXT = 48 * 1024
const MAX_TRANSCRIPT_ROWS = 40
const MAX_ROW_CHARS = 400
const MAX_RUNS_SCANNED = 200
const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,120}$/

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function boundedJson(path, label) {
  let stat
  try { stat = statSync(path) } catch { return null }
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error(`Could not read the ${label} for this run.`) }
}

// ---------------------------------------------------------------------------
// Library discovery (env override → the app's settings.json → ~/BridgeClip)
// ---------------------------------------------------------------------------

function userDataDirs() {
  if (process.env.BRIDGECLIP_USER_DATA) return [process.env.BRIDGECLIP_USER_DATA]
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming')
    return [join(appData, 'BridgeClip'), join(appData, 'bridgeclip')]
  }
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'BridgeClip'), join(home, 'Library', 'Application Support', 'bridgeclip')]
  }
  return [join(home, '.config', 'BridgeClip'), join(home, '.config', 'bridgeclip')]
}

export function resolveLibrary() {
  if (process.env.BRIDGECLIP_LIBRARY) return resolve(process.env.BRIDGECLIP_LIBRARY)
  for (const dir of userDataDirs()) {
    try {
      const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
      if (typeof settings.outputDirectory === 'string' && settings.outputDirectory.trim()) return resolve(settings.outputDirectory)
    } catch { /* Try the next candidate, then the default. */ }
  }
  return join(homedir(), 'BridgeClip')
}

const library = () => resolveLibrary()

function libraryEntries() {
  try {
    return readdirSync(library(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  } catch {
    throw new Error(`The BridgeClip library is not available at ${library()}. Start BridgeClip once, or set BRIDGECLIP_LIBRARY.`)
  }
}

function runDir(run) {
  if (typeof run !== 'string' || !RUN_NAME.test(run)) throw new Error('That run is not in the library.')
  const dir = join(library(), run)
  if (!dir.startsWith(library() + sep) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error('That run is not in the library.')
  }
  return dir
}

/** One run's parsed job output plus its marker state (favorite, editor project, modified time). */
function readRun(name) {
  const dir = runDir(name)
  const output = boundedJson(join(dir, 'job_output.json'), 'clip metadata')
  if (!output || !Array.isArray(output.clips)) return null
  return {
    name,
    dir,
    output,
    favorite: existsSync(join(dir, '.bridgeclip-favorite')),
    modified: statSync(dir).mtime.toISOString()
  }
}

function sortedRuns() {
  return libraryEntries()
    .map((entry) => { try { return readRun(entry.name) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, MAX_RUNS_SCANNED)
}

const posted = (dir, clipIndex) => existsSync(join(dir, `.bridgeclip-posted-${clipIndex}`))

function clipCard(run, clip) {
  return {
    run: run.name,
    clip_index: clip.clip_index,
    title: clip.summary ?? '',
    score: clip.virality_score,
    tags: asArray(clip.tags),
    duration_ms: clip.duration_ms,
    start_ms: clip.start_time_ms,
    end_ms: clip.end_time_ms,
    path: typeof clip.s3_url === 'string' ? clip.s3_url : null,
    posted: posted(run.dir, clip.clip_index),
    editor_clip: clip.editor_candidate ?? null
  }
}

/** Transcript rows overlapping the clip's source window, bounded for a model reader. */
function transcriptExcerpt(dir, startMs, endMs) {
  const transcript = boundedJson(join(dir, 'transcript.json'), 'transcript')
  const rows = asArray(transcript?.segments)
  const excerpt = []
  for (const row of rows) {
    if (typeof row.start_time_ms !== 'number' || typeof row.end_time_ms !== 'number') continue
    if (row.end_time_ms < startMs || row.start_time_ms > endMs) continue
    const text = typeof row.text === 'string' ? row.text.slice(0, MAX_ROW_CHARS) : ''
    if (!text) continue
    excerpt.push({ start_ms: row.start_time_ms, end_ms: row.end_time_ms, ...(row.speaker_label ? { speaker: row.speaker_label } : {}), text })
    if (excerpt.length >= MAX_TRANSCRIPT_ROWS) break
  }
  return excerpt
}

/** The run's editor project, or null when the run was never opened in the editor. */
function readEditorProject(dir) {
  const project = boundedJson(join(dir, 'editor-project.json'), 'editor project')
  if (!project || project.version !== 1 || !Array.isArray(project.candidates)) return null
  return project
}

/** caption_edits applied over the raw transcript, bounded for a model reader. */
function candidateCaptions(project, candidate) {
  const edits = new Map((candidate.caption_edits ?? []).map((edit) => [edit.segment, edit]))
  return (project.transcript ?? []).slice(0, 300).map((row, segment) => ({
    segment,
    start_ms: row.start_ms, end_ms: row.end_ms,
    text: edits.get(segment)?.text ?? row.text ?? '',
    edited: edits.has(segment)
  }))
}

function candidateForClip(project, clipIndex) {
  const byId = project.candidates.find((c) => c.id === `candidate-${clipIndex + 1}`)
  const candidate = byId ?? project.candidates[clipIndex]
  if (!candidate) throw new Error(`No editor clip ${clipIndex}. Available: ${project.candidates.map((c) => c.id).join(', ')}`)
  return candidate
}

function textResult(value) {
  let text = JSON.stringify(value, null, 2)
  if (text.length > MAX_TOOL_TEXT) text = `${text.slice(0, MAX_TOOL_TEXT - 1)}…`
  return { content: [{ type: 'text', text }] }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'bridgeclip', version: '0.1.0' })

server.registerTool('library_info', {
  title: 'BridgeClip library info',
  description: 'Where the BridgeClip library is and what it holds: run, clip, favorite and editable-project counts. Call this first.'
}, async () => {
  const runs = sortedRuns()
  return textResult({
    library: library(),
    runs: runs.length,
    clips: runs.reduce((total, run) => total + run.output.clips.length, 0),
    favorites: runs.filter((run) => run.favorite).length,
    editor_projects: runs.filter((run) => run.output.editor_project === true).length
  })
})

server.registerTool('list_runs', {
  title: 'List BridgeClip runs',
  description: 'Recent BridgeClip jobs (a run = one source video turned into clips), newest first, with clip counts and favorite status.',
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional().describe('How many runs to return (default 20)'),
    favorites_only: z.boolean().optional().describe('Only favorite runs')
  }
}, async ({ limit = 20, favorites_only = false }) => {
  const runs = sortedRuns().filter((run) => !favorites_only || run.favorite).slice(0, limit)
  return textResult({ library: library(), runs: runs.map((run) => ({
    run: run.name,
    title: typeof run.output.source_video_title === 'string' ? run.output.source_video_title : run.output.job_id ?? run.name,
    clips: run.output.clips.length,
    favorite: run.favorite,
    editor_project: run.output.editor_project === true,
    modified: run.modified
  })) })
})

server.registerTool('list_clips', {
  title: 'List the clips of a run',
  description: 'Every short clip in one BridgeClip run: title, virality score, summary, tags, duration, file path, posted status.',
  inputSchema: { run: z.string().max(121).describe('The run name from list_runs') }
}, async ({ run: name }) => {
  const run = readRun(name)
  if (!run) throw new Error('That run is not in the library.')
  return textResult({
    run: run.name,
    title: typeof run.output.source_video_title === 'string' ? run.output.source_video_title : run.output.job_id ?? run.name,
    favorite: run.favorite,
    clips: run.output.clips
      .filter((clip) => Number.isInteger(clip?.clip_index))
      .map((clip) => clipCard(run, clip))
  })
})

server.registerTool('get_clip', {
  title: 'Get one BridgeClip clip in full',
  description: 'One clip\'s complete metadata plus the transcript excerpt covering its time window.',
  inputSchema: {
    run: z.string().max(121).describe('The run name from list_runs'),
    clip_index: z.number().int().min(0).max(999).describe('The clip index from list_clips')
  }
}, async ({ run: name, clip_index }) => {
  const run = readRun(name)
  if (!run) throw new Error('That run is not in the library.')
  const clip = run.output.clips.find((entry) => entry?.clip_index === clip_index)
  if (!clip) throw new Error(`Run "${run.name}" has no clip ${clip_index}.`)
  const card = clipCard(run, clip)
  return textResult({
    ...card,
    layout: clip.layout_type ?? null,
    editor_clip: card.editor_clip,
    transcript: transcriptExcerpt(run.dir, clip.start_time_ms ?? 0, clip.end_time_ms ?? 0)
  })
})

server.registerTool('search_clips', {
  title: 'Search every BridgeClip clip',
  description: 'Free-text search across all runs (titles, summaries, tags, source video names), best virality score first.',
  inputSchema: {
    query: z.string().min(1).max(200).describe('What to look for'),
    limit: z.number().int().min(1).max(50).optional().describe('How many matches to return (default 20)')
  }
}, async ({ query, limit = 20 }) => {
  const needle = query.trim().toLowerCase()
  const matches = []
  for (const run of sortedRuns()) {
    const source = typeof run.output.source_video_title === 'string' ? run.output.source_video_title.toLowerCase() : ''
    for (const clip of run.output.clips) {
      if (!Number.isInteger(clip?.clip_index)) continue
      const haystack = [clip.summary, source, ...asArray(clip.tags)].filter((part) => typeof part === 'string').join(' ').toLowerCase()
      if (haystack.includes(needle)) matches.push(clipCard(run, clip))
      if (matches.length >= limit * 3) break
    }
    if (matches.length >= limit * 3) break
  }
  matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return textResult({ query, matches: matches.slice(0, limit) })
})

server.registerTool('get_editor_project', {
  title: 'Get a run editor project',
  description: 'The editor project of a run: every editable clip (id, title, status, virality score, cut count) with the project revision. Use a candidate id with get_captions.',
  inputSchema: { run: z.string().max(121).describe('The run name from list_runs') }
}, async ({ run: name }) => {
  const run = readRun(name)
  if (!run) throw new Error('That run is not in the library.')
  const project = readEditorProject(run.dir)
  if (!project) throw new Error('This run has no editor project. Open it once with "Edit this" in BridgeClip.')
  return textResult({
    run: run.name, revision: project.revision, aspect_ratio: project.aspect_ratio,
    clips: project.candidates.map((c) => ({
      candidate_id: c.id, title: c.title ?? '', status: c.status ?? 'refining',
      score: c.score ?? null, cuts: (c.ranges ?? []).length,
      caption_edits: (c.caption_edits ?? []).length
    }))
  })
})

server.registerTool('get_captions', {
  title: 'Get the captions of an editor clip',
  description: 'Every caption line of one editor clip (segment index, time, text), with the user edits already applied and an `edited` flag. `segment` is what update_caption expects.',
  inputSchema: {
    run: z.string().max(121).describe('The run name from list_runs'),
    clip_index: z.number().int().min(0).max(999).describe('The clip index from list_clips')
  }
}, async ({ run: name, clip_index }) => {
  const run = readRun(name)
  if (!run) throw new Error('That run is not in the library.')
  const project = readEditorProject(run.dir)
  if (!project) throw new Error('This run has no editor project.')
  const candidate = candidateForClip(project, clip_index)
  return textResult({
    run: run.name, candidate_id: candidate.id, revision: project.revision,
    captions: candidateCaptions(project, candidate)
  })
})

server.registerTool('update_caption', {
  title: 'Fix one caption line of an editor clip',
  description: 'Rewrites one caption line (by segment index from get_captions) of an editor clip and bumps the revision atomically. BridgeClip picks the change up on reopen. Best used while the app is closed.',
  inputSchema: {
    run: z.string().max(121).describe('The run name from list_runs'),
    clip_index: z.number().int().min(0).max(999).describe('The clip index from list_clips'),
    segment: z.number().int().min(0).max(9999).describe('The caption segment from get_captions'),
    text: z.string().min(1).max(2000).describe('The corrected caption text')
  }
}, async ({ run: name, clip_index, segment, text }) => {
  const run = readRun(name)
  if (!run) throw new Error('That run is not in the library.')
  const path = join(run.dir, 'editor-project.json')
  const project = readEditorProject(run.dir)
  if (!project) throw new Error('This run has no editor project.')
  const candidate = candidateForClip(project, clip_index)
  const rows = project.transcript ?? []
  if (segment >= rows.length) throw new Error(`Segment ${segment} does not exist (this clip has ${rows.length} transcript lines).`)
  const clean = text.replace(/[ -]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('The corrected caption cannot be empty.')
  const original = String(rows[segment].text ?? '')
  const edits = (candidate.caption_edits ?? []).filter((edit) => edit.segment !== segment)
  if (clean !== original.trim()) edits.push({ segment, text: clean.slice(0, 2000) })
  candidate.caption_edits = edits
  project.revision = (project.revision ?? 0) + 1
  const temp = `${path}.mcp-${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(project), { mode: 0o600 })
  renameSync(temp, path)
  return textResult({ run: run.name, candidate_id: candidate.id, segment, text: clean, revision: project.revision })
})

const transport = new StdioServerTransport()
await server.connect(transport)
