/**
 * Offline smoke test: a local mock of the Zernio API plus a real MCP session
 * over stdio. Verifies the handshake, tool listing, and the three main flows
 * (list accounts, upload media, create a scheduled post).
 *
 * Run: npm test   (from zernio-mcp/)
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// ---- Mock Zernio API --------------------------------------------------------

let uploaded = null
const mock = createServer((request, response) => {
  const send = (status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    response.end(JSON.stringify(body))
  }
  // The storage PUT is pre-signed and unauthenticated by design.
  if (request.method === 'PUT' && request.url === '/storage/upload') {
    let size = 0
    request.on('data', (chunk) => { size += chunk.length })
    request.on('end', () => { uploaded = size; send(200, {}) })
    return
  }
  if (request.headers.authorization !== 'Bearer test-key') return send(401, { error: 'invalid key' })
  if (request.method === 'GET' && request.url.startsWith('/accounts/health')) {
    return send(200, { accounts: [{ accountId: 'acct_tiktok_0001', status: 'healthy', canPost: true }] })
  }
  if (request.method === 'GET' && request.url.startsWith('/accounts')) {
    return send(200, { accounts: [{ _id: 'acct_tiktok_0001', platform: 'tiktok', username: 'demo', profileId: 'prof_0001', isActive: true }] })
  }
  if (request.method === 'POST' && request.url === '/media/presign') {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => send(200, {
      uploadUrl: `http://127.0.0.1:${mock.address().port}/storage/upload`,
      publicUrl: `https://cdn.example.test/video-${JSON.parse(body).size}.mp4`
    }))
    return
  }
  if (request.method === 'GET' && request.url.startsWith('/v1/queue/slots')) {
    const query = new URL(request.url, 'http://x').searchParams
    assert.equal(query.get('profileId'), 'prof_0001')
    return send(200, { exists: true, schedule: { name: 'Morning Posts', timezone: 'Europe/Bucharest', slots: [{ dayOfWeek: 1, time: '18:00' }] } })
  }
  if (request.method === 'GET' && request.url.startsWith('/posts?')) {
    const query = new URL(request.url, 'http://x').searchParams
    assert.equal(query.get('source'), 'zernio')
    assert.equal(query.get('sortBy'), 'scheduled-desc')
    assert.equal(query.get('fromDate'), '2026-10-01')
    assert.equal(query.get('status'), 'published')
    return send(200, {
      posts: [{
        _id: 'post_0001', status: 'published', scheduledFor: '2026-10-01T18:00:00.000Z',
        content: 'Demo post content', createdAt: '2026-10-01T17:00:00.000Z',
        platforms: [{ platform: 'tiktok', accountId: { _id: 'acct_tiktok_0001', username: 'demo' }, status: 'published', platformPostUrl: 'https://www.tiktok.com/@demo/video/123' }]
      }],
      pagination: { page: 1, limit: 50, total: 1, pages: 1 }
    })
  }
  if (request.method === 'POST' && request.url === '/posts') {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      const payload = JSON.parse(body)
      assert.equal(payload.metadata.source, 'zernio-mcp')
      assert.equal(payload.publishNow, undefined)
      assert.equal(typeof payload.scheduledFor, 'string')
      assert.equal(payload.timezone, 'Europe/Bucharest')
      assert.equal(payload.platforms[0].accountId, 'acct_tiktok_0001')
      assert.equal(payload.platforms[0].platformSpecificData.tiktokSettings.privacy_level, 'PUBLIC_TO_EVERYONE')
      send(201, { post: { _id: 'post_0001', status: 'scheduled', scheduledFor: payload.scheduledFor }, platformResults: [] })
    })
    return
  }
  send(404, { error: `no mock for ${request.method} ${request.url}` })
})

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${mock.address().port}`

// ---- Minimal MCP stdio client ------------------------------------------------

const child = spawn(process.execPath, [join(root, 'index.js')], {
  env: { ...process.env, ZERNIO_API_KEY: 'test-key', ZERNIO_BASE_URL: baseUrl },
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
      else resolve(message.result)
    })
    setTimeout(() => reject(new Error(`${method} timed out`)), 15000).unref()
  })
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

try {
  const init = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.1' }
  })
  assert.equal(init.serverInfo.name, 'zernio')
  notify('notifications/initialized', {})

  const tools = await request('tools/list', {})
  const names = tools.tools.map((tool) => tool.name)
  for (const expected of ['list_profiles', 'list_accounts', 'account_health', 'tiktok_creator_info',
    'upload_media', 'create_post', 'list_posts', 'get_post', 'reschedule_post', 'delete_post', 'retry_post',
    'list_endpoints', 'call_endpoint']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`)
  }

  const accounts = await request('tools/call', { name: 'list_accounts', arguments: {} })
  assert.match(JSON.stringify(accounts), /acct_tiktok_0001/)
  assert.doesNotMatch(JSON.stringify(accounts), /test-key/, 'the key must never appear in tool output')

  const health = await request('tools/call', { name: 'account_health', arguments: {} })
  assert.match(JSON.stringify(health), /healthy/)

  const mediaPath = join(root, 'test', 'fixture.mp4')
  const fixtureBytes = Buffer.from('demo video bytes for the upload smoke test')
  await readFile(mediaPath).catch(async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(mediaPath, fixtureBytes)
  })
  const upload = await request('tools/call', { name: 'upload_media', arguments: { path: mediaPath } })
  const publicUrl = JSON.parse(upload.content[0].text).publicUrl
  assert.match(publicUrl, /^https:\/\/cdn\.example\.test\//)
  assert.equal(uploaded, fixtureBytes.length, 'the file bytes reached the storage PUT')

  const post = await request('tools/call', {
    name: 'create_post',
    arguments: {
      caption: 'Demo post from the zernio-mcp smoke test',
      videoUrl: publicUrl,
      accounts: [{ platform: 'tiktok', accountId: 'acct_tiktok_0001' }],
      when: { mode: 'schedule', scheduledFor: '2026-10-03T18:00:00', timezone: 'Europe/Bucharest' },
      tiktok: { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true }
    }
  })
  assert.match(JSON.stringify(post), /post_0001/)
  assert.match(JSON.stringify(post), /scheduled/)

  const history = await request('tools/call', {
    name: 'list_posts',
    arguments: { fromDate: '2026-10-01', toDate: '2026-10-31', status: 'published' }
  })
  const listed = JSON.parse(history.content[0].text)
  assert.equal(listed.posts.length, 1)
  assert.equal(listed.posts[0].platforms[0].url, 'https://www.tiktok.com/@demo/video/123')
  assert.equal(listed.pagination.total, 1)

  // Full-API coverage: discovery + generic invocation validated against the spec.
  const groups = JSON.parse((await request('tools/call', { name: 'list_endpoints', arguments: {} })).content[0].text)
  assert.ok(groups.total > 900, `expected the full spec index, got ${groups.total}`)
  assert.ok(groups.groups.publishing > 0)

  const queue = JSON.parse((await request('tools/call', { name: 'list_endpoints', arguments: { search: 'queue slots' } })).content[0].text)
  assert.ok(queue.endpoints.some((endpoint) => endpoint.path === '/v1/queue/slots'), JSON.stringify(queue.endpoints))

  const slots = JSON.parse((await request('tools/call', {
    name: 'call_endpoint',
    arguments: { method: 'GET', path: '/v1/queue/slots', query: { profileId: 'prof_0001' } }
  })).content[0].text)
  assert.equal(slots.schedule.timezone, 'Europe/Bucharest')

  const unknown = await request('tools/call', {
    name: 'call_endpoint',
    arguments: { method: 'GET', path: '/v1/definitely/not/in/spec' }
  })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0].text, /not in Zernio's API/)

  const wrongMethod = await request('tools/call', {
    name: 'call_endpoint',
    arguments: { method: 'PATCH', path: '/v1/posts' }
  })
  assert.equal(wrongMethod.isError, true)
  assert.match(wrongMethod.content[0].text, /not allowed on \/v1\/posts/)

  console.log('SMOKE OK — 13 tools listed; core flows plus full-API discovery and validated invocation verified against the mock.')
} finally {
  child.kill()
  mock.close()
}
