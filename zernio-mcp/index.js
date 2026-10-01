#!/usr/bin/env node
/**
 * Zernio MCP server — control social publishing through Zernio's REST API
 * (https://zernio.com/api/v1, contract mirrored from BridgeClip's client).
 *
 * Tools: list_profiles, list_accounts, account_health, tiktok_creator_info,
 * upload_media, create_post, get_post, reschedule_post, delete_post, retry_post.
 *
 * Configuration (environment):
 *   ZERNIO_API_KEY   required for API calls — generate at
 *                    zernio.com/dashboard/api-keys (Read & Write).
 *   ZERNIO_BASE_URL  optional override for tests (default https://zernio.com/api/v1).
 */

import { readFile, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE_URL = (process.env.ZERNIO_BASE_URL || 'https://zernio.com/api/v1').replace(/\/+$/, '')
/** Spec paths start with /v1; API calls join them onto the origin. */
const API_ORIGIN = BASE_URL.endsWith('/v1') ? BASE_URL.slice(0, -3) : BASE_URL
const REQUEST_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024
/** Tool output cap: MCP results are read by a model, keep them bounded. */
const MAX_TOOL_TEXT = 48 * 1024

const PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook', 'twitter', 'linkedin', 'threads']

// ---------------------------------------------------------------------------
// Small shared helpers (mirrors of BridgeClip's client, trimmed for a CLI tool)
// ---------------------------------------------------------------------------

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function str(value) {
  return typeof value === 'string' && value ? value : undefined
}

/** Provider text is untrusted: strip control chars, links and credential-looking runs. */
function sanitizeProviderText(value, max = 300) {
  if (typeof value !== 'string') return undefined
  let text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted]')
    .replace(/\b(?:sk|pk|rk|zrk|key|token|secret)[_-][A-Za-z0-9_-]{6,}/gi, '[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`
  return text || undefined
}

/** Zernio wraps lists as `{ profiles: [...] }`, `{ accounts: [...] }`, `{ posts: [...] }`, or a bare array. */
function extractCollection(value) {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const key of ['profiles', 'accounts', 'posts', 'data', 'items']) {
    if (Array.isArray(record[key])) return record[key]
  }
  return []
}

function unwrap(value, key) {
  const record = asRecord(value)
  const inner = asRecord(record[key])
  return Object.keys(inner).length > 0 ? inner : record
}

function waitText(seconds) {
  if (!seconds) return 'a minute'
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} h`
  return seconds < 90 ? `${Math.ceil(seconds)}s` : `${Math.ceil(seconds / 60)} min`
}

function retryAfterSeconds(headers, body) {
  const retryAfter = headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds) || 1, 3600)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(Math.max(1, Math.ceil((date - Date.now()) / 1000)), 3600)
  }
  const fromBody = Number(asRecord(body.details).retryAfterSeconds)
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.min(Math.ceil(fromBody), 3600)
  return null
}

/** Friendly, safe error text for a non-OK Zernio response. */
function errorFor(status, body, headers) {
  const code = typeof body.code === 'string' ? body.code : null
  const detail = sanitizeProviderText(body.error ?? body.message)
  if (status === 401) return new Error('Zernio rejected the API key. Check ZERNIO_API_KEY (zernio.com/dashboard/api-keys).')
  if (status === 402) return new Error('Zernio reports a billing gate on this workspace. Check the billing page in your Zernio dashboard.')
  if (status === 429) {
    const seconds = retryAfterSeconds(headers, body)
    return new Error(`Zernio rate limited this request. Retry after ${waitText(seconds)}.${
      code && code !== 'rate_limited' && detail ? ` (${code}: ${detail})` : ''}`)
  }
  if (status === 409 && code === 'duplicate_post') {
    const existing = str(asRecord(body.details).existingPostId) ?? str(body.existingPostId)
    return new Error(`Zernio already has this exact post from the last 24 hours${existing ? ` (post ${existing})` : ''}.`)
  }
  if (status === 403 && code === 'ACCOUNT_DISCONNECTED') return new Error('That account needs to sign in again. Reconnect it in the Zernio dashboard.')
  if (status === 404) return new Error(detail ? `Zernio could not find that: ${detail}` : 'Zernio could not find that resource.')
  if (status === 503 || status >= 500) return new Error(`Zernio had a problem on its side (HTTP ${status}). Try again in a minute.`)
  return new Error(`Zernio rejected the request (HTTP ${status}${code ? `, ${code}` : ''}${detail ? `: ${detail}` : ''}).`)
}

async function readBody(response) {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('Zernio response exceeds the size limit.')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

async function api(method, path, options = {}) {
  const apiKey = process.env.ZERNIO_API_KEY
  if (!apiKey) {
    throw new Error('ZERNIO_API_KEY is not set. Add your Zernio API key (zernio.com/dashboard/api-keys, Read & Write) to this MCP server\'s environment.')
  }
  let response
  let body
  try {
    // Spec paths start with /v1 while BASE_URL already ends in /v1: join spec
    // paths onto the origin, everything else onto BASE_URL itself.
    const url = path.startsWith('/v1/') ? `${API_ORIGIN}${path}` : `${BASE_URL}${path}`
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(options.requestId ? { 'x-request-id': options.requestId } : {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    })
    body = await readBody(response)
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new Error(timedOut ? 'Zernio took too long to answer.' : 'Could not reach Zernio. Check the network and try again.')
  }
  if (!response.ok) throw errorFor(response.status, asRecord(body), response.headers)
  return body
}

const isLoopback = (value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

/** Upload targets must be HTTPS without credentials (loopback http only for a dev mock). */
function isUploadUrl(value, allowLoopback = false) {
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    if (!allowLoopback && url.port !== '' && url.port !== '443') return false
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!allowLoopback && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        (isIP(host) !== 0 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:|fc|fd)/.test(host)))) return false
    return url.protocol === 'https:' || (allowLoopback && isLoopback(value))
  } catch {
    return false
  }
}

function validTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}

function isAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value)
}

function parseAccountsPage(value) {
  return extractCollection(value)
    .map((item) => {
      const account = asRecord(item)
      const id = str(account._id) ?? str(account.id)
      const platform = str(account.platform)?.toLowerCase() ?? ''
      if (!isAccountId(id) || !PLATFORMS.includes(platform)) return null
      const rawProfile = account.profileId
      return {
        id,
        platform,
        username: str(account.username) ?? null,
        displayName: str(account.displayName) ?? null,
        profileId: (typeof rawProfile === 'object' ? str(asRecord(rawProfile)._id) : str(rawProfile)) ?? null,
        isActive: account.isActive !== false,
        needsReconnect: account.needsReconnection === true
      }
    })
    .filter(Boolean)
}

function parseProfilesPage(value) {
  return extractCollection(value)
    .map((item) => {
      const profile = asRecord(item)
      const id = str(profile._id) ?? str(profile.id)
      if (!isAccountId(id)) return null
      return {
        id,
        name: str(profile.name) ?? 'Untitled profile',
        ...(profile.isDefault === true ? { isDefault: true } : {}),
        ...(profile.isOverLimit === true ? { isOverLimit: true } : {})
      }
    })
    .filter(Boolean)
}

function toolText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (text.length > MAX_TOOL_TEXT) return `${text.slice(0, MAX_TOOL_TEXT)}\n… (truncated)`
  return text
}

const ok = (value) => ({ content: [{ type: 'text', text: toolText(value) }] })
const fail = (error) => ({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true })

// ---------------------------------------------------------------------------
// Server and tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'zernio', version: '0.1.0' })

server.registerTool('list_profiles', {
  title: 'List Zernio profiles',
  description: 'Every Zernio workspace profile (default first, over-limit ones flagged). Use a profileId to filter accounts.',
  inputSchema: {}
}, async () => {
  const profiles = []
  for (let page = 0; page < 50; page += 1) {
    const response = await api('GET', `/profiles?includeOverLimit=true&limit=100&skip=${page * 100}`)
    const batch = parseProfilesPage(response)
    for (const profile of batch) if (!profiles.some((p) => p.id === profile.id)) profiles.push(profile)
    const total = Number(asRecord(response).total)
    if (batch.length < 100 || (Number.isFinite(total) && (page + 1) * 100 >= total)) break
  }
  return ok({ profiles })
})

server.registerTool('list_accounts', {
  title: 'List connected accounts',
  description: 'Connected social accounts (tiktok, youtube, instagram, facebook, twitter, linkedin, threads) with their Zernio accountId — the id posts are sent to.',
  inputSchema: {
    profileId: z.string().min(8).max(64).optional().describe('Only accounts of this Zernio profile'),
    platform: z.enum(PLATFORMS).optional().describe('Only accounts on this platform')
  }
}, async ({ profileId, platform }) => {
  const accounts = []
  for (let page = 1; page <= 50; page += 1) {
    const params = new URLSearchParams({ includeOverLimit: 'true', page: String(page), limit: '100' })
    if (profileId) params.set('profileId', profileId)
    if (platform) params.set('platform', platform)
    const response = await api('GET', `/accounts?${params}`)
    const batch = parseAccountsPage(response)
    for (const account of batch) if (!accounts.some((a) => a.id === account.id)) accounts.push(account)
    const pages = Number(asRecord(asRecord(response).pagination).pages)
    if (!Number.isFinite(pages) || page >= pages || batch.length === 0) break
  }
  return ok({ accounts })
})

server.registerTool('account_health', {
  title: 'Account health',
  description: 'Per-account health: healthy/warning/error, whether it can post, and the first issue. Run this before posting if an account misbehaves.',
  inputSchema: {}
}, async () => {
  const result = await api('GET', '/accounts/health')
  const rows = extractCollection(result).map((item) => {
    const row = asRecord(item)
    const id = str(row.accountId) ?? str(row.id) ?? str(row._id)
    const issues = Array.isArray(row.issues) ? row.issues.filter((issue) => typeof issue === 'string') : []
    const status = str(row.status)
    return {
      accountId: id ?? null,
      health: ['healthy', 'warning', 'error'].includes(status) ? status : null,
      canPost: typeof row.canPost === 'boolean' ? row.canPost : null,
      needsReconnect: row.needsReconnect === true,
      issue: sanitizeProviderText(issues[0], 160) ?? null
    }
  })
  return ok({ accounts: rows })
})

server.registerTool('tiktok_creator_info', {
  title: 'TikTok creator info',
  description: 'Allowed privacy levels, interaction toggles and video duration limit for a TikTok account. Use it to pick a valid privacyLevel before posting.',
  inputSchema: { accountId: z.string().min(8).max(64).describe('Zernio accountId of the TikTok account') }
}, async ({ accountId }) => {
  if (!isAccountId(accountId)) throw new Error('Invalid TikTok account id.')
  const body = await api('GET', `/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info?mediaType=video`)
  return ok(unwrap(body, 'creator'))
})

server.registerTool('upload_media', {
  title: 'Upload a video to Zernio',
  description: 'Presigns and uploads a local video file (mp4 recommended) and returns the publicUrl to reference in create_post mediaItems.',
  inputSchema: {
    path: z.string().min(1).describe('Absolute path of the video file on this machine'),
    contentType: z.string().default('video/mp4').describe('MIME type of the file')
  }
}, async ({ path, contentType }) => {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`File not found: ${path}`)
  if (info.size <= 0) throw new Error('The file is empty.')
  if (info.size > MAX_UPLOAD_BYTES) throw new Error('The file exceeds the 500 MB upload limit.')
  const body = await api('POST', '/media/presign', {
    body: { filename: basename(path), contentType, size: info.size }
  })
  const uploadUrl = str(body.uploadUrl)
  const publicUrl = str(body.publicUrl)
  const allowLoopback = BASE_URL !== 'https://zernio.com/api/v1' && isLoopback(`${BASE_URL}/`)
  if (!uploadUrl || !isUploadUrl(uploadUrl, allowLoopback) || !publicUrl || !isUploadUrl(publicUrl, allowLoopback)) {
    throw new Error('Zernio did not return a secure upload link.')
  }
  const bytes = await readFile(path)
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (!response.ok) throw new Error(`The upload failed (HTTP ${response.status}).`)
  return ok({ publicUrl, bytes: info.size, contentType })
})

const accountTarget = z.object({
  platform: z.enum(PLATFORMS).describe('Social platform of the account'),
  accountId: z.string().min(8).max(64).describe('Zernio accountId from list_accounts'),
  customContent: z.string().max(63206).optional().describe('Per-account caption override')
})

server.registerTool('create_post', {
  title: 'Create or schedule a post',
  description: 'Posts a video now or schedules it, to one or more accounts. Get accountIds from list_accounts and the video URL from upload_media (or any public https video URL).',
  inputSchema: {
    caption: z.string().min(1).max(63206).describe('Post caption (the main text)'),
    videoUrl: z.string().url().describe('Public https URL of the video (publicUrl from upload_media)'),
    accounts: z.array(accountTarget).min(1).max(20).describe('Accounts to post to'),
    when: z.object({
      mode: z.literal('now')
    }).or(z.object({
      mode: z.literal('schedule'),
      scheduledFor: z.string().describe('ISO 8601 datetime, e.g. 2026-10-03T18:00:00Z or 2026-10-03T18:00:00'),
      timezone: z.string().describe('IANA time zone of scheduledFor, e.g. Europe/Bucharest')
    })).describe("Publish now or schedule; a bare datetime without offset is read in 'timezone'"),
    youtube: z.object({
      title: z.string().min(1).max(100),
      visibility: z.enum(['public', 'unlisted', 'private']).default('public'),
      tags: z.array(z.string().min(1).max(100)).max(20).optional(),
      categoryId: z.string().regex(/^\d{1,3}$/).optional(),
      madeForKids: z.boolean().default(false)
    }).optional().describe('Required when posting to youtube (title at least)'),
    tiktok: z.object({
      privacyLevel: z.string().regex(/^[A-Z_]{1,64}$/).optional().describe('From tiktok_creator_info, e.g. PUBLIC_TO_EVERYONE'),
      allowComment: z.boolean().default(false),
      allowDuet: z.boolean().default(false),
      allowStitch: z.boolean().default(false),
      disclose: z.boolean().default(false),
      yourBrand: z.boolean().default(false),
      brandedContent: z.boolean().default(false),
      madeWithAi: z.boolean().default(false),
      draft: z.boolean().default(false).describe('Save as a TikTok draft instead of publishing'),
      consent: z.boolean().default(false).describe('Set true only after the user confirmed TikTok\'s content declaration')
    }).optional().describe('TikTok choices; privacyLevel comes from tiktok_creator_info'),
    instagram: z.object({ shareToFeed: z.boolean().default(true) }).optional(),
    facebook: z.object({
      format: z.enum(['feed', 'reel']).default('feed'),
      title: z.string().min(1).max(80).optional().describe('Reels only: one-line title')
    }).optional(),
    threads: z.object({ topicTag: z.string().min(1).max(50).optional() }).optional()
  }
}, async (input) => {
  const { caption, videoUrl, accounts, when, youtube, tiktok, instagram, facebook, threads } = input
  const platformsWanted = new Set(accounts.map((target) => target.platform))
  if (platformsWanted.has('youtube') && !youtube?.title) {
    throw new Error('YouTube posts need a title (when posting to youtube, pass youtube.title).')
  }
  const video = new URL(videoUrl)
  if (video.protocol !== 'https:' || video.username || video.password) {
    throw new Error('videoUrl must be a public https URL without credentials.')
  }
  if (when.mode === 'schedule') {
    if (!Number.isFinite(Date.parse(when.scheduledFor))) throw new Error('scheduledFor is not a valid datetime.')
    if (!validTimeZone(when.timezone)) throw new Error(`timezone is not a valid IANA zone: ${when.timezone}`)
  }

  const tiktokShared = tiktok ? {
    content_preview_confirmed: tiktok.consent,
    express_consent_given: tiktok.consent,
    video_made_with_ai: tiktok.madeWithAi,
    ...(tiktok.draft ? { draft: true } : {}),
    ...(tiktok.disclose && tiktok.brandedContent
      ? { commercialContentType: 'brand_content', ...(tiktok.yourBrand ? { isBrandOrganicPost: true } : {}) }
      : tiktok.disclose && tiktok.yourBrand ? { commercialContentType: 'brand_organic' } : {})
  } : null

  const platforms = accounts.map((target) => {
    const data = {}
    if (target.platform === 'youtube' && youtube) {
      data.title = youtube.title
      data.visibility = youtube.visibility
      data.madeForKids = youtube.madeForKids
      if (youtube.categoryId) data.categoryId = youtube.categoryId
    }
    if (target.platform === 'instagram' && instagram) data.shareToFeed = instagram.shareToFeed
    if (target.platform === 'facebook' && facebook?.format === 'reel') {
      data.contentType = 'reel'
      if (facebook.title) data.title = facebook.title
    }
    if (target.platform === 'threads' && threads?.topicTag) data.topic_tag = threads.topicTag
    if (target.platform === 'tiktok' && tiktokShared) {
      data.tiktokSettings = {
        ...tiktokShared,
        privacy_level: tiktok?.privacyLevel ?? '',
        allow_comment: tiktok?.allowComment ?? false,
        allow_duet: tiktok?.allowDuet ?? false,
        allow_stitch: tiktok?.allowStitch ?? false
      }
    }
    return {
      platform: target.platform,
      accountId: target.accountId,
      ...(target.customContent ? { customContent: target.customContent } : {}),
      ...(Object.keys(data).length > 0 ? { platformSpecificData: data } : {})
    }
  })

  const body = {
    content: caption,
    mediaItems: [{ type: 'video', url: videoUrl }],
    platforms,
    metadata: { source: 'zernio-mcp' }
  }
  if (youtube?.tags?.length) body.tags = youtube.tags
  if (when.mode === 'now') body.publishNow = true
  else {
    body.scheduledFor = new Date(when.scheduledFor).toISOString()
    body.timezone = when.timezone
  }
  if (tiktokShared && platformsWanted.has('tiktok')) body.tiktokSettings = tiktokShared

  const response = await api('POST', '/posts', { body, requestId: randomUUID(), timeoutMs: 120_000 })
  const created = asRecord(response)
  return ok({
    replayed: Object.keys(asRecord(created.existingPost)).length > 0,
    post: asRecord(created.post),
    platformResults: Array.isArray(created.platformResults) ? created.platformResults.map(asRecord) : [],
    warnings: Array.isArray(created.warnings) ? created.warnings.map((w) => sanitizeProviderText(w)).filter(Boolean) : [],
    error: sanitizeProviderText(created.error) ?? null
  })
})

server.registerTool('list_posts', {
  title: 'List posts (calendar)',
  description: 'Paginated post history and calendar: filter by date window (fromDate/toDate, YYYY-MM-DD or ISO), status, platform, account or free-text search. Published posts carry platformPostUrl. source=external also returns posts made outside Zernio, synced from the platforms (~12 months per account).',
  inputSchema: {
    fromDate: z.string().optional().describe('Window start: YYYY-MM-DD or ISO 8601'),
    toDate: z.string().optional().describe('Window end: YYYY-MM-DD or ISO 8601'),
    status: z.enum(['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled']).optional(),
    platform: z.enum(PLATFORMS).optional(),
    accountId: z.string().optional().describe('Zernio accountId from list_accounts'),
    profileId: z.string().optional().describe('Omit for every profile'),
    search: z.string().max(200).optional().describe('Full-text search on post content'),
    source: z.enum(['zernio', 'external']).default('zernio').describe('zernio = authored via Zernio/API; external = synced from the platforms'),
    sortBy: z.enum(['scheduled-desc', 'scheduled-asc', 'created-desc', 'created-asc', 'status', 'platform']).default('scheduled-desc'),
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(500).default(50)
  }
}, async (filters) => {
  const params = new URLSearchParams({
    source: filters.source,
    sortBy: filters.sortBy,
    page: String(filters.page),
    limit: String(filters.limit)
  })
  for (const key of ['fromDate', 'toDate', 'status', 'platform', 'accountId', 'profileId', 'search']) {
    if (filters[key]) params.set(key, String(filters[key]))
  }
  const response = await api('GET', `/posts?${params}`)
  const posts = extractCollection(response).map((item) => {
    const post = asRecord(item)
    return {
      id: str(post._id) ?? str(post.id) ?? null,
      status: str(post.status) ?? null,
      scheduledFor: str(post.scheduledFor) ?? null,
      timezone: str(post.timezone) ?? null,
      title: sanitizeProviderText(post.title, 120) ?? null,
      content: sanitizeProviderText(post.content, 200) ?? null,
      tags: Array.isArray(post.tags) ? post.tags.filter((tag) => typeof tag === 'string').slice(0, 10) : [],
      createdAt: str(post.createdAt) ?? null,
      platforms: (Array.isArray(post.platforms) ? post.platforms.map(asRecord) : []).map((entry) => ({
        platform: str(entry.platform) ?? null,
        account: str(asRecord(entry.accountId).username) ?? null,
        status: str(entry.status) ?? null,
        url: str(entry.platformPostUrl) ?? null
      }))
    }
  })
  return ok({ posts, pagination: asRecord(asRecord(response).pagination) })
})

server.registerTool('get_post', {
  title: 'Get a post',
  description: 'One post with its status (draft/scheduled/publishing/published/partial/failed/cancelled), per-platform results and links.',
  inputSchema: { postId: z.string().min(8).max(64) }
}, async ({ postId }) => ok(await api('GET', `/posts/${encodeURIComponent(postId)}`)))

server.registerTool('reschedule_post', {
  title: 'Reschedule a post',
  description: 'Moves a scheduled (not yet published) post to a new time.',
  inputSchema: {
    postId: z.string().min(8).max(64),
    scheduledFor: z.string().describe('ISO 8601 datetime'),
    timezone: z.string().describe('IANA time zone of scheduledFor, e.g. Europe/Bucharest')
  }
}, async ({ postId, scheduledFor, timezone }) => {
  if (!Number.isFinite(Date.parse(scheduledFor))) throw new Error('scheduledFor is not a valid datetime.')
  if (!validTimeZone(timezone)) throw new Error(`timezone is not a valid IANA zone: ${timezone}`)
  return ok(await api('PUT', `/posts/${encodeURIComponent(postId)}`, {
    body: { scheduledFor: new Date(scheduledFor).toISOString(), timezone }
  }))
})

server.registerTool('delete_post', {
  title: 'Delete a post',
  description: 'Deletes a draft or scheduled post. Published posts are rejected (HTTP 400) by Zernio.',
  inputSchema: { postId: z.string().min(8).max(64) }
}, async ({ postId }) => {
  await api('DELETE', `/posts/${encodeURIComponent(postId)}`)
  return ok({ deleted: true, postId })
})

server.registerTool('retry_post', {
  title: 'Retry a failed post',
  description: 'Retries the failed platforms of a failed or partial post.',
  inputSchema: { postId: z.string().min(8).max(64) }
}, async ({ postId }) => {
  const response = await api('POST', `/posts/${encodeURIComponent(postId)}/retry`, { timeoutMs: 120_000 })
  const body = asRecord(response)
  return ok({ post: asRecord(body.post), error: sanitizeProviderText(body.error) ?? null })
})

// ---------------------------------------------------------------------------
// Full-API coverage: endpoint index + generic invocation
// ---------------------------------------------------------------------------

const specRoot = dirname(fileURLToPath(import.meta.url))
let SPEC_INDEX = []
try {
  SPEC_INDEX = JSON.parse(readFileSync(join(specRoot, 'openapi-paths.json'), 'utf8'))
} catch {
  process.stderr.write('zernio-mcp: openapi-paths.json is missing; list_endpoints/call_endpoint are disabled. Run scripts/build-paths.mjs.\n')
}

server.registerTool('list_endpoints', {
  title: 'Discover Zernio API endpoints',
  description: `Searches the full Zernio OpenAPI index (${SPEC_INDEX.length} endpoints: publishing, queue, analytics, inbox, ads, whatsapp, commerce, workflows, webhooks…). Use it to find the exact path for call_endpoint. Without a search it returns the endpoint count per resource group.`,
  inputSchema: {
    search: z.string().max(100).optional().describe('Keyword matched against path, summary, operationId and group'),
    limit: z.number().int().min(1).max(100).default(30)
  }
}, async ({ search, limit }) => {
  if (!search) {
    const groups = {}
    for (const endpoint of SPEC_INDEX) {
      const group = endpoint.group ?? endpoint.tag ?? 'other'
      groups[group] = (groups[group] ?? 0) + 1
    }
    return ok({
      total: SPEC_INDEX.length,
      groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1])),
      hint: 'Pass search (e.g. "queue", "analytics best-time", "whatsapp") to list matching endpoints, then call them with call_endpoint.'
    })
  }
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = SPEC_INDEX
    .filter((endpoint) => {
      const haystack = `${endpoint.path} ${endpoint.summary ?? ''} ${endpoint.operationId ?? ''} ${endpoint.group ?? ''}`.toLowerCase()
      return tokens.every((token) => haystack.includes(token))
    })
    .slice(0, limit)
  return ok({ total: SPEC_INDEX.length, matches: `${matches.length} of ${SPEC_INDEX.length}`, endpoints: matches })
})

server.registerTool('call_endpoint', {
  title: 'Call any Zernio API endpoint',
  description: `Invokes any of the ${SPEC_INDEX.length} endpoints in Zernio's API, validated against their OpenAPI spec — the typed tools above only cover the core publishing flows. Fill path parameters (e.g. /v1/posts/{postId} → /v1/posts/abc123). Discover paths with list_endpoints.`,
  inputSchema: {
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    path: z.string().min(2).describe('Spec path, e.g. /v1/analytics/best-time or /v1/queue/slots'),
    query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Query parameters'),
    body: z.record(z.unknown()).optional().describe('JSON request body (POST/PUT/PATCH)')
  }
}, async ({ method, path, query, body }) => {
  if (SPEC_INDEX.length === 0) throw new Error('The endpoint index is unavailable; run scripts/build-paths.mjs in zernio-mcp/.')
  let normalized = path.trim()
  if (!normalized.startsWith('/')) normalized = `/${normalized}`
  if (!normalized.startsWith('/v1/')) normalized = `/v1${normalized}`
  normalized = normalized.replace(/\/+$/, '') || '/v1'
  if (normalized.includes('{')) throw new Error('The path still contains an unfilled {parameter} placeholder.')

  const known = SPEC_INDEX.some((endpoint) => endpoint.path === normalized && endpoint.method === method)
  if (!known) {
    const pathKnown = SPEC_INDEX.some((endpoint) => endpoint.path === normalized)
    const fragment = normalized.split('/').filter((part) => !part.startsWith('v1')).slice(-2).join('/')
    const suggestions = [...new Set(SPEC_INDEX
      .filter((endpoint) => endpoint.path.includes(fragment) || endpoint.path.includes(normalized))
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`))].slice(0, 5)
    throw new Error(pathKnown
      ? `${method} is not allowed on ${normalized}. Available: ${suggestions.join(' · ') || 'none'}.`
      : `${method} ${normalized} is not in Zernio's API. Closest: ${suggestions.join(' · ') || 'none'}. Use list_endpoints to search.`)
  }

  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) searchParams.set(key, String(value))
  const suffix = searchParams.size > 0 ? `?${searchParams}` : ''
  return ok(await api(method, `${normalized}${suffix}`, { body }))
})

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  if (!process.env.ZERNIO_API_KEY) {
    process.stderr.write('zernio-mcp: ZERNIO_API_KEY is not set; API tools will explain how to add it until then.\n')
  }
}

main().catch((error) => {
  process.stderr.write(`zernio-mcp failed to start: ${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
})
