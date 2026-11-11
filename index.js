/**
 * Host half of the UI 增强 bundle.
 *
 * Owns two things, both reachable from the page only over loopback:
 *
 *  - the relay's self-quota read with the stored API key (the key never reaches the browser);
 *  - the per-Session context budget mirror and the turn-time compaction it drives.
 *
 * The Client half keeps one browser-local budget per Session (200K/400K/800K/1M) and posts
 * the whole map here on load and on every change. At each `agent/pre-step` (before every
 * model request of a turn) this plugin compares the Session's measured context with 90% of
 * that Session's budget and asks the preset-scoped compaction service for one forced
 * reduction. `/compact` itself refuses to run while the agent is busy, so this listener is
 * what makes the budget work in the middle of a task; the harness's own automatic path only
 * fires near the model window's pressure threshold, which a 1M-token model rarely reaches.
 */

import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fetchShaderToyWork } from './shadertoy.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import { tmpdir } from 'node:os'

const QUOTA_PATH = '/plugin/ui-enhance/quota'
const PROBE_PATH = '/plugin/ui-enhance/probe'
const PROBE_LIMIT = 300
/** Browser-local per-Session budgets mirrored by the Client half. */
const BUDGETS_PATH = '/plugin/ui-enhance/budgets'
/** The model's real capacity lives in the profile patch; a tier change has to move it there. */
const CONTEXT_WINDOW_PATH = '/plugin/ui-enhance/context-window'
const CONTEXT_WINDOW_MIN = 8000
const CONTEXT_WINDOW_MAX = 8000000
/** Force-stop one Session's in-flight work (turn or compaction) on the Client's request. */
const ABORT_PATH = '/plugin/ui-enhance/abort'
/** Forced compaction on the Client's request; the shipped command refuses while busy. */
const COMPACT_PATH = '/plugin/ui-enhance/compact'
/** Open compaction markers per Session, so the Client can offer "stop compaction". */
const COMPACTIONS_PATH = '/plugin/ui-enhance/compactions'
/** Compile check of the Client bundles the next document boot would load. */
const PREFLIGHT_PATH = '/plugin/ui-enhance/preflight'
/** Interrupted-Session report and manual trigger for the startup auto-continue. */
const AUTO_RESUME_PATH = '/plugin/ui-enhance/auto-resume'
/** Events fetched per durable-log page while scanning for an unclosed turn. */
const READ_PAGE_SIZE = 2000
/** Safety cap on pages per Session, so one huge log cannot stall the scan. */
const READ_PAGE_GUARD = 200
/** Left-browser token aggregation (#7) and the current-Workspace-only scope (#5). */
const SUMMARY_PATH = '/plugin/ui-enhance/session-summary'
/**
 * One-click model + reasoning-effort switch for every Session in the current Workspace.
 * The Session controller only exposes a per-Session `selectModel`, so the fan-out lives
 * here: the Client posts once and the Host walks the Session list it already owns.
 */
const MODEL_BULK_PATH = '/plugin/ui-enhance/model-bulk'
/** Settled switches are reported back in bulk; more rows than this only trim the detail list. */
const MODEL_BULK_REPORT_LIMIT = 200
/** The workspace directory's checked-out git branch, for the file tree's title bar. */
const GIT_PATH = '/plugin/ui-enhance/git'
/**
 * Server-side ShaderToy fetch: drives the installed browser through Cloudflare and
 * returns a work's full definition plus its channel textures.
 */
const SHADERTOY_PATH = '/plugin/ui-enhance/shadertoy'
/** Several file tabs can ask for the same root at once; one read of `.git/HEAD` answers them all. */
const GIT_CACHE_MS = 3000
const GIT_CACHE_LIMIT = 64
/** Directory levels walked up while looking for `.git`; the filesystem root stops it earlier. */
const GIT_MAX_DEPTH = 64
/**
 * What a Host start does with a Session whose last turn never ended. `detect` only
 * reports, `continue` also sends the continuation prompt (the shipped default: an
 * interrupted turn is otherwise silently lost); `off` disables the scan entirely
 * (patch-layer config `autoResume: false`).
 */
const AUTO_RESUME_DEFAULT_MODE = 'continue'
/** Let the Host finish starting and restore its services before reading Session logs. */
const DEFAULT_AUTO_RESUME_DELAY_MS = 8000
/** A Session whose newest durable event is older than this is not resumed. */
const DEFAULT_AUTO_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000
/** Upper bound on Sessions examined per scan, most recently active first. */
const DEFAULT_AUTO_RESUME_MAX = 64
/** Hard ceiling on the examined-Session count, whatever the patch layer asks for. */
const AUTO_RESUME_MAX_LIMIT = 512
/** Gap between two continuation prompts, so the provider is not hit all at once. */
const DEFAULT_AUTO_RESUME_STAGGER_MS = 4000
/** Rows kept in the status report (the scan itself is bounded by `maxSessions`). */
const AUTO_RESUME_REPORT_LIMIT = 40
/**
 * The user-visible message a resumed Session receives. It becomes the prompt of a
 * fresh turn, appended after the synthetic closers that repair the crashed tail.
 */
const AUTO_RESUME_PROMPT =
  '（自动续跑）上一轮任务因进程异常退出而中断。请先核对当前状态和已有产物，然后从中断处继续完成剩余工作；已经完成的部分不要重做。如果任务其实已经完成或无法继续，请简要说明现状即可。'
/** A turn-time compaction must not outlive this; a hung summary would stall the turn. */
const AUTO_COMPACT_TIMEOUT_MS = 600000
/** How far back a Session log is scanned for an open compaction marker (it is the newest event). */
const COMPACTION_SCAN_LIMIT = 512
/** Compact on the first model request after this share of a Session's budget is used. */
const AUTO_COMPACT_PERCENT = 90
/** One attempt per Session per minute, so a reduction that cannot shrink cannot loop. */
const AUTO_COMPACT_COOLDOWN_MS = 60000

const DEFAULT_QUOTA_URL = 'http://172.16.14.200:3460/v1/quota'
const DEFAULT_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'
const BUCKETS = ['claude', 'thirdparty', 'codex']

export const inject = ['webServer', 'credentials']

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function reply(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read one git directory's checked-out branch: a symbolic HEAD names the branch, a raw commit
 * id means a detached HEAD. Reading the file (instead of spawning `git`) keeps this free of a
 * PATH lookup and of a process per poll; a missing or odd HEAD simply reports no branch.
 * @param gitDir - the repository's git directory (`.git`, or the `gitdir:` target of a
 * worktree/submodule link).
 */
async function readGitHead(gitDir) {
  let head
  try {
    head = (await fs.readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
  } catch (error) {
    return { branch: null, detached: false }
  }
  const symbolic = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (symbolic !== null) return { branch: symbolic[1], detached: false }
  if (/^[0-9a-f]{7,40}$/i.test(head)) return { branch: head.slice(0, 7), detached: true }
  return { branch: null, detached: false }
}

/**
 * Answer "is this directory inside a git repository, and which branch is checked out", walking
 * up from the directory so a workspace that is a subdirectory of a repository still answers.
 * @param directory - absolute path the file tree is rooted at.
 */
async function readGitBranch(directory) {
  let current = directory
  for (let depth = 0; depth < GIT_MAX_DEPTH; depth += 1) {
    const dotGit = join(current, '.git')
    let stat
    try {
      stat = await fs.stat(dotGit)
    } catch (error) {
      stat = undefined
    }
    if (stat !== undefined) {
      let gitDir = dotGit
      if (!stat.isDirectory()) {
        // Linked checkout: `.git` is a file holding `gitdir: <path>`.
        let body
        try {
          body = await fs.readFile(dotGit, 'utf8')
        } catch (error) {
          return { repo: false }
        }
        const match = /^gitdir:\s*(.+?)\s*$/m.exec(body)
        if (match === null) return { repo: false }
        gitDir = resolve(current, match[1])
      }
      const head = await readGitHead(gitDir)
      return { repo: true, root: current, branch: head.branch, detached: head.detached }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return { repo: false }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function pickBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null
  return {
    dailyQuota: numberOrNull(bucket.daily_quota),
    dailyUsed: numberOrNull(bucket.daily_used),
    dailyRemaining: numberOrNull(bucket.daily_remaining),
    overDaily: bucket.over_daily === true,
    weeklyQuota: numberOrNull(bucket.weekly_quota),
    weeklyUsed: numberOrNull(bucket.weekly_used),
    weeklyRemaining: numberOrNull(bucket.weekly_remaining),
    overWeekly: bucket.over_weekly === true,
  }
}

function summarize(payload) {
  const buckets = {}
  for (const name of BUCKETS) buckets[name] = pickBucket(payload[name])
  return {
    buckets,
    modelWeights: payload.model_weights && typeof payload.model_weights === 'object' ? payload.model_weights : null,
  }
}

/** Agent ids appear both bare and `session-` prefixed; compare and key by the bare uuid. */
function sessionKey(id) {
  if (typeof id !== 'string') return undefined
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** Every id form the agent registry or a session log may use for one Session. */
function sessionCandidates(id) {
  const key = sessionKey(id)
  if (key === undefined || key.length === 0) return []
  return key === id ? [id, 'session-' + id] : [id, key]
}

/**
 * Compile one served Client script as a classic script without executing it.
 *
 * The Web boot audit treats a Client entry that fails to load as fatal: the shell
 * reports it to the desktop process, which shows the startup-failure dialog and
 * leaves the app unusable until a restart. A bundle that cannot even compile is
 * exactly that state, so a reload must not be attempted while one exists.
 * @param text - the script bytes served for the resource.
 * @returns the syntax error message, or undefined when the script compiles.
 */
function compileFailure(text) {
  try {
    // eslint-disable-next-line no-new-func -- compiling is the whole point; nothing runs.
    new Function(text)
    return undefined
  } catch (error) {
    return String((error && error.message) || error)
  }
}

/**
 * One abstract vocabulary for "why did this turn stop", so the resume scanner never
 * has to grow a branch per new provider message.
 *
 * The Host writes a structured `turn/end` reason (`{ kind, error: { code, message } }`),
 * and the interesting part is the error *code* — the placeholder text after it changes
 * with every release ("DeepSeek Messages stream: tool input is invalid JSON",
 * "… SSE contains invalid JSON", "… extended thinking blocks are not supported" all
 * arrive as `MALFORMED_RESPONSE`). Classification therefore reads the code first, the
 * message only as a hint, and anything unrecognised lands in `unknown` — which the
 * scan still reports and still resumes, so a brand-new failure mode needs no code
 * change here.
 */
const TURN_STATUS_COMPLETED = 'completed'
const TURN_STATUS_RESUMABLE = 'resumable'
const TURN_STATUS_FINISHED = 'finished'

/** Codes that mean "the run broke, the work is unfinished": always worth continuing. */
const RESUMABLE_CODES = new Set([
  'MALFORMED_RESPONSE',
  'STREAM_CLOSED',
  'MESSAGES_IDLE',
  'UPSTREAM_FAILED',
  'EAC_UPSTREAM_FAILED',
  'RATE_LIMIT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'TIMEOUT',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'INTERNAL',
  'SERVER',
  'SERVICE_UNAVAILABLE',
  'OVERLOADED',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
  'CHAIN_EXHAUSTED',
  'TOOL_ERROR',
  'CONTEXT_OVERFLOW',
])
/** Codes an automatic retry only makes worse: a fixed config or credential, not a flake. */
const BLOCKING_CODES = new Set([
  'AUTHORIZATION_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'FORBIDDEN',
  'INVALID_API_KEY',
  'INSUFFICIENT_CREDITS',
  'CANCELLED',
  'ABORTED',
  'USER_CANCELLED',
  'POLICY_REFUSAL',
])
/**
 * Message shapes, only as a fallback for a reason that carries no code. Kept short on
 * purpose: this is a hint, not the contract — unknown text is resumable anyway.
 */
const BLOCKING_MESSAGE_HINTS = [
  /\bstream (?:was )?cancell?ed\b/i,
  /\bwas refused\b/i,
  /\brefus(?:ed|al)\b/i,
  /\binsufficient (?:credits|balance)\b/i,
  /余额不足/,
]
const RESUMABLE_MESSAGE_HINTS = [
  /\binvalid json\b/i,
  /\bmalformed\b/i,
  /\bstream (?:ended|closed)\b/i,
  /\btimed? ?out\b/i,
  /请求失败/,
  /网络/,
]

/**
 * Turn end kinds the Host itself uses. `completed` finished; `forked` is a branch
 * point rather than a run. Everything else that appears in `kind` is treated as a
 * stop whose cause comes from the error payload (see above).
 */
function classifyTurnEnd(reason) {
  const raw = reason && typeof reason === 'object' ? reason : {}
  const kind = typeof raw.kind === 'string' ? raw.kind : 'completed'
  const message = turnEndMessageOf(raw)
  const code = errorCodeOf(raw)

  if (kind === 'completed') return { status: TURN_STATUS_COMPLETED, kind, code, message }
  if (kind === 'forked') return { status: TURN_STATUS_FINISHED, kind, code, message }

  /*
   * A user cancel is a decision, not a fault: the prompt would restart work the user
   * just stopped. `aborted` covers it; the legacy `user`/`cancelled` names are kept
   * for logs written by older Hosts.
   */
  if (kind === 'aborted' || kind === 'user' || kind === 'cancelled') {
    return { status: TURN_STATUS_FINISHED, kind, code, message, why: 'user-cancel' }
  }
  const nested = raw.reason && typeof raw.reason === 'object' ? raw.reason : undefined
  if (nested && (nested.kind === 'user' || nested.kind === 'cancelled')) {
    return { status: TURN_STATUS_FINISHED, kind, code, message, why: 'user-cancel' }
  }

  if (code !== undefined) {
    if (BLOCKING_CODES.has(code)) return { status: TURN_STATUS_FINISHED, kind, code, message, why: 'blocking' }
    return { status: TURN_STATUS_RESUMABLE, kind, code, message }
  }
  for (const pattern of BLOCKING_MESSAGE_HINTS) {
    if (message !== undefined && pattern.test(message)) {
      return { status: TURN_STATUS_FINISHED, kind, code, message, why: 'blocking' }
    }
  }
  /*
   * No code and no blocking shape: the turn stopped for a reason this build does not
   * know. Continuing is the safe default — the continuation prompt starts a *new*
   * turn and asks the model to check the current state first, so a wrong guess costs
   * one short turn, while the alternative silently strands a broken run forever.
   */
  return { status: TURN_STATUS_RESUMABLE, kind, code, message, why: knowsResumableMessage(message) ? 'message' : 'unknown' }
}

/** Whether any known resumable shape matched, used only to label the report. */
function knowsResumableMessage(message) {
  if (message === undefined) return false
  for (const pattern of RESUMABLE_MESSAGE_HINTS) if (pattern.test(message)) return true
  return false
}

/**
 * The durable signature of a turn the owning process never closed: the newest
 * turn boundary in the log is a `turn/start`. `turn/end` is appended from a
 * `finally`, so a hard death leaves it missing while a user cancel still writes
 * one — which makes an open turn the log's own record of an abnormal stop.
 * @param events - the complete committed event log of one Session.
 * @returns the open turn, or undefined when the log's newest turn closed.
 */
function openTurnOf(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    const type = event && event.type
    if (type === 'turn/end') {
      /*
       * A closed turn is not automatically a finished one. `classifyTurnEnd` decides
       * whether the stop left work behind — a transport failure, a provider error, a
       * malformed stream, a token ceiling all close the turn while leaving the task
       * undone; a completed turn and a user cancel are finished and need no resume.
       */
      const reason = event.data && event.data.reason
      const verdict = classifyTurnEnd(reason)
      if (verdict.status !== TURN_STATUS_RESUMABLE) return undefined
      return {
        turn: null,
        seq: typeof event.seq === 'number' ? event.seq : null,
        at: typeof event.time === 'number' ? event.time : undefined,
        closed: true,
        reason: verdict.kind,
        code: verdict.code,
        message: verdict.message,
        cause: verdict.why,
      }
    }
    if (type === 'turn/start') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      return {
        turn: typeof data.turn === 'number' ? data.turn : null,
        seq: typeof event.seq === 'number' ? event.seq : null,
        at: typeof event.time === 'number' ? event.time : undefined,
        closed: false,
        reason: 'interrupted',
        message: undefined,
      }
    }
  }
  return undefined
}

/**
 * The machine-readable code a Host error carries, whatever shape the release used:
 * `error.code`, a bare string code, or a nested `cause`/`error` chain.
 */
function errorCodeOf(reason) {
  const seen = new Set()
  let node = reason && typeof reason === 'object' ? reason.error : undefined
  for (let depth = 0; depth < 4 && node !== undefined && node !== null; depth += 1) {
    if (typeof node === 'string') return depth === 0 ? node : undefined
    if (typeof node !== 'object' || seen.has(node)) break
    seen.add(node)
    const code = typeof node.code === 'string' && node.code.length > 0 ? node.code : undefined
    if (code !== undefined) return code
    node = node.cause !== undefined ? node.cause : node.error
  }
  const direct = reason && typeof reason === 'object' ? reason.code : undefined
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

/** Best-effort human summary of a failed turn end, for the status report only. */
function turnEndMessageOf(reason) {
  if (!reason || typeof reason !== 'object') return undefined
  if (typeof reason.reason === 'string') return reason.reason
  const error = reason.error
  if (typeof error === 'object' && error !== null && typeof error.message === 'string') return error.message
  if (typeof error === 'string') return error
  if (typeof reason.message === 'string') return reason.message
  return undefined
}

/** Positive number or the supplied fallback, for optional configuration values. */
function positiveOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/** One event-loop turn of relief, so a long Session scan cannot starve the Host. */
function settle() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

/**
 * The `requestId` a Session prompt needs. It only identifies the request in the
 * Session log, so any unique string works; crypto is preferred when available.
 */
function nextRequestId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch (error) {
    /* fall through to the timestamp form */
  }
  return 'ui-enhance-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

export function apply(ctx, config = {}) {
  const quotaUrl = typeof config.quotaUrl === 'string' && config.quotaUrl ? config.quotaUrl : DEFAULT_QUOTA_URL
  const credentialRef =
    typeof config.credentialRef === 'string' && config.credentialRef ? config.credentialRef : DEFAULT_CREDENTIAL_REF
  const timeoutMs = typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : 8000
  /** Turn-time compaction deadline; overridable so a test can prove the watchdog fires. */
  const compactTimeoutMs =
    typeof config.compactTimeoutMs === 'number' && config.compactTimeoutMs > 0
      ? config.compactTimeoutMs
      : AUTO_COMPACT_TIMEOUT_MS

  async function readQuota() {
    const credential = await ctx.credentials.resolve(credentialRef)
    const key = credential && credential.value
    if (!key) return { ok: false, error: 'credential-missing' }

    let response
    try {
      response = await fetch(quotaUrl, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return { ok: false, error: 'unreachable' }
    }
    if (!response.ok) return { ok: false, error: `http-${response.status}` }

    let payload
    try {
      payload = await response.json()
    } catch (error) {
      return { ok: false, error: 'bad-json' }
    }
    return { ok: true, fetchedAt: Date.now(), data: summarize(payload) }
  }

  /** Temporary diagnostics ring: the probe route replays it; removed once verified. */
  const probeLog = []
  function probe(event, data) {
    probeLog.push({ event, data, at: Date.now() })
    if (probeLog.length > PROBE_LIMIT) probeLog.splice(0, probeLog.length - PROBE_LIMIT)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: QUOTA_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          try {
            reply(res, 200, await readQuota())
          } catch (error) {
            reply(res, 502, { ok: false, error: 'internal' })
          }
        },
      }),
    'ui-enhance: quota route',
  )

  /** The desktop host receives its profile directory as a bare argv entry. */
  function resolveProfileDir() {
    for (const arg of process.argv.slice(1)) {
      if (typeof arg !== 'string' || arg.length === 0) continue
      if (!/[\\/]profiles[\\/][^\\/]+$/.test(arg)) continue
      if (existsSync(join(arg, 'cordis.patch.yml'))) return arg
    }
    return undefined
  }

  /**
   * Point one model entry of the profile's patch layer at a new context window. dsh-hmr watches
   * that file, so the next model request already carries the new capacity. Line-based on
   * purpose: the file is the user's hand-written patch and must keep its comments and ordering.
   */
  async function writeContextWindow(dir, model, size) {
    const file = join(dir, 'cordis.patch.yml')
    const text = await fs.readFile(file, 'utf8')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    const ids = []
    let modelsIndent = -1
    let target = -1
    let indent = -1
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const header = /^(\s*)models:\s*$/.exec(line)
      if (header !== null) {
        modelsIndent = header[1].length
        continue
      }
      if (modelsIndent < 0) continue
      const entry = /^(\s*)-\s+id:\s*(\S+)\s*$/.exec(line)
      if (entry === null) {
        if (/^\s*\S/.test(line) && line.search(/\S/) <= modelsIndent) modelsIndent = -1
        continue
      }
      if (entry[1].length <= modelsIndent) {
        modelsIndent = -1
        continue
      }
      ids.push(entry[2])
      if (target < 0 && (model === undefined || entry[2] === model)) {
        target = index
        indent = entry[1].length
      }
    }
    if (target < 0) throw new Error('model-not-found: ' + ids.join(','))
    const wanted = ' '.repeat(indent + 2) + 'contextWindow: ' + size
    let existing = -1
    for (let index = target + 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim().length === 0) continue
      const own = line.search(/\S/)
      if (own <= indent) break
      if (own === indent + 2 && /^\s*contextWindow\s*:/.test(line)) {
        existing = index
        break
      }
    }
    if (existing >= 0) lines[existing] = wanted
    else lines.splice(target + 1, 0, wanted)
    const backup = file + '.bak-ctxwin'
    if (!existsSync(backup)) await fs.writeFile(backup, text, 'utf8')
    const scratch = file + '.tmp-' + String(process.pid)
    await fs.writeFile(scratch, lines.join(eol), 'utf8')
    await fs.rename(scratch, file)
    return { path: file, model: ids[Math.max(0, ids.indexOf(model))], contextWindow: size }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: CONTEXT_WINDOW_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let raw = ''
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 4096) {
              reply(res, 413, { ok: false, error: 'too-large' })
              return
            }
          }
          let payload
          try {
            payload = JSON.parse(raw)
          } catch (error) {
            reply(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          const size = payload && payload.contextWindow
          if (
            typeof size !== 'number' ||
            !Number.isFinite(size) ||
            size < CONTEXT_WINDOW_MIN ||
            size > CONTEXT_WINDOW_MAX
          ) {
            reply(res, 400, { ok: false, error: 'bad-payload' })
            return
          }
          const dir = resolveProfileDir()
          if (dir === undefined) {
            reply(res, 200, { ok: false, error: 'no-profile-dir' })
            return
          }
          const model = payload && typeof payload.model === 'string' && payload.model.length > 0 ? payload.model : undefined
          try {
            const result = await writeContextWindow(dir, model, Math.round(size))
            probe('context-window', result)
            reply(res, 200, Object.assign({ ok: true }, result))
          } catch (error) {
            reply(res, 200, { ok: false, error: String(error && error.message ? error.message : error) })
          }
        },
      }),
    'ui-enhance: context window route',
  )

  /**
   * Mirror of the browser-local budget map. The Client half posts the complete map, so the
   * previous mirror is replaced; only plain positive token counts survive validation.
   */
  const budgets = new Map()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: BUDGETS_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let raw = ''
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 262144) {
              reply(res, 413, { ok: false, error: 'too-large' })
              return
            }
          }
          let payload
          try {
            payload = JSON.parse(raw)
          } catch (error) {
            reply(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          const incoming = payload && payload.budgets
          if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
            reply(res, 400, { ok: false, error: 'bad-payload' })
            return
          }
          const next = new Map()
          for (const [sessionId, value] of Object.entries(incoming)) {
            if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) continue
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
            next.set(sessionId, value)
          }
          budgets.clear()
          for (const [sessionId, value] of next) budgets.set(sessionId, value)
          probe('budget-sync', { count: budgets.size })
          reply(res, 200, { ok: true, count: budgets.size })
        },
      }),
    'ui-enhance: budget mirror route',
  )

  /**
   * Open compaction markers. The compaction seam appends `compaction/start` and a matching
   * `compaction/end` (carrying an `error` when it fails), so a Session with a start and no
   * end is one whose compaction is still running — or hung, which is exactly what the
   * Client's stop action exists for.
   */
  const openCompactions = new Map()
  /** Sessions whose Client has polled once, so the one-shot diagnostic stays one per Session. */
  const compactionPollSeen = new Set()
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        try {
          const key = sessionKey(session && session.id)
          if (key === undefined || !event || typeof event.type !== 'string') return
          if (event.type === 'compaction/start') {
            openCompactions.set(key, { at: Date.now(), compactionId: event.data && event.data.compactionId })
          } else if (event.type === 'compaction/end') {
            openCompactions.delete(key)
          }
        } catch (error) {
          /* a tracker must never disturb the session event stream */
        }
      }),
    'ui-enhance: compaction tracker',
  )

  /**
   * The durable signature of a compaction in flight: a Session that appended
   * `compaction/start` and has not appended `compaction/end` after it. The live event
   * tracker above sees only compactions that start while this plugin is mounted, so the
   * Session's own log is also inspected — that is what lets a page reload, or a plugin
   * reload, still discover a compaction that is already stuck.
   * @param agent - the live agent whose Session log is inspected.
   * @returns the open marker, or undefined when the latest compaction closed.
   */
  function inspectOpenCompaction(agent) {
    const session = agent && agent.session
    if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number') return undefined
    const floor = Math.max(0, session.seq - COMPACTION_SCAN_LIMIT)
    for (let seq = session.seq - 1; seq >= floor; seq -= 1) {
      const event = session.eventAt(seq)
      if (!event) return undefined
      if (event.type === 'compaction/end') return undefined
      if (event.type === 'compaction/start') {
        const data = event.data || {}
        return {
          at: typeof event.time === 'number' ? event.time : Date.now(),
          compactionId: data.compactionId,
          seq: event.seq,
          sourceCommandId: data.sourceCommandId,
        }
      }
    }
    return undefined
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: COMPACTIONS_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const open = {}
          for (const [key, entry] of openCompactions) open[key] = entry
          let perSession = {}
          let requested
          try {
            requested = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('sessionId') || undefined
          } catch (error) {
            requested = undefined
          }
          if (requested !== undefined) {
            const key = sessionKey(requested)
            const agents = ctx.get('agents')
            let agent
            if (agents && typeof agents.get === 'function') {
              for (const candidate of sessionCandidates(requested)) {
                try {
                  agent = agents.get(candidate)
                } catch (error) {
                  agent = undefined
                }
                if (agent) break
              }
            }
            // A log-backed marker wins: it is durable, while the live map is only from mount.
            const entry = inspectOpenCompaction(agent) || (key === undefined ? undefined : open[key])
            if (key !== undefined) perSession[key] = entry === undefined ? null : entry
            if (key !== undefined && !compactionPollSeen.has(key)) {
              compactionPollSeen.add(key)
              probe('compactions-poll', { sessionId: requested, live: agent !== undefined, open: entry !== undefined })
            }
          }
          reply(res, 200, { ok: true, open, session: perSession })
        },
      }),
    'ui-enhance: compaction state route',
  )

  /**
   * Force-stop one Session. `agent.cancel` aborts the phase signal, which covers both a live
   * turn and the maintenance phase a manual `/compact` runs under. That is the only lever
   * available for a hung compaction: the command's own UI request stays open, and the
   * shipped Stop button is not offered while the agent reports idle during maintenance.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ABORT_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let raw = ''
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 4096) {
              reply(res, 413, { ok: false, error: 'too-large' })
              return
            }
          }
          let payload
          try {
            payload = JSON.parse(raw)
          } catch (error) {
            reply(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          const requested = payload && typeof payload.sessionId === 'string' ? payload.sessionId : undefined
          if (!requested || requested.length > 128) {
            reply(res, 400, { ok: false, error: 'bad-payload' })
            return
          }
          const agents = ctx.get('agents')
          let agent
          if (agents && typeof agents.get === 'function') {
            for (const candidate of sessionCandidates(requested)) {
              try {
                agent = agents.get(candidate)
              } catch (error) {
                agent = undefined
              }
              if (agent) break
            }
          }
          if (!agent) {
            probe('abort', { requested, live: false })
            reply(res, 404, { ok: false, error: 'agent-not-live' })
            return
          }
          try {
            agent.cancel({ kind: 'user' }, { keepInbox: true })
            probe('abort', { requested, live: true })
            reply(res, 200, { ok: true })
          } catch (error) {
            probe('abort-failed', { requested, message: String((error && error.message) || error) })
            reply(res, 500, { ok: false, error: 'cancel-failed' })
          }
        },
      }),
    'ui-enhance: abort route',
  )

  /**
   * Read one request body as JSON with a byte cap; undefined when it is unusable.
   * @param req - the Host request.
   * @param limit - maximum accepted character count.
   */
  async function readJsonBody(req, limit) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > limit) return undefined
    }
    try {
      return JSON.parse(raw)
    } catch (error) {
      return undefined
    }
  }

  /** Parse the ordered entry ids of a combo request (`/plugins/??a/client.js,b/client.js&rev=r`). */
  function comboIds(search) {
    if (typeof search !== 'string' || search.slice(0, 2) !== '??') return undefined
    const head = search.slice(2).split('&')[0]
    if (head.length === 0) return undefined
    const ids = []
    for (const part of head.split(',')) {
      const trimmed = part.trim()
      if (!trimmed.endsWith('/client.js')) return undefined
      ids.push(trimmed.slice(0, -'/client.js'.length))
    }
    return ids.length === 0 ? undefined : ids
  }

  /** The bundle URL the current graph advertises for one entry id. */
  function currentEntryUrl(graph, id) {
    const entries = graph && Array.isArray(graph.entries) ? graph.entries : []
    for (const entry of entries) {
      if (entry && entry.id === id && typeof entry.url === 'string') return entry.url
    }
    return undefined
  }

  /**
   * The current bundle URL whose entry list is exactly `ids`, when the requested URL
   * names a composed batch (the boot preloads those and the loader reuses them).
   */
  function currentBatchUrl(graph, ids) {
    const batches = graph && Array.isArray(graph.batches) ? graph.batches : []
    for (const batch of batches) {
      if (!batch || !Array.isArray(batch.entries) || batch.entries.length !== ids.length) continue
      if (!batch.entries.every((id, index) => id === ids[index])) continue
      if (typeof batch.url === 'string') return batch.url
    }
    return undefined
  }

  /**
   * Read one Client bundle exactly as the next document boot would receive it.
   *
   * The desktop shell boots from the injection rows it captured when the Host
   * started, so their revisions can be older than the graph the Host serves now.
   * Requesting an old revision normally answers 404, and a single such entry fails
   * the whole boot with the desktop's "startup failure" dialog. The rows address
   * *entries*, and an entry's content is its current code, so an old revision can be
   * answered from the current graph: the same code under the revision label the boot
   * asked for. A composed batch resolves the same way (exact batch match first, then
   * the per-entry bodies in the requested order).
   * @param modules - the `clientModules` service.
   * @param url - the requested bundle URL.
   * @returns `{ status, text, revived, ids }`; `status` 200 means the boot gets a body.
   */
  /**
   * Build a request object `clientModules.fetchBundle` accepts.
   *
   * DSH 0.2.2-rc.1's `fetchBundle` reads `request.headers.get('if-none-match')`
   * unconditionally, so a bare `{ method, url }` literal throws
   * `TypeError: Cannot read properties of undefined (reading 'get')` inside the
   * module registry. Every bundle request then dies and the desktop boot fails.
   */
  const bundleRequest = (url, method) => {
    const headers = new Map()
    return {
      method: method || 'GET',
      url,
      headers: {
        get: (name) => {
          const key = String(name).toLowerCase()
          return headers.has(key) ? headers.get(key) : null
        },
      },
    }
  }

  async function readClientBundle(modules, url) {
    const absolute = (value) => (value.charAt(0) === '/' ? value : '/' + value)
    const path = absolute(url)
    // DSH 0.2.2: the `clientModules` service exposes a `serve`-style route, not
    // `fetchBundle`. Without this guard every `/plugins/??...` request throws a
    // TypeError here, the fallback below throws too, and the route answers an
    // empty 500 that fails the whole desktop boot.
    if (!modules || typeof modules.fetchBundle !== 'function') {
      return { status: 404, text: undefined, revived: false }
    }
    const direct = await modules.fetchBundle(bundleRequest(path, 'GET'))
    if (direct && direct.status === 200) return { status: 200, text: await direct.text(), revived: false }
    let ids
    try {
      ids = comboIds(new URL(path, 'http://x').search)
    } catch (error) {
      ids = undefined
    }
    const graph = typeof modules.graph === 'function' ? modules.graph() : undefined
    if (ids === undefined || graph === undefined) {
      return { status: direct ? direct.status : 404, text: undefined, revived: false }
    }
    const read = async (candidate) => {
      const response = await modules.fetchBundle(bundleRequest(absolute(candidate), 'GET'))
      return response && response.status === 200 ? await response.text() : undefined
    }
    const pieces = []
    if (ids.length === 1) {
      const current = currentEntryUrl(graph, ids[0])
      if (current !== undefined) {
        const text = await read(current)
        if (text !== undefined) pieces.push(text)
      }
    } else {
      const batchUrl = currentBatchUrl(graph, ids)
      if (batchUrl !== undefined) {
        const text = await read(batchUrl)
        if (text !== undefined) pieces.push(text)
      } else {
        for (const id of ids) {
          const current = currentEntryUrl(graph, id)
          pieces.push(current === undefined ? undefined : await read(current))
        }
      }
    }
    const complete = pieces.length > 0 && pieces.every((piece) => typeof piece === 'string')
    if (!complete) return { status: direct ? direct.status : 404, text: undefined, revived: false }
    return { status: 200, text: pieces.join('\n'), revived: true, ids }
  }

  /**
   * Compile the Client scripts the next document boot would load, so the page can
   * refuse a reload that the boot audit would treat as fatal.
   *
   * The desktop reload re-applies the injection rows the desktop process captured at
   * Host start, and the module loader then fetches each entry bundle by its
   * revisioned URL. A bundle that no longer loads or no longer compiles therefore
   * fails the whole boot ("entries did not activate") and the app is unusable until
   * it is restarted — the exact failure this check exists to prevent.
   * @param request - `{ scripts: [{id, url}], inline: [{id, text}] }` from the page.
   * @returns per-resource problems; empty problems mean the boot can be attempted.
   */
  async function inspectBootScripts(request) {
    const problems = []
    const scripts = request && Array.isArray(request.scripts) ? request.scripts : []
    const inline = request && Array.isArray(request.inline) ? request.inline : []
    const modules = ctx.get('clientModules')
    const canServe = Boolean(modules && typeof modules.fetchBundle === 'function')
    let checked = 0
    let revived = 0

    for (const script of scripts.slice(0, 256)) {
      const id = script && typeof script.id === 'string' ? script.id : 'unknown'
      const url = script && typeof script.url === 'string' ? script.url : undefined
      if (url === undefined || url.length === 0) continue
      checked += 1
      let text
      if (canServe) {
        try {
          const served = await readClientBundle(modules, url)
          if (served.status !== 200 || served.text === undefined) {
            problems.push({ id, url, error: 'http-' + String(served.status) })
            continue
          }
          text = served.text
          if (served.revived) revived += 1
        } catch (error) {
          problems.push({ id, url, error: 'fetch: ' + String((error && error.message) || error) })
          continue
        }
      }
      if (text !== undefined) {
        if (text.indexOf('__ModuleLoader__') === -1) {
          problems.push({ id, url, error: 'bundle does not register a Client module' })
          continue
        }
        const failure = compileFailure(text)
        if (failure !== undefined) problems.push({ id, url, error: failure })
      }
    }

    for (const block of inline.slice(0, 64)) {
      const id = block && typeof block.id === 'string' ? block.id : 'inline'
      const text = block && typeof block.text === 'string' ? block.text : undefined
      if (text === undefined || text.length === 0) continue
      checked += 1
      const failure = compileFailure(text)
      if (failure !== undefined) problems.push({ id, error: failure })
    }

    return {
      ok: problems.length === 0,
      checked,
      revived,
      served: canServe,
      problems,
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PREFLIGHT_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          const payload = await readJsonBody(req, 1048576)
          if (payload === undefined) {
            reply(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          try {
            const report = await inspectBootScripts(payload)
            probe('preflight', {
              ok: report.ok,
              checked: report.checked,
              revived: report.revived,
              served: report.served,
              problems: report.problems.slice(0, 3),
            })
            reply(res, 200, report)
          } catch (error) {
            probe('preflight-failed', { message: String((error && error.message) || error) })
            reply(res, 500, { ok: false, error: 'internal' })
          }
        },
      }),
    'ui-enhance: reload preflight route',
  )

  /**
   * Serve `/plugins/` combo bundles, reviving a revision that the current graph no
   * longer advertises (see `readClientBundle`). This is what keeps a reload working
   * after a plugin was installed or edited mid-session: the desktop shell's injection
   * rows are pinned at Host start, so without this the boot requests old revisions
   * that answer 404 and the shell turns that into its fatal "startup failure" dialog.
   * A request whose revision is current is relayed from the module service unchanged.
   */
  ctx.effect(
    () => {
      // The reviving route can only work when `clientModules` offers the bundle
      // reader it is written against. DSH 0.2.2 exposes none, and registering an
      // exact `/plugins/` route anyway would shadow the Host's own combo handler
      // and fail every plugin bundle in the boot. Stay out of the way instead.
      const modules = ctx.get('clientModules')
      if (!modules || typeof modules.fetchBundle !== 'function') return
      return ctx.webServer.register({
        kind: 'exact',
        path: '/plugins/',
        handler: async (req, res) => {
          const modules = ctx.get('clientModules')
          if (!modules || typeof modules.fetchBundle !== 'function') {
            res.statusCode = 404
            res.end()
            return
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.end()
            return
          }
          try {
            const served = await readClientBundle(modules, req.url || '/')
            if (served.status !== 200 || served.text === undefined) {
              res.statusCode = served.status === 200 ? 502 : served.status
              res.end()
              return
            }
            res.statusCode = 200
            res.setHeader('content-type', 'text/javascript; charset=utf-8')
            // The body always matches the *current* graph, whatever revision the URL
            // names, so it must not be cached as immutable under that label.
            res.setHeader('cache-control', 'no-store')
            if (served.revived) {
              res.setHeader('x-ui-enhance-revived', '1')
              probe('bundle-revived', { url: req.url, ids: served.ids, phase: 'boot' })
            }
            if (req.method === 'HEAD') {
              res.end()
              return
            }
            res.end(Buffer.from(served.text, 'utf8'))
          } catch (error) {
            probe('bundle-revive-failed', { message: String((error && error.message) || error) })
            // Never leave a boot request unanswered: relay the module service's own answer.
            try {
              const response = await modules.fetchBundle(bundleRequest(req.url || '/', 'GET'))
              res.statusCode = response.status
              const type =
                response.headers && typeof response.headers.get === 'function'
                  ? response.headers.get('content-type')
                  : undefined
              if (typeof type === 'string') res.setHeader('content-type', type)
              if (req.method === 'HEAD' || response.status !== 200) {
                res.end()
                return
              }
              res.end(Buffer.from(await response.arrayBuffer()))
            } catch (fallbackError) {
              res.statusCode = 500
              res.end()
            }
          }
        },
      },
      'ui-enhance: revision-tolerant plugin bundle route',
      )
    },
  )

  /**
   * Turn-time budget compaction. `agent/pre-step` runs before every model request of a
   * turn, so a Session whose measured context reaches 90% of its budget is reduced while
   * the task is still running. The forced reduction reuses the compaction service's
   * context-overflow entry point — the same path the harness itself takes after a
   * confirmed overflow — which prunes oversized tool results and condenses the oldest
   * balanced span without waiting for the model-window pressure threshold.
   */
  const activeCompactions = new Set()
  const lastAttempt = new Map()
  const reportedUsage = new Set()
  let preStepSeen = false
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const agent = payload && payload.agent
          const signal = payload && payload.signal
          const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
          if (sessionId !== undefined && !preStepSeen) {
            preStepSeen = true
            probe('pre-step', { sessionId })
          }
          const budget = sessionId === undefined ? undefined : (budgets.get(sessionId) ?? budgets.get('__default'))
          if (budget !== undefined && !(signal && signal.aborted) && !activeCompactions.has(sessionId)) {
            const now = Date.now()
            if (now - (lastAttempt.get(sessionId) || 0) >= AUTO_COMPACT_COOLDOWN_MS) {
              const meter = ctx.get('tokenMeter')
              const presets = ctx.get('agentPresets')
              const compaction =
                presets && typeof presets.serviceFor === 'function'
                  ? presets.serviceFor(agent, 'compaction')
                  : undefined
              if (meter && compaction && typeof compaction.compactIfNeeded === 'function') {
                // Measure what the page shows, not a separate estimate: `meter.measure()`
                // replays the whole surface with heuristics and routinely reads far above
                // the provider's own prompt size (which is why a 18% context looked like
                // 90% and compacted). `contextPressure` is the same projection the composer
                // ring renders, and `pressureTokens` is the measured prompt itself.
                const pressure =
                  typeof meter.contextPressure === 'function' ? meter.contextPressure(agent.session) : undefined
                const used =
                  pressure && typeof pressure.pressureTokens === 'number'
                    ? pressure.pressureTokens
                    : pressure && typeof pressure.projectedTokens === 'number'
                      ? pressure.projectedTokens
                      : undefined
                if (used !== undefined && !reportedUsage.has(sessionId)) {
                  reportedUsage.add(sessionId)
                  probe('budget-check', {
                    sessionId,
                    used,
                    budget,
                    percent: Math.floor((used / budget) * 100),
                  })
                }
                if (used !== undefined && used >= (budget * AUTO_COMPACT_PERCENT) / 100) {
                  lastAttempt.set(sessionId, now)
                  activeCompactions.add(sessionId)
                  probe('compact-auto', { sessionId, used, budget })
                  // A hung summary must not hold the turn: the watchdog aborts just this
                  // compaction attempt so the turn can carry on with the unreduced context.
                  const watchdog = new AbortController()
                  const timer = setTimeout(() => {
                    try {
                      watchdog.abort(new Error('ui-enhance: compaction timed out'))
                    } catch (error) {
                      /* the controller is only aborted once */
                    }
                  }, compactTimeoutMs)
                  try {
                    const operationSignal =
                      signal === undefined || signal === null
                        ? watchdog.signal
                        : AbortSignal.any([signal, watchdog.signal])
                    const result = await compaction.compactIfNeeded(agent, 'context-overflow', operationSignal)
                    probe(result ? 'compact-auto-done' : 'compact-auto-skip', { sessionId })
                  } catch (error) {
                    if (watchdog.signal.aborted) probe('compact-auto-timeout', { sessionId })
                    else throw error
                  } finally {
                    clearTimeout(timer)
                    activeCompactions.delete(sessionId)
                  }
                }
              }
            }
          }
        } catch (error) {
          probe('compact-auto-failed', { message: String((error && error.message) || error) })
        }
        return next()
      }),
    'ui-enhance: turn-time budget compaction',
  )

  /**
   * Forced compaction on the Client's request. The shipped `/compact` command is refused
   * while the agent is busy, which is exactly the state a sub-agent is in for its whole
   * turn, so the manual button failed every time. This runs the same reduction the
   * turn-time path uses, which does not care whether a turn is in flight.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: COMPACT_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let raw = ''
          for await (const chunk of req) {
            raw += chunk
            if (raw.length > 8192) {
              reply(res, 413, { ok: false, error: 'too-large' })
              return
            }
          }
          let sessionId
          try {
            const payload = JSON.parse(raw || '{}')
            sessionId = payload && payload.sessionId
          } catch (error) {
            reply(res, 400, { ok: false, error: 'bad-json' })
            return
          }
          if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
            reply(res, 400, { ok: false, error: 'bad-payload' })
            return
          }
          const agents = ctx.get('agents')
          let agent
          if (agents && typeof agents.get === 'function') {
            for (const candidate of sessionCandidates(sessionId)) {
              try {
                agent = agents.get(candidate)
              } catch (error) {
                agent = undefined
              }
              if (agent) break
            }
          }
          if (!agent) {
            reply(res, 409, { ok: false, error: 'agent-not-live' })
            return
          }
          const presets = ctx.get('agentPresets')
          const compaction =
            presets && typeof presets.serviceFor === 'function'
              ? presets.serviceFor(agent, 'compaction')
              : undefined
          if (!compaction || typeof compaction.compactIfNeeded !== 'function') {
            reply(res, 409, { ok: false, error: 'compaction-unavailable' })
            return
          }
          const key = typeof agent.id === 'string' ? agent.id : sessionId
          if (activeCompactions.has(key)) {
            reply(res, 409, { ok: false, error: 'compaction-busy' })
            return
          }
          activeCompactions.add(key)
          const watchdog = new AbortController()
          const timer = setTimeout(() => {
            try {
              watchdog.abort(new Error('ui-enhance: compaction timed out'))
            } catch (error) {
              /* the controller is only aborted once */
            }
          }, compactTimeoutMs)
          try {
            probe('compact-manual', { sessionId })
            const result = await compaction.compactIfNeeded(agent, 'context-overflow', watchdog.signal)
            probe(result ? 'compact-manual-done' : 'compact-manual-skip', { sessionId })
            reply(res, 200, { ok: true, compacted: result !== null && result !== undefined })
          } catch (error) {
            probe('compact-manual-failed', { message: String((error && error.message) || error) })
            reply(res, 200, { ok: false, error: String((error && error.message) || error) })
          } finally {
            clearTimeout(timer)
            activeCompactions.delete(key)
          }
        },
      }),
    'ui-enhance: manual compaction route',
  )

  /**
   * Startup auto-continue for Sessions that an abnormal Host stop interrupted.
   *
   * The log itself records the abnormal stop: `turn/end` is appended from a
   * `finally`, so only a hard death (crash, forced kill, host restart mid-turn)
   * leaves the newest turn boundary as a `turn/start`. Resuming such a Session is
   * safe by design — the agent loop appends synthetic closers for exactly that
   * tail before the next turn starts — and the continuation prompt then picks the
   * work back up. Every step is optional and bounded: services may be missing,
   * logs may be unreadable, and a single failure never fails the scan.
   */
  const autoResumeMode =
    config.autoResume === false
      ? 'off'
      : config.autoResumeMode === 'continue' || config.autoResumeMode === 'detect'
        ? config.autoResumeMode
        : AUTO_RESUME_DEFAULT_MODE
  const autoResume = {
    mode: autoResumeMode,
    delayMs: positiveOr(config.autoResumeDelayMs, DEFAULT_AUTO_RESUME_DELAY_MS),
    windowMs: positiveOr(config.autoResumeWindowMs, DEFAULT_AUTO_RESUME_WINDOW_MS),
    maxSessions: Math.min(
      AUTO_RESUME_MAX_LIMIT,
      Math.floor(positiveOr(config.autoResumeMax, DEFAULT_AUTO_RESUME_MAX)),
    ),
    staggerMs: Math.min(60000, positiveOr(config.autoResumeStaggerMs, DEFAULT_AUTO_RESUME_STAGGER_MS)),
    running: false,
    report: null,
    prompted: new Set(),
  }

  /**
   * List the Sessions that may hold an unclosed turn, most recently active first.
   * `sessionController.list` is the same view the sidebar uses; the persistence
   * listing is the fallback when only that service is available.
   * @returns the candidate summaries, or undefined when no listing service exists.
   */
  /**
   * The four token buckets of one Session listing item.
   *
   * The Host listing carries usage inside item.projections.values.tokenUsage; a Session
   * that has run no turn yet reports none, which is distinct from reporting zero.
   * @param item - one entry from SessionController.list().
   * @returns the buckets with every missing counter defaulted to 0, or undefined.
   */
  function usagePartsOf(item) {
    const values = (item && item.projections && item.projections.values) || {}
    const usage = values.tokenUsage
    if (usage === undefined || usage === null) return undefined
    const n = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    return {
      uncachedInputTokens: n(usage.uncachedInputTokens),
      outputTokens: n(usage.outputTokens),
      cacheReadTokens: n(usage.cacheReadTokens),
      cacheWriteTokens: n(usage.cacheWriteTokens),
    }
  }

  async function listResumableSessions(signal) {
    const query = ctx.get('sessionQuery')
    const controller = ctx.get('sessionController')
    if (controller && typeof controller.list === 'function') {
      try {
        const listed = await controller.list({}, signal)
        const items = listed && Array.isArray(listed.items) ? listed.items : []
        return items.filter((item) => item && typeof item.sessionId === 'string')
      } catch (error) {
        probe('auto-resume-list-failed', { via: 'controller', message: String((error && error.message) || error) })
      }
    }
    if (query && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions(signal)
        return (Array.isArray(records) ? records : [])
          .map((record) => {
            const header = (record && record.header) || {}
            if (typeof header.id !== 'string') return undefined
            return {
              sessionId: header.id,
              updatedAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
              running: false,
              blank: false,
              parentSessionId: header.parentSession,
              formatStatus: record && record.formatStatus,
              cwd: header.cwd,
            }
          })
          .filter((item) => item !== undefined)
      } catch (error) {
        probe('auto-resume-list-failed', { via: 'query', message: String((error && error.message) || error) })
      }
    }
    return undefined
  }

  /**
   * Read one Session's durable log. Returns undefined when it cannot be read.
   * @param sessionId - the Session to read.
   */
  async function readSessionEvents(sessionId) {
    /*
     * The tail is what decides the verdict, so read the durable log first: it is
     * addressed by absolute seq and paged, which means a fully-read tail can never
     * be mistaken for a closed turn. `sessionQuery.readSession` is only a fallback,
     * because its result may be a bounded window rather than the whole log.
     */
    const persistence = ctx.get('sessionPersistence')
    if (persistence && typeof persistence.open === 'function') {
      let handle
      try {
        handle = await persistence.open(sessionId, 'read')
        const events = []
        let offset = 0
        for (let guard = 0; guard < READ_PAGE_GUARD; guard += 1) {
          const page = await handle.read(offset, READ_PAGE_SIZE)
          const batch = page && Array.isArray(page.events) ? page.events : []
          if (batch.length === 0) break
          for (const event of batch) events.push(event)
          offset += batch.length
          if (batch.length < READ_PAGE_SIZE) break
        }
        if (events.length > 0) return events
      } catch (error) {
        /* fall through to the query view */
      } finally {
        if (handle) {
          try {
            await handle.close()
          } catch (error) {
            /* the read result is already captured */
          }
        }
      }
    }
    const query = ctx.get('sessionQuery')
    if (query && typeof query.readSession === 'function') {
      const loaded = await query.readSession(sessionId)
      if (loaded && Array.isArray(loaded.events)) return loaded.events
    }
    return undefined
  }

  /**
   * Send the continuation prompt into one interrupted Session. This is exactly the
   * path a user send takes (`sessionController.prompt`), so the resumed work is a
   * normal turn: it appears in the sidebar and can be cancelled as usual.
   * @param sessionId - the Session to continue.
   * @returns the accepted flag, or the failure reason.
   */
  async function continueSession(sessionId) {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.prompt !== 'function') return { accepted: false, error: 'prompt-unavailable' }
    const result = await controller.prompt(
      {
        requestId: nextRequestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: AUTO_RESUME_PROMPT }],
      },
      new AbortController().signal,
    )
    return { accepted: result === undefined || result.accepted === true }
  }

  /**
   * One scan over the Session list. Reports what it found even in `detect` mode, so
   * the same code path can be verified before it is allowed to send prompts.
   * @param runMode - `detect` (report only) or `continue` (also prompt).
   * @param source - `startup` or `manual`, for the report.
   */
  async function scanInterruptedSessions(runMode, source, manualScan) {
    const startedAt = Date.now()
    const report = {
      mode: runMode,
      source: source || 'startup',
      startedAt,
      finishedAt: null,
      candidates: 0,
      scanned: 0,
      interrupted: 0,
      failedTurns: 0,
      /** Stops grouped by abstract cause (error code, or `unknown` for an unseen shape). */
      byCause: {},
      prompted: 0,
      failed: 0,
      skipped: undefined,
      /** Delegated (sub-agent) Sessions folded into an owning Session, or left orphaned. */
      delegated: { scanned: 0, folded: 0, orphaned: 0, unreachable: 0 },
      sessions: [],
    }
    let summaries
    try {
      summaries = await listResumableSessions(new AbortController().signal)
    } catch (error) {
      report.skipped = 'list-failed'
      report.error = String((error && error.message) || error)
      report.finishedAt = Date.now()
      return report
    }
    if (summaries === undefined) {
      report.skipped = 'session-list-unavailable'
      report.finishedAt = Date.now()
      return report
    }

    const now = Date.now()
    const candidates = []
    const deferred = []
    for (const item of summaries) {
      if (item.running === true) continue
      if (item.blank === true) continue
      if (item.formatStatus !== undefined && item.formatStatus !== 'current') continue
      /*
       * A delegated Session is never continued on its own: it runs inside its parent's
       * work, a resumed sub-agent would hold no delegating parent to receive its result,
       * and it would then sit in the sidebar as an orphan turn. It is not dropped
       * either — it is queued here and folded into its owning Session's decision below,
       * so the parent is the Session that is resumed and the parent re-runs the
       * sub-agents its own interrupted turn never collected.
       */
      const delegated =
        item.origin === 'subagent' ||
        (typeof item.parentSessionId === 'string' && item.parentSessionId.length > 0)
      if (delegated) {
        deferred.push(item)
        continue
      }
      /*
       * No age filter here. A Session interrupted days ago is still interrupted, and
       * dropping it during collection is what made the resume button report
       * "nothing to resume" on exactly the Sessions the user could see as stopped.
       * Age is judged per Session once its log has been read.
       */
      candidates.push(item)
    }
    candidates.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
    report.candidates = candidates.length

    /*
     * Scan every candidate, not a top-N slice. A host that died mid-turn tends to
     * leave several Sessions open at once, so a small cap silently strands the rest
     * — the user sees stopped tasks the resume pass never even looked at.
     */
    const scanLimit = Math.max(candidates.length, autoResume.maxSessions)
    for (const item of candidates.slice(0, scanLimit)) {
      const entry = { sessionId: item.sessionId, updatedAt: item.updatedAt }
      report.sessions.push(entry)
      let events
      try {
        events = await readSessionEvents(item.sessionId)
      } catch (error) {
        entry.decision = 'unreadable'
        entry.error = String((error && error.message) || error)
        report.failed += 1
        await settle()
        continue
      }
      if (events === undefined) {
        entry.decision = 'unreadable'
        entry.error = 'log-unavailable'
        report.failed += 1
        await settle()
        continue
      }
      report.scanned += 1
      /*
       * A delegated Session may reach this loop through the fallback listing, which does
       * not filter it. Record the decision for the report but spend no further work on
       * it: the owning Session below is what gets continued, and it re-runs the
       * sub-agents itself. Continuing the child here would start an orphan turn.
       */
      const header = events.length > 0 && events[0] && events[0].type === 'session' ? events[0] : undefined
      if (header && header.origin === 'subagent') {
        entry.decision = 'subagent'
        if (typeof header.parentSession === 'string') entry.parentSessionId = header.parentSession
        await settle()
        continue
      }
      const newest = events.length > 0 ? events[events.length - 1] : undefined
      const lastAt = newest && typeof newest.time === 'number' ? newest.time : undefined
      if (lastAt !== undefined) entry.lastEventAt = lastAt
      /*
       * Decide the turn before judging age. An abnormal stop leaves no `turn/end`,
       * so the log still says "interrupted" days later — that is exactly the case a
       * user is looking for when they ask to resume. Age only gates the automatic
       * continuation (an old Session should not silently start working again); it
       * must never hide the Session from detection.
       */
      const open = openTurnOf(events)
      /*
       * Age only guards the *guessed* case. A torn tail (`interrupted`) is inferred from
       * the absence of a closing event, so an old log is genuinely ambiguous. An explicit
       * failed `turn/end` is a recorded fact, so it stays resumable however old it is —
       * otherwise a transport failure from yesterday is silently unfixable.
       */
      const stale =
        open !== undefined &&
        open.closed !== true &&
        lastAt !== undefined &&
        now - lastAt > autoResume.windowMs
      if (open === undefined) {
        entry.decision = 'balanced'
        await settle()
        continue
      }
      /*
       * `failed` is a turn that closed on a resumable error (whatever the provider
       * called it); `interrupted` is a torn tail with no closing event. Both are the
       * same decision to the user — the task did not finish — so both are counted and
       * both are resumed by the same code path.
       */
      entry.decision = open.closed ? 'failed' : 'interrupted'
      entry.reason = open.reason
      if (open.code !== undefined) entry.code = open.code
      if (open.cause !== undefined) entry.cause = open.cause
      if (open.message !== undefined) entry.message = open.message
      if (open.turn !== null) entry.turn = open.turn
      if (open.at !== undefined) entry.openSince = open.at
      if (stale) entry.stale = true
      if (open.closed) report.failedTurns += 1
      report.interrupted += 1
      if (open.closed) {
        /*
         * Group the stops by the abstract cause actually used, so a report shows at a
         * glance which end kinds and codes the scanner met — including `unknown`, the
         * label for a shape this build did not recognise. That is the signal that a new
         * failure mode exists; it is resumed all the same, so nothing needs editing.
         */
        const bucket = open.cause === 'unknown' ? 'unknown' : open.code || open.reason || 'unspecified'
        report.byCause[bucket] = (report.byCause[bucket] || 0) + 1
      }
      if (runMode !== 'continue') {
        entry.action = 'detected'
        await settle()
        continue
      }
      if (stale) {
        entry.action = 'stale'
        await settle()
        continue
      }
      if (autoResume.prompted.has(item.sessionId)) {
        entry.action = 'already-prompted'
        await settle()
        continue
      }
      try {
        const result = await continueSession(item.sessionId)
        if (result.accepted) {
          autoResume.prompted.add(item.sessionId)
          entry.action = 'prompted'
          report.prompted += 1
          probe('auto-resume-prompted', { sessionId: item.sessionId, turn: open.turn })
        } else {
          entry.action = 'rejected'
          report.failed += 1
          probe('auto-resume-rejected', { sessionId: item.sessionId, error: result.error })
        }
      } catch (error) {
        entry.action = 'failed'
        entry.error = String((error && error.message) || error)
        report.failed += 1
        probe('auto-resume-failed', { sessionId: item.sessionId, message: entry.error })
      }
      await new Promise((resolve) => {
        setTimeout(resolve, autoResume.staggerMs)
      })
    }

    /*
     * Delegated Sessions last. Their fate depends on the verdict of every ancestor, so
     * they are folded in only once every top-level Session has been classified.
     */
    if (deferred.length > 0) {
      const entries = new Map()
      for (const entry of report.sessions) entries.set(entry.sessionId, entry)
      const byId = new Map()
      for (const item of summaries) byId.set(item.sessionId, item)
      const delegation = await foldDelegatedSessions(deferred, byId, entries, report, runMode)
      report.delegated = {
        scanned: deferred.length,
        folded: delegation.folded,
        orphaned: delegation.orphaned,
        unreachable: delegation.unreachable,
      }
    }

    report.finishedAt = Date.now()
    report.durationMs = report.finishedAt - startedAt
    return report
  }

  /**
   * The instruction a delegated Session was created with.
   *
   * A sub-agent's log opens with the prompt its parent handed it, so replaying that
   * text is the most faithful "continue where you stopped" available without a live
   * delegating call. Falls back to the generic continuation instruction when the log
   * does not expose a user message (an older format, or a seeded child).
   * @param events - the child's committed event log.
   */
  function delegationPromptOf(events) {
    if (Array.isArray(events)) {
      for (const event of events) {
        if (!event || event.type !== 'user/message') continue
        const message = event.data && event.data.message
        const content = message && Array.isArray(message.content) ? message.content : []
        const text = content
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim()
        if (text.length > 0) return text
      }
    }
    return AUTO_RESUME_PROMPT
  }

  /**
   * Continue one delegated Session in place, under its delegating parent.
   *
   * `agents.resume` reloads the persisted child Session and gives it a live runtime
   * owner (`parentAgent`), which is the relationship a continuable sub-agent has. The
   * child then receives its original instruction again and finishes the work; a failed
   * resume falls back to a plain prompt so the child's log is never left stranded.
   * @param childId - the delegated Session to revive.
   * @param parentId - its delegating Session.
   * @param events - the child's log, used to recover the original instruction.
   */
  async function reviveSubagent(childId, parentId, events) {
    /*
     * A delegated Session cannot be driven directly. Its id is owned by "subagent
     * routing": `sessionController.prompt` on it answers `session ... is owned by
     * subagent routing`, and `agents.resume` finds its write handle already held. That
     * is the Host protecting the parent/child relationship — a sub-agent's turn is only
     * meaningful while the parent that asked for it is running.
     *
     * The only caller that can continue it is therefore the delegating parent itself.
     * It is prompted with a task-shaped instruction naming the child id and the work
     * that child was given, so the parent re-delegates through its own `spawn_subagent`
     * and collects the result, which is exactly what its interrupted delegation would
     * have done. The child's original instruction travels in the prompt so the parent
     * does not have to reconstruct it from a log it cannot see.
     */
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.prompt !== 'function') {
      return { accepted: false, revived: false, error: 'prompt-unavailable' }
    }
    const original = delegationPromptOf(events)
    const brief = original.length > 1200 ? original.slice(0, 1200) + '…' : original
    const text =
      AUTO_RESUME_PROMPT +
      '\n\n另外：本次任务委派的子代理（会话 ' +
      childId +
      '）中途异常退出，没有返回结果。请重新委派这部分工作并继续完成。它当时收到的任务是：\n\n' +
      brief
    const result = await controller.prompt(
      {
        requestId: nextRequestId(),
        sessionId: parentId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    )
    return { accepted: result === undefined || result.accepted === true, revived: false }
  }

  /**
   * Fold interrupted delegated Sessions into the Session that owns them.
   *
   * A sub-agent is a Session of its own (`origin: 'subagent'`, `parentSession` set), but
   * it is not an independent task: it exists to answer one call its parent made. A
   * crashed Host leaves those children with an open turn just like any other Session,
   * and the old scan simply skipped them — so an interrupted delegation was never
   * resumed by anything.
   *
   * The child must not be prompted directly. Its own turn was the parent's delegated
   * work, and a standalone prompt would arm it with its own tools instead of the parent
   * that is waiting for its answer, leaving an orphan turn in the sidebar.
   *
   * So each interrupted child is walked up its `parentSession` chain to the nearest
   * ancestor that is itself resumable. That ancestor is the Session whose turn was
   * actually interrupted from the user's point of view: continuing it re-runs the
   * delegating step, which re-creates the sub-agent with its work replayed. When no
   * ancestor is resumable the chain has ended, and the child's interrupted work cannot
   * be continued by anyone, so it is reported as such instead of being prompted.
   * A parent whose own turn closed cleanly while its child never did is the third case:
   * its delegation died alone, and the parent is told through `orphanSubagents` rather
   * than being forced back into an already-finished turn.
   *
   * @param deferred - delegated Session summaries from the list.
   * @param byId - every summary seen this scan, keyed by Session id (for ancestors).
   * @param entries - the report entries of this scan, keyed by Session id.
   * @param report - the scan report this pass contributes its counts to.
   * @param runMode - `detect` classifies only; `continue` also revives orphaned children.
   * @returns counts of the children folded in, orphaned, and left unreachable.
   */
  async function foldDelegatedSessions(deferred, byId, entries, report, runMode) {
    const folded = new Set()
    let unreachable = 0
    let orphaned = 0
    for (const child of deferred) {
      /*
       * Was this child's own turn even interrupted? A sub-agent that finished cleanly
       * (its parent collected the result, or the task itself ended) has nothing to
       * resume and must not drag its parent back into work. Only a torn or failed
       * delegation is folded.
       */
      const childEvents = await readSessionEvents(child.sessionId)
      const childOpen = childEvents === undefined ? undefined : openTurnOf(childEvents)
      if (childOpen === undefined) {
        // Finished, or unreadable: either way there is nothing here to continue.
        continue
      }
      let parentId =
        typeof child.parentSessionId === 'string' && child.parentSessionId.length > 0
          ? child.parentSessionId
          : undefined
      if (parentId === undefined) {
        // The summary did not carry the lineage; the durable header did.
        const events = await readSessionEvents(child.sessionId)
        const header = events && events.length > 0 && events[0] && events[0].type === 'session' ? events[0] : undefined
        if (header && typeof header.parentSession === 'string') parentId = header.parentSession
      }
      let owner = undefined
      const seen = new Set([child.sessionId])
      for (let depth = 0; parentId !== undefined && depth < 32; depth += 1) {
        if (seen.has(parentId)) break
        seen.add(parentId)
        const entry = entries.get(parentId)
        if (entry !== undefined) {
          /*
           * The ancestor was scanned in this pass.
           *
           * `interrupted`/`failed`: its own turn never finished, so continuing it is the
           * normal case — the delegating step runs again and the sub-agent comes back.
           *
           * `balanced`: the parent's turn DID finish, yet this child never closed. That
           * is a delegation that died on its own (a crashed worker, a provider failure
           * inside the child) while the parent moved on without a result. The parent is
           * the only Session that can re-run it, but its turn is closed, so this pass
           * cannot reach it by itself: the child is counted as orphaned and left for the
           * user, rather than prompting the child standalone (which would create an
           * orphan turn with no parent waiting for it).
           */
          if (entry.decision === 'interrupted' || entry.decision === 'failed') {
            owner = entry
            if (entry.subagents === undefined) entry.subagents = 0
            entry.subagents += 1
            entry.subagentIds = entry.subagentIds || []
            if (entry.subagentIds.length < 8) entry.subagentIds.push(child.sessionId)
            folded.add(child.sessionId)
          } else if (entry.decision === 'balanced') {
            /*
             * The parent's own turn closed cleanly and it no longer waits for this child.
             * The child cannot be driven on its own (`owned by subagent routing`), so the
             * delegating parent is asked to re-run the delegation: it receives the
             * child's original instruction and names the child Session, and its own
             * `spawn_subagent` starts the work again with the parent/child relationship
             * intact. The parent is marked as this pass's action so the report says a
             * sub-agent was revived through it.
             */
            owner = entry
            entry.orphanSubagents = (entry.orphanSubagents || 0) + 1
            entry.orphanSubagentIds = entry.orphanSubagentIds || []
            if (entry.orphanSubagentIds.length < 8) entry.orphanSubagentIds.push(child.sessionId)
            folded.add(child.sessionId)
            orphaned += 1
            if (runMode === 'continue' && !autoResume.prompted.has(child.sessionId)) {
              try {
                const result = await reviveSubagent(child.sessionId, parentId, childEvents)
                if (result.accepted) {
                  autoResume.prompted.add(child.sessionId)
                  entry.orphanRevived = (entry.orphanRevived || 0) + 1
                  report.prompted += 1
                  if (entry.action === undefined) entry.action = 'subagent-prompted'
                } else {
                  report.failed += 1
                }
                probe('auto-resume-subagent', {
                  sessionId: child.sessionId,
                  parentSessionId: parentId,
                  accepted: result.accepted === true,
                })
              } catch (error) {
                report.failed += 1
                probe('auto-resume-subagent-failed', {
                  sessionId: child.sessionId,
                  message: String((error && error.message) || error),
                })
              }
              await new Promise((resolve) => {
                setTimeout(resolve, autoResume.staggerMs)
              })
            }
          }
          break
        }
        const ancestor = byId.get(parentId)
        if (ancestor === undefined) break
        parentId =
          typeof ancestor.parentSessionId === 'string' && ancestor.parentSessionId.length > 0
            ? ancestor.parentSessionId
            : undefined
      }
      if (!folded.has(child.sessionId)) unreachable += 1
    }
    return { folded: folded.size, unreachable, orphaned }
  }

  /**
   * Run one scan unless one is already running, and record its report for the
   * status route. Never throws: a failed scan must not disturb the Host.
   * @param runMode - `detect`, `continue`, or undefined for the configured mode.
   * @param source - `startup` or `manual`.
   */
  async function runAutoResume(runMode, source) {
    const mode = runMode === 'detect' || runMode === 'continue' ? runMode : autoResume.mode
    if (mode === 'off') return { mode, skipped: 'disabled', source: source || 'startup' }
    if (autoResume.running) return { mode, skipped: 'busy', source: source || 'startup' }
    autoResume.running = true
    try {
      const report = await scanInterruptedSessions(mode, source, source === 'manual')
      autoResume.report = report
      probe('auto-resume', {
        mode,
        source: report.source,
        candidates: report.candidates,
        scanned: report.scanned,
        interrupted: report.interrupted,
        failedTurns: report.failedTurns,
        byCause: report.byCause,
        prompted: report.prompted,
        failed: report.failed,
        skipped: report.skipped,
      })
      return report
    } catch (error) {
      const failure = { mode, source: source || 'startup', error: String((error && error.message) || error) }
      autoResume.report = failure
      probe('auto-resume-crashed', { mode, message: failure.error })
      return failure
    } finally {
      autoResume.running = false
    }
  }

  if (autoResume.mode !== 'off') {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void runAutoResume(undefined, 'startup')
      }, autoResume.delayMs)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, 'ui-enhance: startup interrupted-session scan')
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: AUTO_RESUME_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          let run
          try {
            run = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('run') || undefined
          } catch (error) {
            run = undefined
          }
          /*
           * `?explain=<json>` runs one turn/end reason through the classifier and shows
           * the verdict. It is read-only and keeps the abstract rule set inspectable from
           * the outside, so "will this new error be resumed?" is a curl away instead of a
           * code change — which is the whole point of the classification layer.
           */
          let explain
          try {
            explain = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('explain')
          } catch (error) {
            explain = null
          }
          if (explain !== null) {
            let parsed
            try {
              parsed = JSON.parse(explain)
            } catch (error) {
              reply(res, 400, { ok: false, error: 'bad-json' })
              return
            }
            reply(res, 200, { ok: true, verdict: classifyTurnEnd(parsed) })
            return
          }
          if (run === 'detect' || run === 'continue') {
            const report = await runAutoResume(run, 'manual')
            reply(res, report && report.skipped === 'busy' ? 409 : 200, {
              ok: report && report.skipped !== 'busy',
              mode: autoResume.mode,
              report,
            })
            return
          }
          reply(res, 200, {
            ok: true,
            mode: autoResume.mode,
            running: autoResume.running,
            windowMs: autoResume.windowMs,
            maxSessions: autoResume.maxSessions,
            prompted: autoResume.prompted.size,
            report: autoResume.report,
          })
        },
      }),
    'ui-enhance: auto-resume route',
  )

  /** Branch answers by resolved directory, so a burst of file tabs shares one read. */
  const gitCache = new Map()
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: GIT_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'GET') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let target = ''
          try {
            target = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('path') || ''
          } catch (error) {
            target = ''
          }
          target = target.slice(0, 2048)
          if (target.length === 0 || target.indexOf('\u0000') !== -1 || !isAbsolute(target)) {
            reply(res, 400, { ok: false, error: 'bad-path' })
            return
          }
          const directory = resolve(target)
          const cached = gitCache.get(directory)
          if (cached !== undefined && Date.now() - cached.at < GIT_CACHE_MS) {
            reply(res, 200, cached.response)
            return
          }
          let report
          try {
            report = await readGitBranch(directory)
          } catch (error) {
            report = { repo: false }
          }
          const response = {
            ok: true,
            path: directory,
            repo: report.repo === true,
            branch: typeof report.branch === 'string' && report.branch.length > 0 ? report.branch : null,
            detached: report.detached === true,
            root: typeof report.root === 'string' ? report.root : null,
          }
          gitCache.set(directory, { at: Date.now(), response })
          if (gitCache.size > GIT_CACHE_LIMIT) gitCache.delete(gitCache.keys().next().value)
          reply(res, 200, response)
        },
      }),
    'ui-enhance: workspace git branch route',
  )

  probe('host-apply', {
    build: 'v0.9.35',
    gitBranch: true,
    autoResume: autoResume.mode,
    delayMs: autoResume.delayMs,
    preflight: true,
  })

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROBE_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method === 'POST') {
            let raw = ''
            for await (const chunk of req) {
              raw += chunk
              if (raw.length > 16384) break
            }
            try {
              probeLog.push(JSON.parse(raw))
              if (probeLog.length > PROBE_LIMIT) probeLog.splice(0, probeLog.length - PROBE_LIMIT)
            } catch (error) {
              reply(res, 400, { ok: false, error: 'bad-json' })
              return
            }
            reply(res, 200, { ok: true })
            return
          }
          reply(res, 200, { ok: true, events: probeLog })
        },
      }),
    'ui-enhance: probe route',
  )


  /**
   * Fetch one ShaderToy work for the Client half.
   *
   * ShaderToy refuses every plain HTTP client with `403 Bad request`, so this route does
   * what the user would otherwise have to do by hand: it drives the installed browser
   * through the challenge and then reads the work. See `shadertoy.mjs` for the details.
   * The reply carries the raw site payload plus every channel texture as a data URL, so
   * the Client can store a work and render it with no further network access.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SHADERTOY_PATH,
        handler: async (req, res) => {
          if (!isLoopback(req.socket.remoteAddress)) {
            reply(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'GET') {
            reply(res, 405, { ok: false, error: 'method' })
            return
          }
          let id = ''
          let force = false
          try {
            const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams
            id = query.get('id') || ''
            force = query.get('force') === '1'
          } catch (error) {
            id = ''
          }
          if (!/^[A-Za-z0-9]{4,64}$/.test(id)) {
            reply(res, 400, { ok: false, error: 'bad-id' })
            return
          }
          let result
          try {
            result = await fetchShaderToyWork(id, { force })
          } catch (error) {
            reply(res, 502, { ok: false, error: 'unreachable', detail: String((error && error.stack) || error).slice(0, 600) })
            return
          }
          if (result.error !== undefined) {
            reply(res, result.error === 'nobrowser' ? 503 : 502, {
              ok: false,
              error: result.error,
            })
            return
          }
          reply(res, 200, {
            ok: true,
            shader: result.shader,
            textures: result.textures || {},
            cached: result.cached === true,
          })
        },
      }),
    'ui-enhance: shadertoy route',
  )
/**
   * Session listing with token totals for the left browser.
   *
   * ?workspaceId=<id> restricts the answer to that Workspace’s Sessions (feature #5);
   * without it every Session is reported. Only raw token counts cross this route: pricing
   * stays on the Client, which owns the model rate table.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        method: 'GET',
        path: SUMMARY_PATH,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            const workspaceId = url.searchParams.get('workspaceId') || undefined
            const scopeOnly = url.searchParams.get('scope') === 'workspace'
            const cwd = url.searchParams.get('cwd') || undefined
            const controller = ctx.get('sessionController')
            const listed =
              controller && typeof controller.list === 'function' ? await controller.list({}) : undefined
            const all = listed && Array.isArray(listed.items) ? listed.items : []

            // A Workspace is a directory, so "this Workspace only" keeps the Sessions
            // whose cwd sits at or under it (which also covers their subagent children).
            // Compare directory paths after normalising separators: a Session records its cwd
            // with native backslashes while the browser may send a forward-slash path.
            const normDir = (value) => value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
            const base = typeof cwd === 'string' && cwd.length > 0 ? normDir(cwd) : undefined
            const inScope = (item) => {
              if (!scopeOnly || base === undefined) return true
              const at = typeof item.cwd === 'string' && item.cwd.length > 0 ? normDir(item.cwd) : ''
              return at === base || at.startsWith(base + '/')
            }

            const detail = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
            let tokens = 0
            let tokenKnown = 0
            const items = []
            for (const item of all) {
              if (!item || typeof item.sessionId !== 'string') continue
              if (!inScope(item)) continue
              const parts = usagePartsOf(item)
              let sessionTokens
              if (parts !== undefined) {
                sessionTokens =
                  parts.uncachedInputTokens + parts.outputTokens + parts.cacheReadTokens + parts.cacheWriteTokens
                tokens += sessionTokens
                tokenKnown += 1
                detail.uncachedInputTokens += parts.uncachedInputTokens
                detail.outputTokens += parts.outputTokens
                detail.cacheReadTokens += parts.cacheReadTokens
                detail.cacheWriteTokens += parts.cacheWriteTokens
              }
              const values = (item.projections && item.projections.values) || {}
              items.push({
                sessionId: item.sessionId,
                parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
                title: typeof values.title === 'string' ? values.title : undefined,
                cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
                updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
                tokens: sessionTokens,
                measurement: parts,
                live: item.running === true,
              })
            }
            reply(res, 200, {
              ok: true,
              scope: scopeOnly ? 'workspace' : 'all',
              cwd,
              workspaceScoped: scopeOnly && base !== undefined,
              totals: {
                sessions: items.length,
                live: items.filter((item) => item.live === true).length,
                tokens,
                tokensKnown: tokenKnown,
                detail,
              },
              items,
            })
          } catch (error) {
            probe('summary-failed', { message: String((error && error.message) || error) })
            reply(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ui-enhance: session summary route',
  )

  /**
   * One-click model switch: POST { scope, cwd, provider, model, reasoningEffort?, sessionIds? }
   * rewrites the next-request selection of every Session that the sidebar can see.
   *
   * The Session controller only offers a per-Session `selectModel`, so the fan-out lives
   * here rather than in the browser: one round trip, one consistent snapshot of the list,
   * and no N×HTTP from the renderer. Sessions are filtered exactly like the summary route
   * does — by Workspace directory, so archived and deleted rows (which `list` omits) and
   * Sessions from other Workspaces are never touched.
   */
  ctx.effect(
    () =>
      ctx.webServer.register({
        method: 'POST',
        path: MODEL_BULK_PATH,
        handler: async (req, res) => {
          try {
            const body = await readJsonBody(req, 64 * 1024)
            if (!body || typeof body !== 'object') {
              reply(res, 400, { ok: false, error: 'bad-body' })
              return
            }
            const provider = typeof body.provider === 'string' ? body.provider : ''
            const model = typeof body.model === 'string' ? body.model : ''
            if (provider === '' || model === '') {
              reply(res, 400, { ok: false, error: 'provider-and-model-required' })
              return
            }
            const effort = typeof body.reasoningEffort === 'string' && body.reasoningEffort ? body.reasoningEffort : undefined

            const controller = ctx.get('sessionController')
            if (!controller || typeof controller.list !== 'function' || typeof controller.selectModel !== 'function') {
              reply(res, 503, { ok: false, error: 'session-controller-unavailable' })
              return
            }

            const listed = await controller.list({})
            const all = listed && Array.isArray(listed.items) ? listed.items : []
            // Same Workspace predicate as the summary route: a Workspace is a directory,
            // so a Session belongs to it when its cwd sits at or under it.
            const normDir = (value) => String(value).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
            const scopeOnly = body.scope === 'workspace'
            const base = typeof body.cwd === 'string' && body.cwd.length > 0 ? normDir(body.cwd) : undefined
            const explicit = Array.isArray(body.sessionIds)
              ? new Set(body.sessionIds.filter((id) => typeof id === 'string'))
              : undefined

            const targets = []
            const skipped = { blank: 0, outOfScope: 0 }
            for (const item of all) {
              if (!item || typeof item.sessionId !== 'string') continue
              if (explicit !== undefined) {
                if (!explicit.has(item.sessionId)) continue
              } else if (scopeOnly && base !== undefined) {
                const at = typeof item.cwd === 'string' && item.cwd.length > 0 ? normDir(item.cwd) : ''
                if (!(at === base || at.startsWith(base + '/'))) {
                  skipped.outOfScope += 1
                  continue
                }
              }
              // A blank Session has no agent yet; selecting a model for it would be lost.
              if (item.blank === true) {
                skipped.blank += 1
                continue
              }
              targets.push(item.sessionId)
            }

            const result = { ok: true, scope: scopeOnly ? 'workspace' : 'all', cwd: body.cwd, total: targets.length, okCount: 0, failed: 0, details: [] }
            for (const sessionId of targets) {
              const request = { sessionId, provider, model }
              if (effort !== undefined) request.reasoningEffort = effort
              try {
                const settled = await controller.selectModel(request)
                if (settled && settled.ok === false) {
                  result.failed += 1
                  if (result.details.length < MODEL_BULK_REPORT_LIMIT) {
                    result.details.push({
                      sessionId,
                      error: String((settled.error && (settled.error.code || settled.error.message)) || 'failed'),
                    })
                  }
                } else {
                  result.okCount += 1
                }
              } catch (error) {
                result.failed += 1
                if (result.details.length < MODEL_BULK_REPORT_LIMIT) {
                  result.details.push({ sessionId, error: String((error && error.message) || error) })
                }
              }
            }
            result.skipped = skipped
            probe('model-bulk', { provider, model, effort, total: result.total, okCount: result.okCount, failed: result.failed })
            reply(res, 200, result)
          } catch (error) {
            probe('model-bulk-failed', { message: String((error && error.message) || error) })
            reply(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        },
      }),
    'ui-enhance: workspace model bulk switch route',
  )

}
