/**
 * Server-side ShaderToy fetch.
 *
 * ShaderToy sits behind a Cloudflare managed challenge that answers every plain HTTP
 * client with `403 Bad request`, an 11-byte body, and no on-screen control to solve. The
 * only client that gets through is a real browser: it runs the challenge script, earns a
 * `cf_clearance` cookie, and from then on the site answers normally.
 *
 * Everything below exists because of that one fact. Instead of asking for a pasted JSON,
 * this module drives the Chrome already installed on the machine over the DevTools
 * protocol:
 *
 *   1. launch Chrome on a throw-away profile with a loopback debugging port;
 *   2. navigate it to the work page, which is what solves the challenge (~20s);
 *   3. once the real page has replaced the interstitial, evaluate a request from inside
 *      that page, so it carries the clearance cookie:
 *        - `POST /shadertoy` with the work id returns the full definition (object or
 *          array, depending on endpoint), and
 *        - `GET /media/...` returns each channel texture as base64.
 *
 * The DevTools client is hand-rolled over a TCP socket: this Host has no `ws` package and
 * none may be installed on the user's machine.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHALLENGE_TITLE = /请稍候|Just a moment|Attention Required/i
/** The site's own "no such page" screen; a real answer, not a challenge. */
const ERROR_TITLE = /^错误\s*[-–]\s*Shadertoy$|^Error\s*[-–]\s*Shadertoy$|^页面不存在/i
const NAV_TIMEOUT_MS = 70000
const CDP_TIMEOUT_MS = 30000
/** How long a fetched definition is reused before the browser is asked again. */
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_LIMIT = 16
const TEXTURE_LIMIT = 6
const TEXTURE_MAX_BYTES = 12 * 1024 * 1024

const cache = new Map()

/** Chrome locations looked up in order; the first one that exists wins. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

function cacheGet(id) {
  const hit = cache.get(id)
  if (hit === undefined) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(id)
    return null
  }
  return hit.value
}

/** A payload is usable only if it carries at least one pass with code. */
function usablePayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const passes = Array.isArray(payload.renderpass) ? payload.renderpass : []
  return passes.some((pass) => pass && typeof pass.code === 'string' && pass.code !== '')
}

function cacheSet(id, value) {
  cache.set(id, { at: Date.now(), value })
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** One WebSocket text frame, client-masked as RFC 6455 requires. */
function encodeFrame(text) {
  const data = Buffer.from(text, 'utf8')
  const len = data.length
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 0x80 | 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x81
  const mask = randomBytes(4)
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}

/** Every complete frame in `buffer`, plus the bytes that do not form one yet. */
function decodeFrames(buffer) {
  const out = []
  let at = 0
  while (at + 2 <= buffer.length) {
    const b0 = buffer[at]
    const b1 = buffer[at + 1]
    const opcode = b0 & 0x0f
    let len = b1 & 0x7f
    let head = 2
    if (len === 126) {
      if (at + 4 > buffer.length) break
      len = buffer.readUInt16BE(at + 2)
      head = 4
    } else if (len === 127) {
      if (at + 10 > buffer.length) break
      len = Number(buffer.readBigUInt64BE(at + 2))
      head = 10
    }
    const masked = (b1 & 0x80) !== 0
    if (masked) {
      if (at + head + 4 > buffer.length) break
      head += 4
    }
    if (at + head + len > buffer.length) break
    const payload = buffer.subarray(at + head, at + head + len)
    at += head + len
    if (opcode === 0x8) {
      out.push({ close: true })
      break
    }
    if (opcode === 0x1 && payload.length > 0) out.push({ text: payload.toString('utf8') })
  }
  return { frames: out, rest: buffer.subarray(at) }
}

/** Open one DevTools socket and return a tiny request/notify wrapper. */
function openSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(wsUrl)
    const key = randomBytes(16).toString('base64')
    const socket = net.connect(Number(target.port), target.hostname, () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
          `Host: ${target.hostname}:${target.port}\r\n` +
          'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })

    let upgraded = false
    let pending = Buffer.alloc(0)
    let frames = Buffer.alloc(0)
    let nextId = 0
    const waiting = new Map()
    const listeners = []

    const api = {
      call(method, params) {
        const id = (nextId += 1)
        return new Promise((done, fail) => {
          waiting.set(id, { done, fail })
          socket.write(encodeFrame(JSON.stringify({ id, method, params: params || {} })))
          setTimeout(() => {
            if (!waiting.has(id)) return
            waiting.delete(id)
            fail(new Error('cdp timeout: ' + method))
          }, CDP_TIMEOUT_MS).unref?.()
        })
      },
      on(fn) {
        listeners.push(fn)
      },
      close() {
        try {
          socket.destroy()
        } catch (error) {
          /* already gone */
        }
      },
    }

    socket.on('data', (chunk) => {
      if (!upgraded) {
        pending = Buffer.concat([pending, chunk])
        const end = pending.indexOf('\r\n\r\n')
        if (end === -1) return
        const head = pending.subarray(0, end).toString('latin1')
        if (!/HTTP\/1\.1 101/.test(head)) {
          reject(new Error('devtools handshake refused'))
          socket.destroy()
          return
        }
        upgraded = true
        frames = pending.subarray(end + 4)
        resolve(api)
      } else {
        frames = Buffer.concat([frames, chunk])
      }
      const decoded = decodeFrames(frames)
      frames = decoded.rest
      for (const frame of decoded.frames) {
        if (frame.close) continue
        let message
        try {
          message = JSON.parse(frame.text)
        } catch (error) {
          continue
        }
        if (message.id !== undefined && waiting.has(message.id)) {
          const slot = waiting.get(message.id)
          waiting.delete(message.id)
          if (message.error) slot.fail(new Error(message.error.message || 'cdp error'))
          else slot.done(message.result)
          continue
        }
        for (const fn of listeners) {
          try {
            fn(message)
          } catch (error) {
            /* a bad listener must not kill the socket */
          }
        }
      }
    })

    socket.on('error', reject)
    socket.on('close', () => {
      for (const slot of waiting.values()) slot.fail(new Error('devtools closed'))
      waiting.clear()
    })
    setTimeout(() => reject(new Error('devtools connect timeout')), 20000).unref?.()
  })
}

async function getJson(port, path) {
  // A browser that is still starting refuses the connection outright, which is the
  // normal case on the first few polls rather than an error worth propagating.
  let response = null
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`)
  } catch (error) {
    return null
  }
  if (!response.ok) return null
  try {
    return await response.json()
  } catch (error) {
    return null
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * The one browser this module keeps alive.
 *
 * Restarting Chrome for every work looked simpler and was wrong twice over: on Windows a
 * killed Chrome leaves its process tree behind for several seconds, so the next launch
 * lost the race for the debugging port and failed in under a second; and every launch
 * carries a fresh profile, which means passing the Cloudflare challenge again, which the
 * site answers by raising the difficulty. One long-lived browser, cleared once and then
 * reused, fixes both and makes every later work nearly instant.
 */
let browser = null
/** Serialises callers: one page, one navigation, one request at a time. */
let queue = Promise.resolve()

function enqueue(task) {
  const run = queue.then(task, task)
  // The queue must survive a rejected task, or every later caller would inherit it.
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function launchBrowser(chromePath) {
  const port = 9400 + Math.floor(Math.random() * 400)
  const profile = joinTemp('dsh-shadertoy-' + Date.now())
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1000,760',
      // The window has to exist: a headless browser never gets past the challenge
      // (measured: it sits on the interstitial forever, while a real window clears it).
      // Placing it far off-screen keeps it out of the way without losing that ability.
      '--window-position=-32000,-32000',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  const launched = await new Promise((done) => {
    child.once('error', () => done(false))
    child.once('spawn', () => done(true))
  })
  if (!launched) return null

  let page = null
  for (let attempt = 0; attempt < 80 && page === null; attempt += 1) {
    await sleep(300)
    const list = await getJson(port, '/json/list')
    if (Array.isArray(list)) page = list.find((entry) => entry.type === 'page') || null
  }
  if (page === null) {
    killTree(child)
    return null
  }
  return { child, port, page, profile, cleared: false, socket: null }
}

/** Kill the whole Chrome tree; a bare kill leaves its renderer processes running. */
function killTree(child) {
  if (child === null) return
  try {
    if (process.platform === 'win32' && typeof child.pid === 'number') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      return
    }
    child.kill()
  } catch (error) {
    /* already gone */
  }
}

/** Shut the shared browser down after a failure, so the next caller starts clean. */
function discardBrowser() {
  if (browser === null) return
  if (browser.socket !== null) {
    try {
      browser.socket.close()
    } catch (error) {
      /* already closed */
    }
  }
  killTree(browser.child)
  removeDir(browser.profile)
  browser = null
}

/**
 * Open the page and wait until the challenge has been replaced by something the site
 * actually rendered. The interstitial is ~45 KB and the real work page ~475 KB, so size is
 * what separates them; the title then says which of the two real outcomes this is — the
 * work itself, or the site's "not found" screen for an id that does not exist.
 */
async function preparePage(state, id) {
  if (state.socket === null) {
    state.socket = await openSocket(state.page.webSocketDebuggerUrl)
    await state.socket.call('Page.enable')
    await state.socket.call('Runtime.enable')
  }
  const socket = state.socket
  await socket.call('Page.navigate', { url: `https://www.shadertoy.com/view/${id}` })

  const deadline = Date.now() + NAV_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(2000)
    let probe = null
    try {
      const reply = await socket.call('Runtime.evaluate', {
        expression:
          'JSON.stringify({t: document.title, n: document.documentElement ? document.documentElement.outerHTML.length : 0})',
        returnByValue: true,
      })
      probe = JSON.parse(reply.result.value)
    } catch (error) {
      // A navigation tears the execution context down; the poll simply retries.
      continue
    }
    if (probe === null) continue
    const title = String(probe.t)
    // Past the challenge the title is the work's name; the "not found" screen has its own.
    if (probe.n > 20000 && ERROR_TITLE.test(title)) return 'missing'
    if (probe.n > 200000 && !CHALLENGE_TITLE.test(title)) return 'ok'
  }
  return 'blocked'
}

/** Run one expression in the page and parse its JSON result, or null when it failed. */
async function evaluate(state, expression) {
  const result = await state.socket.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) return null
  try {
    return JSON.parse(result.result.value)
  } catch (error) {
    return null
  }
}

async function fetchOnce(state, id) {
  const pageState = await preparePage(state, id)
  if (pageState === 'missing') return { error: 'missing' }
  if (pageState !== 'ok') return { error: 'blocked' }

  // The definition: the player JSON endpoint, asked exactly the way the site's own
  // `loadShader()` asks it. The body must be form-encoded (`s=<json>&nt=1&nl=1&np=1`);
  // a plain JSON body is rejected with 413 and `{"id":"NOID","result":-20}`.
  const definition = await evaluate(
    state,
    `(async () => {
      try {
        const body = 's=' + encodeURIComponent(JSON.stringify({ shaders: [${JSON.stringify(id)}] })) + '&nt=1&nl=1&np=1';
        const r = await fetch('https://www.shadertoy.com/shadertoy', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (!r.ok) return JSON.stringify({ status: r.status });
        const text = await r.text();
        if (text.indexOf('renderpass') === -1) return JSON.stringify({ status: 0, body: text.slice(0, 120) });
        // The endpoint answers with an array of works, one per requested id; the work itself
        // is element 0. Handing the array on as if it were the work yields an object with no
        // info and no renderpass, which renders as an all-black background.
        const parsed = JSON.parse(text);
        const work = Array.isArray(parsed) ? parsed[0] : parsed;
        if (work === null || typeof work !== 'object') return JSON.stringify({ status: 0, body: text.slice(0, 120) });
        return JSON.stringify({ status: r.status, payload: work });
      } catch (e) {
        return JSON.stringify({ error: String(e) });
      }
    })()`,
  )

  if (definition === null) return { error: 'invalid' }
  if (definition.error !== undefined) return { error: 'offline' }
  if (definition.payload === undefined) {
    return { error: definition.status === 404 ? 'missing' : 'unreachable' }
  }
  // A payload the site returned but without any pass is not a usable work; reporting it as
  // `invalid` beats rendering black and calling it a success.
  if (!usablePayload(definition.payload)) return { error: 'invalid' }

  const textures = {}
  const paths = [...new Set(collectFilepaths(definition.payload))].slice(0, TEXTURE_LIMIT)
  for (const filepath of paths) {
    const url = 'https://www.shadertoy.com/' + String(filepath).replace(/^\/+/, '')
    const read = await evaluate(
      state,
      `(async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
          if (!r.ok) return JSON.stringify({ status: r.status });
          const b = new Uint8Array(await r.arrayBuffer());
          if (b.length > ${TEXTURE_MAX_BYTES}) return JSON.stringify({ status: 0, tooLarge: true });
          let s = '';
          const CH = 0x8000;
          for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH));
          return JSON.stringify({ status: r.status, len: b.length, b64: btoa(s) });
        } catch (e) {
          return JSON.stringify({ error: String(e) });
        }
      })()`,
    )
    if (read !== null && typeof read.b64 === 'string') {
      const mime = /\.png$/i.test(filepath) ? 'image/png' : /\.webp$/i.test(filepath) ? 'image/webp' : 'image/jpeg'
      textures[filepath] = `data:${mime};base64,${read.b64}`
    }
  }

  return { shader: definition.payload, textures }
}

/**
 * Fetch one work by driving a real browser.
 *
 * Returns `{ shader, textures }` where `shader` is the raw site payload and `textures` is
 * a `{ filepath: dataUrl }` map for every channel file that could be read. Errors carry an
 * `error` of 'noid' | 'nobrowser' | 'launch' | 'blocked' | 'offline' | 'missing' |
 * 'unreachable' | 'invalid'.
 */
export async function fetchShaderToyWork(rawId, options) {
  const id = String(rawId || '').trim()
  if (!/^[A-Za-z0-9]{4,64}$/.test(id)) return { error: 'noid' }
  const settings = options || {}

  if (!settings.force) {
    const hit = cacheGet(id)
    if (hit !== null) return { shader: hit.shader, textures: hit.textures, cached: true }
  }

  const chromePath = settings.chromePath || (await findChrome())
  if (chromePath === null) return { error: 'nobrowser' }

  return enqueue(async () => {
    // The browser is created once and kept; only a failed attempt throws it away, so a
    // lost debugging port or a half-navigated page cannot poison every later call.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (browser === null) {
        browser = await launchBrowser(chromePath)
        if (browser === null) return { error: 'launch' }
      }
      let result
      try {
        result = await fetchOnce(browser, id)
      } catch (error) {
        result = { error: 'unreachable' }
      }
      if (result.error === undefined) {
        // Never keep a payload that cannot render: a cached empty work would keep coming back
        // as a success and the background would stay black until the process restarted.
        if (usablePayload(result.shader)) cacheSet(id, result)
        return result
      }
      // 'blocked' and 'missing' are real answers about the work, not a broken browser.
      if (result.error === 'blocked' || result.error === 'missing' || result.error === 'invalid') {
        return result
      }
      discardBrowser()
    }
    return { error: 'unreachable' }
  })
}

/** Every `filepath` a payload mentions, in first-seen order. */
function collectFilepaths(payload) {
  const paths = []
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.filepath === 'string' && node.filepath.length > 0) paths.push(node.filepath)
    for (const key of Object.keys(node)) visit(node[key])
  }
  visit(payload)
  return paths
}

let chromeCache

export async function findChrome() {
  if (chromeCache !== undefined) return chromeCache
  for (const candidate of CHROME_CANDIDATES) {
    try {
      const stat = await statFile(candidate)
      if (stat) {
        chromeCache = candidate
        return candidate
      }
    } catch (error) {
      /* try the next one */
    }
  }
  chromeCache = null
  return null
}

async function statFile(target) {
  try {
    const stat = await fs.stat(target)
    return stat.isFile()
  } catch (error) {
    return false
  }
}

async function removeDir(target) {
  try {
    await fs.rm(target, { recursive: true, force: true })
  } catch (error) {
    /* a locked profile is harmless; the temp dir is reaped by the OS */
  }
}

function joinTemp(name) {
  return join(tmpdir(), name)
}
