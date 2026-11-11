/**
 * Host half of the "Delete Conversation" bundle.
 *
 * DSH deliberately ships no conversation-deletion API (session persistence,
 * projection cache, attachments and workspace registry all state that pruning
 * is out-of-band maintenance). This plugin implements the operation once, on
 * the Host, and exposes it over a private authenticated POST route that the
 * Web UI calls. Everything it removes is either DSH-owned local cache, the
 * registry's membership rows, or user files that the conversation explicitly
 * declared as produced (`deliverables/presented`) and the user confirmed.
 *
 * @author weapon111 (https://github.com/weapon111)
 * @copyright Copyright (c) 2026 weapon111. All rights reserved.
 * @license MIT — attribution to weapon111 is mandatory.
 *          https://github.com/weapon111/dsh-delete-conversation
 * @module @local/dsh-delete-conversation
 */

import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { readdir, readFile, rm, stat, lstat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'

/** Stable Cordis plugin name. */
export const name = 'delete-conversation'

/** Services this plugin needs; `connection` is injected lazily. */
export const inject = ['workspaceRegistry', 'sessionPersistence', 'storageDomain']

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? resolve(process.env.DSH_HOME.trim())
  : join(homedir(), '.dsh')

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function dshHomePath(...segments) {
  return join(HOME, ...segments)
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(message, status = 500) {
  return jsonResponse({ ok: false, error: String(message) }, status)
}

function isErrno(error, code) {
  return error !== null && typeof error === 'object' && error.code === code
}

async function pathExists(target) {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

async function describeFile(target) {
  try {
    const info = await stat(target)
    return { path: target, exists: true, size: info.size, isDirectory: info.isDirectory() }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { path: target, exists: false, size: 0, isDirectory: false }
    return { path: target, exists: false, size: 0, isDirectory: false, error: String(error?.message ?? error) }
  }
}

/**
 * Decode a concatenated-zstd-framed session log into JSONL text. Each durable
 * append batch is one independent zstd frame; Node's built-in decompressor
 * handles one frame per call, so split on the frame magic bytes.
 */
function decodeSessionLog(buffer) {
  const starts = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1] &&
        buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      starts.push(index)
    }
  }
  const parts = []
  for (let s = 0; s < starts.length; s += 1) {
    const begin = starts[s]
    const end = s + 1 < starts.length ? starts[s + 1] : buffer.length
    try {
      parts.push(zstdDecompressSync(buffer.subarray(begin, end)).toString('utf8'))
    } catch {
      // A torn trailing frame is expected after a crash; keep what decoded.
    }
  }
  return parts.join('')
}

/** Parse all JSONL event rows from decoded log text. */
function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') events.push(value)
    } catch {
      // Ignore incomplete trailing lines.
    }
  }
  return events
}

/* ------------------------------------------------------------------ *
 * Session log discovery
 * ------------------------------------------------------------------ */

/**
 * Locate every session-owned directory for one session id. DSH encodes the
 * session id into a single safe path segment (`encodeSegment`); most ids
 * literally start with "session-" so the directory looks like
 * "session-<uuid>", but some ids are bare UUIDs. We therefore scan every
 * project directory and match either the literal id or its `~XXXX` escaped
 * form. A log header's `id` field is the final authority when present.
 */
async function findSessionDirs(sessionId) {
  const root = dshHomePath('sessions')
  const results = []
  let projectDirs
  try {
    projectDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return results
  }
  const encoded = encodeSegment(sessionId)
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let children
    try {
      children = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name !== sessionId && child.name !== encoded) continue
      const dir = join(projectDir, child.name)
      let files
      try {
        files = await readdir(dir)
      } catch {
        continue
      }
      // Only accept directories that actually look like a session log store.
      const logs = files.filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
      if (logs.length === 0) continue
      // Header check: when the current log is present, confirm its id.
      const current = logs.find((name) => name === 'session.v4.jsonl.zstd') ?? logs[0]
      let headerMatches = true
      try {
        const buffer = await readFile(join(dir, current))
        const text = decodeSessionLog(buffer)
        const first = text.split('\n').find((line) => line.trim())
        if (first) {
          const header = JSON.parse(first)
          if (typeof header.id === 'string' && header.id !== sessionId) headerMatches = false
        }
      } catch {
        // An unreadable header does not exclude the directory; the name match
        // is still strong evidence. Deletion is a user-confirmed action.
      }
      if (headerMatches) results.push({ dir, logs, projectDir })
    }
  }
  return results
}

/** Reproduce dsh-session-persistence-jsonl's `encodeSegment(id)`. */
function encodeSegment(id) {
  const raw = String(id)
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Read the current session log's events (best effort). */
async function readSessionEvents(sessionId, sessionDirs) {
  const dirs = sessionDirs ?? await findSessionDirs(sessionId)
  const events = []
  for (const entry of dirs) {
    const current = entry.logs.find((name) => name === 'session.v4.jsonl.zstd') ?? entry.logs[0]
    try {
      const buffer = await readFile(join(entry.dir, current))
      events.push(...parseEvents(decodeSessionLog(buffer)))
    } catch {
      // Keep going; a historical generation may still be readable.
    }
  }
  return events
}

/* ------------------------------------------------------------------ *
 * Produced files
 * ------------------------------------------------------------------ */

/**
 * Collect files the conversation produced. `present` records absolute paths
 * in durable `deliverables/presented` events; `workspace/changes` events only
 * carry a turn number (their diffs live in memory), so deliverables are the
 * reliable, user-declared set. Only regular, existing files are returned.
 *
 * Session headers give the conversation's own working directory. A delivered
 * file OUTSIDE that directory is very often a shared asset (a skill, a tool,
 * a library) rather than a file this conversation produced; such paths are
 * reported but marked `outsideWorkspace` and the Client never offers them for
 * deletion by default.
 */
async function collectProducedFiles(sessionId, sessionDirs) {
  const events = await readSessionEvents(sessionId, sessionDirs)
  const cwds = new Set()
  for (const event of events) {
    const cwd = event?.data?.cwd ?? event?.cwd ?? event?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) cwds.add(cwd)
  }
  // The first physical row of a current log is its header and carries `cwd`.
  for (const entry of sessionDirs ?? await findSessionDirs(sessionId)) {
    const current = entry.logs.find((name) => name === 'session.v4.jsonl.zstd') ?? entry.logs[0]
    try {
      const text = decodeSessionLog(await readFile(join(entry.dir, current)))
      const first = text.split('\n').find((line) => line.trim())
      if (first) {
        const header = JSON.parse(first)
        if (typeof header.cwd === 'string' && header.cwd.length > 0) cwds.add(header.cwd)
      }
    } catch { /* best effort */ }
  }
  const insideCwd = (path) => {
    const normalized = resolve(path).toLowerCase()
    for (const cwd of cwds) {
      const root = resolve(cwd).toLowerCase()
      if (normalized === root || normalized.startsWith(root + sep.toLowerCase())) return true
    }
    return false
  }

  const seen = new Set()
  const files = []
  for (const event of events) {
    if (event.type !== 'deliverables/presented') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || !Array.isArray(data.files)) continue
    for (const file of data.files) {
      if (file === null || typeof file !== 'object' || typeof file.path !== 'string') continue
      const path = file.path.trim()
      if (path.length === 0 || !isAbsolute(path) || seen.has(path)) continue
      seen.add(path)
      files.push({
        ...(await describeFile(path)),
        description: typeof file.description === 'string' ? file.description : '',
        outsideWorkspace: cwds.size > 0 && !insideCwd(path) && !isForbiddenProducedPath(path),
      })
    }
  }
  return files
}

/**
 * Never follow a produced path into DSH-owned storage. Protecting the whole
 * home would also forbid a legitimate deliverable a user happens to keep
 * under ~/.dsh, so only the storage subtrees DSH itself owns are blocked.
 */
function isForbiddenProducedPath(path) {
  const normalized = resolve(path).toLowerCase()
  const owned = ['sessions', 'storages', 'attachments', 'cache', 'plugins', 'profiles']
  for (const name of owned) {
    const root = resolve(dshHomePath(name)).toLowerCase()
    if (normalized === root || normalized.startsWith(root + sep.toLowerCase())) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * Other per-session caches
 * ------------------------------------------------------------------ */

function projectionCacheCandidates(sessionId) {
  const dir = dshHomePath('storages', 'session_projcache', 'sessions')
  return [
    join(dir, `${sessionId}.json`),
    join(dir, `${sessionId}.json.bak`),
  ]
}

/** dsh-spill-local: `<root>/session-<sha256(id)[:12]>/…` under OS tmpdir. */
function spillHash(sessionId) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
}

async function findSpillDirs(sessionId) {
  const dirs = []
  const hash = spillHash(sessionId)
  const wanted = `session-${hash}`
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('dsh-spill-')) continue
      const root = join(tmpdir(), entry.name)
      const candidate = join(root, wanted)
      if (await pathExists(candidate)) dirs.push(candidate)
    }
  } catch {
    // No temp root is fine.
  }
  return dirs
}

/* ------------------------------------------------------------------ *
 * The operation
 * ------------------------------------------------------------------ */

/**
 * Build a read-only plan of everything a delete would remove. The Client
 * shows this to the user before it sends the destructive `delete` op.
 */
async function planDeletion(ctx, sessionId) {
  const sessionDirs = await findSessionDirs(sessionId)
  const logs = []
  for (const entry of sessionDirs) {
    for (const name of entry.logs) {
      const target = join(entry.dir, name)
      logs.push({ ...(await describeFile(target)), label: name })
    }
    // Also account for lock files and any other artifacts in the directory.
    try {
      for (const name of await readdir(entry.dir)) {
        if (entry.logs.includes(name)) continue
        const target = join(entry.dir, name)
        logs.push({ ...(await describeFile(target)), label: name })
      }
    } catch {
      // Directory listing is best-effort for the preview.
    }
  }
  const projectionCache = []
  for (const target of projectionCacheCandidates(sessionId)) {
    if (await pathExists(target)) projectionCache.push(await describeFile(target))
  }
  const spill = []
  for (const dir of await findSpillDirs(sessionId)) {
    spill.push({ path: dir, exists: true, isDirectory: true, size: 0, label: basename(dir) })
  }
  const producedFiles = await collectProducedFiles(sessionId, sessionDirs)
  const workspaces = ctx.workspaceRegistry.list()
    .filter((workspace) => workspace.sessionIds.includes(sessionId))
    .map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
  return { sessionId, logs, projectionCache, spill, producedFiles, workspaces }
}

/**
 * Permanently delete one conversation.
 *
 * Order matters: stop the running work first (the shipped archive-with-stop
 * seam), then read and delete produced files while the log still exists, then
 * drop registry membership, then remove every local cache artifact.
 *
 * `confirmedPaths` is the exact, user-approved list of produced files. An
 * empty list means "keep all produced files". Any path not in the plan is
 * rejected so a stale or forged request cannot delete arbitrary files.
 */
async function deleteConversation(ctx, sessionId, confirmedPaths) {
  const plan = await planDeletion(ctx, sessionId)
  // Only files INSIDE the conversation's own working directory are offered
  // for deletion by default. A delivered path outside it is usually a shared
  // asset (a skill, a tool, a library) and must be confirmed explicitly.
  const allowed = new Set(plan.producedFiles
    .filter((file) => file.exists && !file.isDirectory && !file.outsideWorkspace)
    .map((file) => file.path))
  const requested = Array.isArray(confirmedPaths) ? confirmedPaths : []
  for (const path of requested) {
    if (typeof path !== 'string' || !allowed.has(path) || isForbiddenProducedPath(path)) {
      throw new Error(`Refusing to delete an unconfirmed produced file: ${String(path)}`)
    }
  }

  const removed = { producedFiles: [], logs: [], projectionCache: [], spill: [], registry: [] }
  const errors = []

  // 1. Stop running work and drop the durable archive/pin state. Archiving
  // with stopActivity uses DSH's own "stop the session's work" seam; the
  // following unarchive/pin removal leaves no state behind.
  try {
    await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
    removed.registry.push('archived/stopped')
  } catch (error) {
    // A session with no live work may still be archivable; a missing session
    // is fine because we are deleting it. Record and continue.
    errors.push({ stage: 'stop', message: String(error?.message ?? error) })
  }
  for (const [action, label] of [
    ['unarchiveSession', 'unarchived'],
    ['unpinSession', 'unpinned'],
  ]) {
    try {
      await ctx.workspaceRegistry[action](sessionId)
      removed.registry.push(label)
    } catch (error) {
      errors.push({ stage: label, message: String(error?.message ?? error) })
    }
  }

  // 2. Delete the user-confirmed produced files BEFORE the log disappears.
  for (const path of new Set(requested)) {
    try {
      await rm(path, { force: true })
      removed.producedFiles.push(path)
    } catch (error) {
      errors.push({ stage: 'produced-file', path, message: String(error?.message ?? error) })
    }
  }

  // 3. Drop the session from every workspace and from the projection cache
  // domain row. Both are idempotent and publish the normal change feed.
  for (const workspace of ctx.workspaceRegistry.list()) {
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      errors.push({ stage: 'detach', path: workspace.path, message: String(error?.message ?? error) })
    }
  }
  const projcache = ctx.storageDomain.get('session_projcache')
  if (projcache !== undefined) {
    try {
      await projcache.table('sessions').delete(sessionId)
      removed.projectionCache.push('domain-row')
    } catch (error) {
      errors.push({ stage: 'projection-domain', message: String(error?.message ?? error) })
    }
  }

  // 4. Remove all physical session log directories, the projection cache
  // files, and the spill directories.
  for (const entry of await findSessionDirs(sessionId)) {
    try {
      await rm(entry.dir, { recursive: true, force: true })
      removed.logs.push(entry.dir)
    } catch (error) {
      errors.push({ stage: 'session-log', path: entry.dir, message: String(error?.message ?? error) })
    }
  }
  for (const target of projectionCacheCandidates(sessionId)) {
    if (!(await pathExists(target))) continue
    try {
      await rm(target, { force: true })
      removed.projectionCache.push(target)
    } catch (error) {
      errors.push({ stage: 'projection-cache', path: target, message: String(error?.message ?? error) })
    }
  }
  for (const dir of await findSpillDirs(sessionId)) {
    try {
      await rm(dir, { recursive: true, force: true })
      removed.spill.push(dir)
    } catch (error) {
      errors.push({ stage: 'spill', path: dir, message: String(error?.message ?? error) })
    }
  }

  return { sessionId, removed, errors }
}

/* ------------------------------------------------------------------ *
 * Host route + plugin entry
 * ------------------------------------------------------------------ */

function registerRoutes(ctx, service) {
  ctx.inject(['connection'], (injected) => {
    const connection = injected.connection
    injected.effect(
      () => connection.fetch.register({
        path: '/api/dsh-delete-conversation/rpc',
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let body
          try {
            body = await request.json()
          } catch {
            return fail('body is not JSON', 400)
          }
          const op = typeof body?.op === 'string' ? body.op : ''
          const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
          if (!ID_PATTERN.test(sessionId)) return fail('invalid sessionId', 400)
          try {
            if (op === 'inspect') {
              return jsonResponse({ ok: true, value: await service.inspect(sessionId) })
            }
            if (op === 'delete') {
              return jsonResponse({ ok: true, value: await service.delete(sessionId, body.confirmedPaths) })
            }
            return fail(`unknown operation "${op}"`, 400)
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error))
          }
        },
      }),
      'dsh-delete-conversation: rpc route',
    )
  })
}

export function apply(ctx) {
  const service = {
    inspect: (sessionId) => planDeletion(ctx, sessionId),
    delete: (sessionId, confirmedPaths) => deleteConversation(ctx, sessionId, confirmedPaths),
  }
  registerRoutes(ctx, service)
}
