/**
 * Regenerates openapi-paths.json (the endpoint index used by list_endpoints
 * and call_endpoint) from Zernio's public OpenAPI spec.
 *
 *   node scripts/build-paths.mjs
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const spec = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : readFileSync(join(root, 'openapi.yaml'), 'utf8')

const lines = spec.split('\n')
const endpoints = []
let path = null
let method = null
let current = null

const flush = () => {
  if (current) endpoints.push(current)
  current = null
}

for (const line of lines) {
  const pathMatch = line.match(/^  (\/[^\s]*):/)
  if (pathMatch) {
    flush()
    method = null
    path = pathMatch[1]
    continue
  }
  const methodMatch = line.match(/^    (get|post|put|delete|patch):/)
  if (methodMatch) {
    flush()
    method = methodMatch[1].toUpperCase()
    current = { method, path, operationId: null, summary: null, tag: null }
    continue
  }
  if (current && method) {
    const operationId = line.match(/^      operationId: (.+)$/)
    if (operationId) current.operationId = operationId[1].trim()
    const summary = line.match(/^      summary: (.+)$/)
    if (summary) current.summary = summary[1].trim().replace(/^['"]|['"]$/g, '')
    // tags appear both inline ("tags: [Posts]") and as a block list.
    const inlineTag = line.match(/^      tags: \[([^]]+)\]$/)
    if (inlineTag && current.tag === null) current.tag = inlineTag[1].split(',')[0].trim()
    const blockTag = line.match(/^        - ([A-Za-z][\w &-]*)$/)
    if (blockTag && current.tag === null) current.tag = blockTag[1].trim()
    const group = line.match(/^      x-resource-group: "?([\w-]+)"?$/)
    if (group) current.group = group[1].trim()
  }
}
flush()

const clean = endpoints
  .filter((endpoint) => endpoint.path?.startsWith('/'))
  .map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    ...(endpoint.operationId ? { operationId: endpoint.operationId } : {}),
    ...(endpoint.summary ? { summary: endpoint.summary } : {}),
    ...(endpoint.tag ? { tag: endpoint.tag } : {}),
    ...(endpoint.group ? { group: endpoint.group } : {})
  }))

writeFileSync(join(root, 'openapi-paths.json'), `${JSON.stringify(clean, null, 0)}\n`)
console.log(`openapi-paths.json: ${clean.length} endpoints`)
