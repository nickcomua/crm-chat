#!/usr/bin/env node
// Production-website QR login. Serves the website with integration/website_serve.py,
// approves the QR with a copy of a saved test-account session, and checks the
// chat list, a real last-message preview, opened history, a reload, and a
// redeploy from CRM_CHAT_WEBSITE_PREVIOUS onto CRM_CHAT_WEBSITE. Never prints
// secrets.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

// The wasm glue is `var createTdwebModule = factory`. Its parameter has the
// same name, so `createTdwebModule.ready.FS` is the caller's module object,
// not a property of the factory. Install this before the page loads the glue.
const captureTdlibFilesystem = () => {
  const keep = filesystem => {
    if (
      filesystem !== undefined &&
      filesystem !== null &&
      typeof filesystem.lookupPath === 'function' &&
      typeof filesystem.readdir === 'function'
    ) {
      Reflect.set(globalThis, '__crmChatFs', filesystem)
    }
  }
  const wrap = factory => {
    if (typeof factory !== 'function' || factory.__crmWrapped === true) {
      return factory
    }
    const wrapped = function (config) {
      const result = factory.call(this, config)
      const ready = config === undefined || config === null ? undefined : config.ready
      if (ready !== undefined && ready !== null) {
        keep(ready.FS)
      }
      const remember = value => {
        if (value === undefined || value === null) {
          return
        }
        keep(value.FS)
      }
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then(remember, () => undefined)
      } else {
        remember(result)
      }
      return result
    }
    wrapped.__crmWrapped = true
    return wrapped
  }
  let current
  Object.defineProperty(globalThis, 'createTdwebModule', {
    configurable: true,
    enumerable: true,
    get() {
      return current
    },
    set(value) {
      current = wrap(value)
    },
  })
}

// Runs inside the page. Copies MEMFS without opening the database, then stores
// that copy as the snapshot the new bundle restores. An idle copy can be a
// short database that still looks stable, and the next process abort()s on it.
// Keep the copy when it has stopped changing and the last WAL commit covers
// the whole database file. A short file opens as a new login or abort()s.
const plantLiveSnapshot = async () => {
  const hooked = Reflect.get(globalThis, '__crmChatFs')
  const factory = Reflect.get(globalThis, 'createTdwebModule')
  const fromFactory =
    typeof factory === 'function' ? Reflect.get(factory.ready ?? {}, 'FS') : undefined
  const fs = hooked ?? fromFactory
  if (
    fs === undefined ||
    typeof fs.readdir !== 'function' ||
    typeof fs.lookupPath !== 'function'
  ) {
    return {
      ok: false,
      reason: typeof factory === 'function' ? 'no filesystem' : 'no factory',
      files: 0,
      detail: '',
    }
  }
  const collect = () => {
  const files = []
  const visit = (path, depth) => {
    if (depth > 6) {
      return
    }
    let names = []
    try {
      names = fs.readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..' || String(name).endsWith('-shm')) {
        continue
      }
      const child = `${path}/${name}`
      let node
      try {
        node = fs.lookupPath(child).node
      } catch {
        continue
      }
      if (node === undefined || node === null) {
        continue
      }
      const mode = typeof node.mode === 'number' ? node.mode : 33188
      if ((mode & 61440) === 16384) {
        visit(child, depth + 1)
        continue
      }
      const contents = node.contents
      let copy
      if (contents instanceof Uint8Array) {
        const used = typeof node.usedBytes === 'number' ? node.usedBytes : contents.length
        copy = new Uint8Array(used)
        copy.set(contents.subarray(0, Math.min(used, contents.length)))
      } else if (
        contents !== undefined &&
        contents !== null &&
        typeof contents !== 'string' &&
        typeof contents.length === 'number'
      ) {
        const raw = new Uint8Array(contents)
        const used = typeof node.usedBytes === 'number' ? node.usedBytes : raw.length
        const view = raw.subarray(0, Math.min(used, raw.length))
        copy = new Uint8Array(view.length)
        copy.set(view)
      } else {
        continue
      }
      files.push({
        path: child,
        bytes: copy,
        mode,
        mtime: typeof node.timestamp === 'number' ? node.timestamp : 0,
      })
    }
  }
  visit('/tdlib', 0)
  return files
  }
  const detailOf = list => {
    const dirs = new Set(
      list.map(file => file.path.slice(0, file.path.lastIndexOf('/'))),
    )
    const names = list.map(
      file => `${file.path.split('/').pop()}:${file.bytes.length}`,
    )
    return `dirs=${dirs.size} ${names.join(',')}`
  }
  const sqliteBytes = list =>
    list.reduce(
      (total, file) =>
        file.path.endsWith('.sqlite') && !file.path.endsWith('.sqlite-wal')
          ? total + file.bytes.length
          : total,
      0,
    )
  const digestOf = list => {
    let hash = 2166136261
    const ordered = [...list].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    for (const file of ordered) {
      hash = Math.imul(hash ^ file.bytes.length, 16777619)
      for (let index = 0; index < file.bytes.length; index += 1) {
        hash = Math.imul(hash ^ (file.bytes[index] ?? 0), 16777619)
      }
    }
    return hash >>> 0
  }
  // The chat list can be on screen while MEMFS still holds the pre-authorization
  // database. A short salt-matched WAL prefix is that image: checksum-valid,
  // then the next process opens it as WaitPhoneNumber. Keep waiting for a
  // longer prefix. 64 sits between the prefix that came back as a new login
  // and the ones that restored the chat list.
  function saltPrefixShort(list) {
    const minFrames = 64
    const readBe = (bytes, offset) => {
      if (bytes.length < offset + 4) {
        return 0
      }
      return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
    }
    const databases = list.filter(
      file => file.path.endsWith('.sqlite') && !file.path.endsWith('.sqlite-wal'),
    )
    const paths = new Map(list.map(file => [file.path, file.bytes]))
    for (const file of databases) {
      let magic = ''
      for (let index = 0; index < 16 && index < file.bytes.length; index += 1) {
        magic += String.fromCharCode(file.bytes[index] ?? 0)
      }
      if (magic === 'SQLite format 3\u0000') {
        continue
      }
      const wal = paths.get(`${file.path}-wal`)
      if (wal === undefined || wal.length < 32) {
        continue
      }
      if (
        wal[0] !== 0x37 ||
        wal[1] !== 0x7f ||
        wal[2] !== 0x06 ||
        (wal[3] !== 0x82 && wal[3] !== 0x83)
      ) {
        continue
      }
      const littleWords = wal[3] === 0x82
      const page = readBe(wal, 8)
      if (page < 512 || page > 65536 || (page & (page - 1)) !== 0) {
        continue
      }
      const checksum = (offset, length, s0, s1) => {
        let first = s0
        let second = s1
        const view = new DataView(wal.buffer, wal.byteOffset + offset, length)
        for (let index = 0; index < length; index += 8) {
          const left = view.getUint32(index, littleWords)
          const right = view.getUint32(index + 4, littleWords)
          first = (first + left + second) >>> 0
          second = (second + right + first) >>> 0
        }
        return [first, second]
      }
      const header = checksum(0, 24, 0, 0)
      if (header[0] !== readBe(wal, 24) || header[1] !== readBe(wal, 28)) {
        continue
      }
      const salt1 = readBe(wal, 16)
      const salt2 = readBe(wal, 20)
      let sum0 = header[0]
      let sum1 = header[1]
      let frames = 0
      let stop = 'end'
      const frame = 24 + page
      for (let offset = 32; offset + frame <= wal.length; offset += frame) {
        if (readBe(wal, offset + 8) !== salt1 || readBe(wal, offset + 12) !== salt2) {
          stop = 'salt'
          break
        }
        const covered = checksum(offset, 8, sum0, sum1)
        const pageSum = checksum(offset + 24, page, covered[0], covered[1])
        if (
          pageSum[0] !== readBe(wal, offset + 16) ||
          pageSum[1] !== readBe(wal, offset + 20)
        ) {
          stop = 'checksum'
          break
        }
        sum0 = pageSum[0]
        sum1 = pageSum[1]
        frames += 1
      }
      if (stop === 'salt' && frames < minFrames) {
        return true
      }
    }
    return false
  }
  let files = collect()
  const firstSize = sqliteBytes(files)
  let digest = digestOf(files)
  let stableSince = Date.now()
  const started = Date.now()
  const stableNeed = 1_500
  const minHold = 3_000
  // The first stable copy can still be the pre-authorization database. Keep
  // the newest copy that stays still, and do not stop the window early.
  let accepted
  while (Date.now() - started < 15_000) {
    await new Promise(resolve => {
      setTimeout(resolve, 400)
    })
    const again = collect()
    const nextDigest = digestOf(again)
    if (nextDigest !== digest) {
      files = again
      digest = nextDigest
      stableSince = Date.now()
      continue
    }
    if (
      Date.now() - started >= minHold &&
      Date.now() - stableSince >= stableNeed &&
      !saltPrefixShort(files)
    ) {
      accepted = files
    }
  }
  if (accepted !== undefined) {
    files = accepted
  } else if (
    Date.now() - stableSince < stableNeed ||
    Date.now() - started < minHold
  ) {
    return {
      ok: false,
      reason: 'short',
      files: files.length,
      detail: `${detailOf(files)} from=${firstSize}`,
    }
  }
  const databases = files.filter(
    file => file.path.endsWith('.sqlite') && !file.path.endsWith('.sqlite-wal'),
  )
  if (databases.length === 0) {
    return { ok: false, reason: 'no database', files: files.length, detail: detailOf(files) }
  }
  const readU32 = (bytes, offset, little) => {
    if (bytes.length < offset + 4) {
      return 0
    }
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, little)
  }
  const pageOf = bytes => {
    if (bytes.length < 100) {
      return undefined
    }
    let magic = ''
    for (let index = 0; index < 16; index += 1) {
      magic += String.fromCharCode(bytes[index] ?? 0)
    }
    if (magic !== 'SQLite format 3\u0000') {
      return undefined
    }
    const raw = ((bytes[16] ?? 0) << 8) | (bytes[17] ?? 0)
    const page = raw === 1 ? 65536 : raw
    if (page < 512 || page > 65536 || (page & (page - 1)) !== 0 || bytes.length % page !== 0) {
      return undefined
    }
    return page
  }
  const walLittle = bytes => {
    if (bytes.length < 32) {
      return undefined
    }
    if (
      bytes[0] === 0x37 &&
      bytes[1] === 0x7f &&
      bytes[2] === 0x06 &&
      (bytes[3] === 0x82 || bytes[3] === 0x83)
    ) {
      return false
    }
    if (
      (bytes[0] === 0x82 || bytes[0] === 0x83) &&
      bytes[1] === 0x06 &&
      bytes[2] === 0x7f &&
      bytes[3] === 0x37
    ) {
      return true
    }
    return undefined
  }
  const walOk = (wal, page) => {
    if (wal.length === 0) {
      return true
    }
    const little = walLittle(wal)
    if (little === undefined || readU32(wal, 8, little) !== page) {
      return false
    }
    const body = wal.length - 32
    return body >= 0 && body % (24 + page) === 0
  }
  // Header fields are big-endian. Magic 0x377f0682 checksums little-endian
  // words, and 0x377f0683 checksums big-endian words. The last commit's page
  // count has to match the database file or the next process cannot replay it.
  const walCommitPages = (wal, page) => {
    if (wal.length < 32 || wal[0] !== 0x37 || wal[1] !== 0x7f || wal[2] !== 0x06) {
      return undefined
    }
    const littleWords = wal[3] === 0x82
    if (wal[3] !== 0x82 && wal[3] !== 0x83) {
      return undefined
    }
    const readBe = offset => readU32(wal, offset, false)
    const checksum = (offset, length, s0, s1) => {
      let first = s0
      let second = s1
      const view = new DataView(wal.buffer, wal.byteOffset + offset, length)
      for (let index = 0; index < length; index += 8) {
        const left = view.getUint32(index, littleWords)
        const right = view.getUint32(index + 4, littleWords)
        first = (first + left + second) >>> 0
        second = (second + right + first) >>> 0
      }
      return [first, second]
    }
    const header = checksum(0, 24, 0, 0)
    if (header[0] !== readBe(24) || header[1] !== readBe(28)) {
      return undefined
    }
    const salt1 = readBe(16)
    const salt2 = readBe(20)
    let sum0 = header[0]
    let sum1 = header[1]
    let commit = 0
    let frames = 0
    let stop = 'end'
    const frame = 24 + page
    for (let offset = 32; offset + frame <= wal.length; offset += frame) {
      if (readBe(offset + 8) !== salt1 || readBe(offset + 12) !== salt2) {
        stop = 'salt'
        break
      }
      const covered = checksum(offset, 8, sum0, sum1)
      const pageSum = checksum(offset + 24, page, covered[0], covered[1])
      if (pageSum[0] !== readBe(offset + 16) || pageSum[1] !== readBe(offset + 20)) {
        stop = 'checksum'
        break
      }
      sum0 = pageSum[0]
      sum1 = pageSum[1]
      frames += 1
      const pages = readBe(offset + 4)
      if (pages > 0) {
        commit = pages
      }
    }
    if (commit <= 0) {
      return undefined
    }
    return { commit, stop, frames }
  }
  const byPath = new Map(files.map(file => [file.path, file.bytes]))
  let walkNote = ''
  for (const file of databases) {
    if (
      !file.path.startsWith('/tdlib/') ||
      file.path.split('/').some(part => part === '.' || part === '..')
    ) {
      return { ok: false, reason: 'path', files: files.length, detail: detailOf(files) }
    }
    const wal = byPath.get(`${file.path}-wal`)
    const page = pageOf(file.bytes)
    if (page !== undefined) {
      if (file.bytes[18] === 2 && (wal === undefined || wal.length === 0)) {
        return { ok: false, reason: 'wal missing', files: files.length, detail: detailOf(files) }
      }
      if (wal !== undefined && !walOk(wal, page)) {
        return { ok: false, reason: 'wal', files: files.length, detail: detailOf(files) }
      }
      if (wal !== undefined && wal.length > 0 && file.bytes[18] !== 2) {
        return {
          ok: false,
          reason: 'wal without wal mode',
          files: files.length,
          detail: detailOf(files),
        }
      }
      const walked = wal === undefined || wal.length === 0 ? undefined : walCommitPages(wal, page)
      const commit = walked === undefined ? undefined : walked.commit
      if (commit === undefined || commit * page !== file.bytes.length) {
        return {
          ok: false,
          reason: 'wal commit',
          files: files.length,
          detail: `${detailOf(files)} commit=${commit ?? 0} stop=${walked === undefined ? 'none' : walked.stop} from=${firstSize}`,
        }
      }
      continue
    }
    if (wal !== undefined && wal.length > 0) {
      const little = walLittle(wal)
      const walPage = little === undefined ? 0 : readU32(wal, 8, little)
      const power = walPage >= 512 && walPage <= 65536 && (walPage & (walPage - 1)) === 0
      if (
        little === undefined ||
        !power ||
        file.bytes.length % walPage !== 0 ||
        !walOk(wal, walPage)
      ) {
        return { ok: false, reason: 'wal', files: files.length, detail: detailOf(files) }
      }
      const walked = walCommitPages(wal, walPage)
      const commit = walked === undefined ? undefined : walked.commit
      if (commit === undefined || commit * walPage < file.bytes.length) {
        return {
          ok: false,
          reason: 'wal commit',
          files: files.length,
          detail: `${detailOf(files)} commit=${commit ?? 0} stop=${walked === undefined ? 'none' : walked.stop} frames=${walked === undefined ? 0 : walked.frames}`,
        }
      }
      if (walked.stop === 'salt' && walked.frames < 64) {
        return {
          ok: false,
          reason: 'wal partial',
          files: files.length,
          detail: `${detailOf(files)} commit=${commit} stop=${walked.stop} frames=${walked.frames} pages=${file.bytes.length / walPage}`,
        }
      }
      walkNote = `${walkNote} commit=${commit} stop=${walked.stop} frames=${walked.frames} pages=${file.bytes.length / walPage}`
      continue
    }
    if (!(file.bytes.length >= 512 && file.bytes.length % 512 === 0)) {
      return { ok: false, reason: 'sqlite header', files: files.length, detail: detailOf(files) }
    }
  }
  const detail = `${detailOf(files)}${walkNote}`
  return new Promise(resolve => {
    const request = indexedDB.open('crm-chat-tdlib', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('records')) {
        request.result.createObjectStore('records')
      }
    }
    request.onerror = () => {
      resolve({ ok: false, reason: 'unreadable', files: files.length, detail })
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('records', 'readwrite')
      const store = tx.objectStore('records')
      store.put({ id: 's1', closed: true, files }, 'snap:s1')
      store.put({ current: 's1', serial: 1 }, 'pointer')
      tx.oncomplete = () => {
        db.close()
        resolve({
          ok: true,
          reason: '',
          files: files.length,
          detail,
          stable: true,
        })
      }
      tx.onerror = () => {
        db.close()
        resolve({ ok: false, reason: 'unreadable', files: files.length, detail })
      }
      tx.onabort = () => {
        db.close()
        resolve({ ok: false, reason: 'unreadable', files: files.length, detail })
      }
    }
  })
}

const root = process.env.CRM_CHAT_WEBSITE
const previous = process.env.CRM_CHAT_WEBSITE_PREVIOUS
const python = process.env.CRM_CHAT_PYTHON ?? 'python3'
const serveScript =
  process.env.CRM_CHAT_WEBSITE_SERVE ??
  fileURLToPath(new URL('./website_serve.py', import.meta.url))
const playwrightCore = process.env.PLAYWRIGHT_CORE
const chromium = process.env.CHROMIUM
const shots =
  process.env.CRM_CHAT_WEB_SHOTS ??
  join(process.env.HOME ?? tmpdir(), '.local/state/kam-t3/shots/fix-web-connect')
const tdqr =
  process.env.CRM_CHAT_TDQR ??
  join(process.env.HOME ?? '', '.local/state/kam-t3/tools/tdqr.py')
const slot = process.env.CRM_CHAT_TDQR_SLOT ?? '1'
// QR approval can take longer than 5s before TDLib reports Ready. The
// measured approve_to_chats_ms is still recorded.
const listBudgetMs = 15_000
const historyBudgetMs = 10_000
const reloadBudgetMs = 15_000
const kindPreview = new Set(['personal chat', 'group', 'channel'])

const redact = text =>
  String(text)
    .replace(/tg:\/\/\S+/gi, 'tg://[redacted]')
    .replace(/token=[^\s&'"]+/gi, 'token=[redacted]')
    .replace(/\b[a-f0-9]{32}\b/gi, '[redacted]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '[redacted-id]',
    )

const logLines = []
const note = line => {
  const safe = redact(line)
  logLines.push(safe)
  console.log(safe)
}

const fail = message => {
  note(`FAIL ${message}`)
  return new Error(message)
}

const bundleName = html => {
  const match = String(html).match(/assets\/index-[^"' ]+\.js/)
  return match === null ? '' : match[0].split('/').pop()
}

if (!root || !existsSync(join(root, 'index.html'))) {
  console.error('integration-test-web: CRM_CHAT_WEBSITE is not a website build')
  process.exit(1)
}
if (!previous || !existsSync(join(previous, 'index.html'))) {
  console.error(
    'integration-test-web: CRM_CHAT_WEBSITE_PREVIOUS is not a website build',
  )
  process.exit(1)
}
if (!existsSync(serveScript)) {
  console.error('integration-test-web: website server is missing')
  process.exit(1)
}
if (!playwrightCore || !chromium || !existsSync(chromium)) {
  console.error('integration-test-web: PLAYWRIGHT_CORE or CHROMIUM is missing')
  process.exit(1)
}
if (!existsSync(tdqr)) {
  console.error('integration-test-web: saved-session helper is missing')
  process.exit(1)
}

const apiId = process.env.TG_ID ?? ''
const apiHash = process.env.TG_HASH ?? ''
if (!/^[1-9]\d*$/.test(apiId) || !/^[a-fA-F\d]{32}$/.test(apiHash)) {
  console.error('integration-test-web: app scope did not provide TG_ID and TG_HASH')
  process.exit(1)
}

const newBundle = bundleName(await readFile(join(root, 'index.html'), 'utf8'))
const previousBundle = bundleName(
  await readFile(join(previous, 'index.html'), 'utf8'),
)
if (newBundle === '' || previousBundle === '' || newBundle === previousBundle) {
  console.error(
    'integration-test-web: previous and new website bundles are not distinct',
  )
  process.exit(1)
}

await mkdir(shots, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'crm-web-login-'))
const profile = join(work, 'profile')
const redeployProfile = join(work, 'redeploy-profile')
const serveLink = join(work, 'site')
await symlink(previous, serveLink)
const server = spawn(python, [serveScript, serveLink, '0'], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'inherit'],
})
const pageUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const onExit = code => reject(new Error(`website server exited ${code}`))
  server.once('exit', onExit)
  server.once('error', reject)
  server.stdout.on('data', chunk => {
    buffer += String(chunk)
    const line = buffer.split('\n')[0]
    if (!buffer.includes('\n') || !line.startsWith('serving website on ')) {
      return
    }
    server.off('exit', onExit)
    resolve(line.slice('serving website on '.length).trim())
  })
})
note(`serving website on ${pageUrl}`)
const timingPath = join(shots, 'timing.log')
let started = Date.now()
const browserName = process.env.CRM_CHAT_CHROMIUM_NAME ?? 'chromium'
const timing = {
  browser: browserName,
  qr_visible_ms: '',
  approve_to_chats_ms: '',
  history_ms: '',
  reload_ms: '',
  reopen_ms: '',
  previous_signed_in_ms: '',
  redeploy_ms: '',
  auth: [],
}

const writeTiming = async () => {
  const body = [
    `browser=${timing.browser}`,
    `qr_visible_ms=${timing.qr_visible_ms}`,
    `approve_to_chats_ms=${timing.approve_to_chats_ms}`,
    `history_ms=${timing.history_ms}`,
    `reload_ms=${timing.reload_ms}`,
    `reopen_ms=${timing.reopen_ms}`,
    `previous_signed_in_ms=${timing.previous_signed_in_ms}`,
    `redeploy_ms=${timing.redeploy_ms}`,
    ...timing.auth.map(line => `auth ${line}`),
    ...logLines.map(line => `# ${line}`),
    '',
  ].join('\n')
  await writeFile(timingPath, body, { mode: 0o600 })
}

let browser
let failed = false
const faults = []
const runtimeFault = text =>
  /Aborted\(|RuntimeError|out of bounds|table index/i.test(text)
const watch = page => {
  page.on('console', message => {
    const text = message.text()
    if (
      text.startsWith('tdlib auth authorizationState') ||
      text.startsWith('tdlib snapshot') ||
      text.startsWith('tdlib reopen') ||
      text.startsWith('tdlib close stopped') ||
      text === 'tdlib sync saved'
    ) {
      timing.auth.push(redact(text))
      note(text)
    }
    if (/Check `|FATAL|\.cpp\b/.test(text)) {
      note(`tdlib ${redact(text).slice(0, 300)}`)
    }
    if (text.startsWith('tdlib receive failed')) {
      const line = redact(text).slice(0, 1200)
      faults.push(line)
      note(line)
      return
    }
    if (!runtimeFault(text)) {
      return
    }
    const line = redact(text).slice(0, 400)
    faults.push(line)
    note(`console ${message.type()} ${line}`)
  })
  page.on('pageerror', error => {
    const name = typeof error.name === 'string' ? error.name : ''
    const message = typeof error.message === 'string' ? error.message : ''
    const stack = typeof error.stack === 'string' ? error.stack : ''
    const line = redact(
      [name, message, stack].filter(part => part !== '').join(' | ') ||
        '(empty)',
    ).slice(0, 500)
    faults.push(line)
    note(`pageerror ${line}`)
  })
  page.on('crash', () => {
    faults.push('page crashed')
    note('page crashed')
  })
}
const assertNoFaults = () => {
  if (faults.length > 0) {
    throw fail(`page error: ${faults[0]}`)
  }
}
const savedCount = () =>
  timing.auth.filter(line => line === 'tdlib sync saved').length
const waitForSyncSaved = async (page, label, before = savedCount()) => {
  const deadline = Date.now() + reloadBudgetMs
  while (savedCount() <= before && Date.now() < deadline) {
    await delay(100)
  }
  if (savedCount() <= before) {
    throw fail(`${label} did not log tdlib sync saved`)
  }
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset.tdlibSync !== '1',
      undefined,
      { timeout: reloadBudgetMs },
    )
  } catch {
    throw fail(`${label} save was still running`)
  }
  note(`${label} flushed (tdlib sync saved)`)
}
const sealPage = async page => {
  await page.evaluate(async () => {
    const seal = Reflect.get(globalThis, 'crmChatSeal')
    if (typeof seal !== 'function') {
      throw new Error('crmChatSeal is missing')
    }
    await seal()
  })
}
const visiblePreview = async nextPage => {
  const loading = nextPage.getByText('Loading chats…')
  if (
    (await loading.count()) > 0 &&
    (await loading.first().isVisible().catch(() => false))
  ) {
    return ''
  }
  const previews = await nextPage
    .locator('.chat-row .chat-row-meta.truncate')
    .allTextContents()
  return (
    previews
      .map(text => text.trim())
      .find(text => text !== '' && !kindPreview.has(text)) ?? ''
  )
}
const shot = async (page, name) => {
  if (page === undefined) {
    return
  }
  await page.screenshot({ path: join(shots, name), fullPage: true }).catch(() => undefined)
}

const GROUP_TITLE = 'crm-chat test group'
const CHANNEL_TITLE = 'crm-chat test channel'

const exactTitle = title =>
  new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)

const titledRows = (page, title) =>
  page.locator('.chat-row').filter({
    has: page.locator('div.font-medium', { hasText: exactTitle(title) }),
  })

const signalRoom = async room => {
  const bin = process.env.CRM_CHAT_INTEGRATION_BIN
  if (bin === undefined || bin === '' || !existsSync(bin)) {
    throw fail('integration binary is missing')
  }
  const errPath = `/tmp/kam-44-signal-${process.env.CRM_CHAT_CHROMIUM_NAME ?? 'web'}-${room}.err`
  const child = spawn(bin, ['signal', room], {
    stdio: ['ignore', 'pipe', openSync(errPath, 'w')],
    env: process.env,
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(fail(`signal ${room}: timed out`))
    }, 120_000)
    child.on('error', () => {
      clearTimeout(timer)
      reject(fail(`signal ${room}: could not start`))
    })
    child.on('close', status => {
      clearTimeout(timer)
      resolve(status)
    })
  })
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const needs = lines.find(line => line.startsWith('NEEDS TEST ACCOUNTS:'))
  if (needs !== undefined) {
    throw fail(needs)
  }
  if (code !== 0 || !lines.includes(`signal ${room}: sent`)) {
    const errText = existsSync(errPath) ? readFileSync(errPath, 'utf8') : ''
    const reason = errText
      .split('\n')
      .map(line => line.trim())
      .find(line => /^desktop tdlib: [A-Za-z][A-Za-z _:()-]{0,180}$/.test(line))
    throw fail(reason ?? `signal ${room}: did not send`)
  }
}

const waitForTitled = async (page, title) => {
  const listedUntil = Date.now() + 30_000
  while (Date.now() < listedUntil && (await titledRows(page, title).count()) < 1) {
    await delay(250)
  }
  return titledRows(page, title).count()
}

const openRoom = async (page, title, room, shotName) => {
  const listed = await waitForTitled(page, title)
  if (listed !== 1) {
    throw fail(listed === 0 ? `${room} was not listed` : `${room} was duplicated`)
  }
  await titledRows(page, title).first().click()
  const header = page
    .locator('header')
    .locator('div.font-semibold', { hasText: exactTitle(title) })
  try {
    await header.waitFor({ state: 'visible', timeout: historyBudgetMs })
  } catch {
    throw fail(`${room} did not open`)
  }
  const thread = page.locator('[aria-label="Open chat"]')
  const bubble = thread.locator('.tg-bubble').first()
  try {
    await bubble.waitFor({ state: 'visible', timeout: historyBudgetMs })
  } catch {
    throw fail(`${room} history did not render`)
  }
  if (room === 'channel') {
    if ((await thread.getByText('Replies are off').count()) < 1) {
      throw fail('channel is listed as a group')
    }
  }
  const incoming = thread.locator('.tg-bubble-in')
  const before = await incoming.count()
  await signalRoom(room)
  const liveUntil = Date.now() + 90_000
  while (Date.now() < liveUntil && (await incoming.count()) <= before) {
    await delay(250)
  }
  if ((await incoming.count()) <= before) {
    throw fail(`${room} live message did not appear`)
  }
  await shot(page, shotName)
  note(`${room} history and live update passed`)
}

const selectFolder = async (page, name) => {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    if ((await tab.getAttribute('aria-selected')) === 'true') {
      return
    }
    await delay(50)
  }
  throw fail(`${name} folder did not open`)
}

const proveRooms = async page => {
  await selectFolder(page, 'Groups')
  const groups = await waitForTitled(page, GROUP_TITLE)
  if (groups !== 1) {
    throw fail(groups === 0 ? 'group was not listed' : 'group was duplicated')
  }
  if ((await titledRows(page, CHANNEL_TITLE).count()) !== 0) {
    throw fail('channel is listed as a group')
  }
  await openRoom(page, GROUP_TITLE, 'group', '07-group.png')
  await selectFolder(page, 'Channels')
  const channels = await waitForTitled(page, CHANNEL_TITLE)
  if (channels !== 1) {
    throw fail(channels === 0 ? 'channel was not listed' : 'channel was duplicated')
  }
  if ((await titledRows(page, GROUP_TITLE).count()) !== 0) {
    throw fail('group is listed as a channel')
  }
  await openRoom(page, CHANNEL_TITLE, 'channel', '08-channel.png')
  await proveSponsored(page)
}

const proveSponsored = async page => {
  // The Web K open-chat reference is a bot dialog: a private chat with an
  // audience count, a composer, and the sponsored card under the header.
  // It is not in the Channels folder. The private test rooms are skipped.
  await selectFolder(page, 'All')
  const rows = page.locator('.chat-row')
  const count = await rows.count()
  let opened = 0
  for (let index = 0; index < count && opened < 8; index += 1) {
    const row = rows.nth(index)
    const title = (
      (await row.locator('div.font-medium').first().textContent()) ?? ''
    ).trim()
    if (title === CHANNEL_TITLE || title === GROUP_TITLE || title === '') {
      continue
    }
    await row.click()
    opened += 1
    const card = page.locator('[aria-label="Open chat"] .tg-sponsored')
    const visible = await card
      .first()
      .waitFor({ state: 'visible', timeout: 12_000 })
      .then(() => true)
      .catch(() => false)
    if (!visible) {
      continue
    }
    const placed = await page.evaluate(() => {
      const root = document.querySelector('[aria-label="Open chat"]')
      const header = root?.querySelector('header')
      const sponsored = root?.querySelector('.tg-sponsored')
      if (header === null || header === undefined || sponsored === null || sponsored === undefined) {
        return false
      }
      const headerBox = header.getBoundingClientRect()
      const cardBox = sponsored.getBoundingClientRect()
      const underHeader =
        cardBox.top >= headerBox.bottom - 4 &&
        cardBox.top <= headerBox.bottom + 80
      const bubbles = [...root.querySelectorAll('.tg-bubble')]
      const historyAbove = bubbles.some(bubble => {
        const box = bubble.getBoundingClientRect()
        const onScreen = box.bottom > headerBox.bottom && box.top < window.innerHeight
        return onScreen && box.top + 4 < cardBox.top
      })
      const text = [...sponsored.querySelectorAll('.tg-sponsored-text')].some(node =>
        ['Photo', 'Video', 'GIF'].includes((node.textContent ?? '').trim()),
      )
      const fakeButton = sponsored.querySelector('span.tg-sponsored-button') !== null
      return underHeader && !historyAbove && !text && !fakeButton
    })
    if (!placed) {
      throw fail('sponsored card is not under the header')
    }
    await shot(page, '09-sponsored.png')
    note('sponsored card is under the header')
    return
  }
  throw fail('sponsored card was not on screen')
}
const stillLoggedIn = async (nextPage, label, shotName, fatal = true) => {
  const deadline = Date.now() + reloadBudgetMs
  let preview = ''
  let qrVisible = false
  while (Date.now() < deadline) {
    assertNoFaults()
    const shell = nextPage.locator('[aria-label="Telegram chats"]')
    const rows = await nextPage.locator('.chat-row').count()
    const code = nextPage.locator('img[alt="Telegram login QR code"]')
    qrVisible =
      (await code.count()) > 0 &&
      (await code.first().isVisible().catch(() => false))
    if ((await shell.count()) > 0 && rows > 0 && !qrVisible) {
      preview = await visiblePreview(nextPage)
      if (preview !== '') {
        break
      }
    }
    await delay(100)
  }
  assertNoFaults()
  if (preview === '') {
    await shot(nextPage, shotName)
    const message = qrVisible
      ? `${label} returned to the QR screen`
      : `${label} did not keep a last-message preview within ${reloadBudgetMs}ms`
    if (!fatal) {
      throw new Error(message)
    }
    throw fail(message)
  }
  note(`${label} preview_chars=${preview.length}`)
}
const scriptNames = async page => {
  const srcs = await page.evaluate(() =>
    [...document.scripts].map(script => script.src),
  )
  return srcs.map(src => src.split('/').pop() ?? '')
}

try {
  const { chromium: playwright } = await import(playwrightCore)
  const launch = profileDir =>
    playwright.launchPersistentContext(profileDir, {
      executablePath: chromium,
      headless: process.env.CRM_CHAT_WEB_HEADED !== '1',
      viewport: { width: 1440, height: 900 },
      args: ['--disable-dev-shm-usage'],
    })
  const retarget = async next => {
    await unlink(serveLink)
    await symlink(next, serveLink)
  }
  const chatsVisible = async page => {
    const code = page.locator('img[alt="Telegram login QR code"]')
    const qrStill =
      (await code.count()) > 0 &&
      (await code.first().isVisible().catch(() => false))
    if (qrStill) {
      return false
    }
    const heading = page.getByRole('heading', { name: 'Telegram chats' })
    const shell = page.locator('[aria-label="Telegram chats"]')
    const headingVisible =
      (await heading.count()) > 0 &&
      (await heading.first().isVisible().catch(() => false))
    const shellVisible =
      (await shell.count()) > 0 &&
      (await shell.first().isVisible().catch(() => false))
    return headingVisible || shellVisible
  }
  const approveQr = async (
    page,
    shotName,
    recordQr,
    qrBudgetMs = 30_000,
    allowSignedIn = false,
  ) => {
    const qr = page.locator('img[alt="Telegram login QR code"]')
    // The PR base says "Log in with QR". The current site says "Log in by QR code".
    const qrButton = page.getByRole('button', { name: /log in (by|with) qr/i })
    const qrDeadline = Date.now() + qrBudgetMs
    let qrVisible = false
    while (Date.now() < qrDeadline) {
      if (allowSignedIn && (await chatsVisible(page))) {
        note('previous build opened the saved chat list')
        return Date.now()
      }
      if (!allowSignedIn) {
        assertNoFaults()
      }
      if ((await qr.count()) > 0 && (await qr.first().isVisible().catch(() => false))) {
        qrVisible = true
        break
      }
      if (
        (await qrButton.count()) > 0 &&
        (await qrButton.first().isEnabled().catch(() => false))
      ) {
        await qrButton.first().click().catch(() => undefined)
      }
      await delay(200)
    }
    if (!qrVisible) {
      await shot(page, shotName)
      throw fail(`QR was not visible within ${qrBudgetMs}ms`)
    }
    if (recordQr) {
      timing.qr_visible_ms = String(Date.now() - started)
      note(`qr visible at ${timing.qr_visible_ms}ms`)
    } else {
      note('qr visible on the previous build')
    }
    const qrFile = join(work, 'qr.png')
    await qr.first().screenshot({ path: qrFile })
    const decoded = await new Promise((resolve, reject) => {
      const child = spawn('zbarimg', ['-q', '--raw', qrFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', chunk => {
        out += String(chunk)
      })
      child.on('error', reject)
      child.on('close', code => {
        if (code !== 0) {
          reject(new Error(`zbarimg exited ${code}`))
          return
        }
        resolve(out)
      })
    })
    await rm(qrFile, { force: true })
    const link = String(decoded)
      .split('\n')
      .map(line => line.trim())
      .find(line => line.startsWith('tg://login?token='))
    if (link === undefined || link.length < 'tg://login?token='.length + 8) {
      throw fail('QR did not decode to a login link')
    }
    await qr.first().evaluate(element => {
      element.style.filter = 'blur(18px)'
    })
    await shot(page, shotName)
    return await new Promise((resolve, reject) => {
      const child = spawn('python3', [tdqr, slot, 'confirm'], {
        env: { ...process.env, TDQR_LINK: link },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let sawConfirm = false
      const take = chunk => {
        for (const line of String(chunk).split('\n')) {
          const trimmed = line.trim()
          if (trimmed === '') {
            continue
          }
          note(trimmed)
          if (!trimmed.includes('confirm ->')) {
            continue
          }
          sawConfirm = true
          if (trimmed.includes('confirm -> error')) {
            reject(fail(trimmed))
            return
          }
          resolve(Date.now())
        }
      }
      child.stdout.on('data', take)
      child.stderr.on('data', take)
      child.on('error', reject)
      child.on('close', code => {
        if (!sawConfirm) {
          reject(fail(`approver exited ${code} before confirm`))
        }
      })
      setTimeout(() => {
        child.kill()
        if (!sawConfirm) {
          reject(fail('approver timed out before confirm'))
        }
      }, 60_000).unref()
    })
  }

  note(`redeploy previous=${previousBundle} next=${newBundle}`)
  browser = await launch(redeployProfile)
  // The base glue hides FS on the module argument. Capture it as the script loads.
  await browser.addInitScript(captureTdlibFilesystem)
  let previousPage = browser.pages()[0] ?? (await browser.newPage())
  note(`browser ${browserName}`)
  // A wedged base renderer never answers Playwright. Give up and open a new
  // browser instead of waiting until the outer test timeout.
  const within = async (work, ms) => {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('timed out'))
      }, ms)
    })
    try {
      return await Promise.race([Promise.resolve(work), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
  const reopenPrevious = async () => {
    if (browser !== undefined) {
      await within(browser.close(), 10_000).catch(() => undefined)
      browser = undefined
    }
    await rm(join(redeployProfile, 'Default', 'IndexedDB'), {
      recursive: true,
      force: true,
    }).catch(() => undefined)
    browser = await launch(redeployProfile)
    await browser.addInitScript(captureTdlibFilesystem)
    previousPage = browser.pages()[0] ?? (await browser.newPage())
    watch(previousPage)
    await previousPage.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    note('previous build reopened after a wedged page')
  }
  let previousApproved = 0
  let saved = false
  let wedged = false
  for (let attempt = 0; attempt < 4 && !saved; attempt += 1) {
    if (attempt > 0) {
      // A base-client save can commit a torn copy and then abort. Drop that
      // database on this origin before the next login.
      note('previous build did not finish login; trying once more')
      faults.length = 0
      if (wedged) {
        wedged = false
        await reopenPrevious()
      } else {
        try {
          await within(
            previousPage.evaluate(
              () =>
                new Promise(resolve => {
                  const finish = name => {
                    const request = indexedDB.deleteDatabase(name)
                    return new Promise(done => {
                      request.onsuccess = () => {
                        done()
                      }
                      request.onerror = () => {
                        done()
                      }
                      request.onblocked = () => {
                        done()
                      }
                    })
                  }
                  Promise.all([finish('/tdlib'), finish('crm-chat-tdlib')]).then(
                    () => {
                      resolve(undefined)
                    },
                  )
                }),
            ),
            5_000,
          )
          await within(
            previousPage.reload({ waitUntil: 'domcontentloaded' }),
            15_000,
          )
        } catch {
          await reopenPrevious()
        }
      }
    } else {
      watch(previousPage)
      await previousPage.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    }
    try {
      if (await within(chatsVisible(previousPage), 5_000)) {
        previousApproved = Date.now()
        note('previous build opened the saved chat list')
      } else {
        previousApproved = await within(
          approveQr(previousPage, 'redeploy-qr.png', false, 60_000, true),
          150_000,
        )
      }
    } catch (error) {
      if (
        (error instanceof Error ? error.message : String(error)) === 'timed out'
      ) {
        wedged = true
      }
      if (attempt === 3) {
        throw error
      }
      continue
    }
    // Copy a stable image, then reject it unless the WAL commit covers the file.
    const faultsBefore = faults.length
    const plantDeadline = Date.now() + 30_000
    let planted = { ok: false, reason: 'not ready', files: 0 }
    try {
      while (Date.now() < plantDeadline) {
        if (faults.length > faultsBefore) {
          break
        }
        const ready = await within(chatsVisible(previousPage), 5_000)
        if (!ready) {
          await delay(200)
          continue
        }
        try {
          planted = await within(
            previousPage.evaluate(plantLiveSnapshot),
            25_000,
          )
        } catch (error) {
          if (
            (error instanceof Error ? error.message : String(error)) ===
            'timed out'
          ) {
            throw error
          }
          planted = { ok: false, reason: 'unreadable', files: 0 }
        }
        if (
          planted.ok &&
          faults.length === faultsBefore &&
          (await within(chatsVisible(previousPage), 5_000))
        ) {
          break
        }
        if (!planted.ok) {
          note(
            `previous build snapshot waiting (${planted.reason}) ${planted.detail ?? ''}`,
          )
        }
        if (faults.length > faultsBefore) {
          break
        }
        await delay(400)
      }
    } catch {
      wedged = true
      planted = { ok: false, reason: 'timed out', files: planted.files ?? 0 }
    }
    if (!planted.ok) {
      const reason = faults.length > faultsBefore ? 'aborted' : planted.reason
      note(`previous build snapshot not ready (${reason}) ${planted.detail ?? ''}`)
      if (attempt === 3) {
        throw fail(`previous build did not finish saving (${reason})`)
      }
      continue
    }
    note(
      `previous build planted a live snapshot files=${planted.files ?? 0} ${planted.detail ?? ''} stable=${planted.stable === true}`,
    )
    await browser.close()
    browser = undefined
    const redeployAt = Date.now()
    await retarget(root)
    faults.length = 0
    const authFrom = timing.auth.length
    browser = await launch(redeployProfile)
    const redeployed = browser.pages()[0] ?? (await browser.newPage())
    watch(redeployed)
    await redeployed.goto(pageUrl, { waitUntil: 'domcontentloaded' })
    const names = await scriptNames(redeployed)
    note(`redeploy scripts ${names.filter(name => name !== '').join(',')}`)
    if (!names.includes(newBundle)) {
      await shot(redeployed, '06-after-redeploy.png')
      throw fail(
        names.includes(previousBundle)
          ? 'redeploy kept the previous bundle'
          : `redeploy did not load ${newBundle}`,
      )
    }
    const lastTry = attempt === 3
    try {
      await stillLoggedIn(
        redeployed,
        'redeploy',
        '06-after-redeploy.png',
        lastTry,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!lastTry && message === 'redeploy returned to the QR screen') {
        note(
          'redeploy opened the planted database as a new login; trying once more',
        )
        await browser.close().catch(() => undefined)
        browser = undefined
        await retarget(previous)
        wedged = true
        continue
      }
      if (!lastTry) {
        throw fail(message)
      }
      throw error
    }
    const snapshotLines = timing.auth
      .slice(authFrom)
      .filter(line => line.startsWith('tdlib snapshot'))
    if (
      snapshotLines.length === 0 ||
      snapshotLines.some(
        line => !line.includes(' checkpointed') || line.includes(' skip='),
      )
    ) {
      throw fail(
        `redeploy snapshot was not checkpointed (${snapshotLines.join(' | ') || 'no snapshot'})`,
      )
    }
    timing.previous_signed_in_ms = String(Date.now() - previousApproved)
    note(`previous build signed in at ${timing.previous_signed_in_ms}ms`)
    timing.redeploy_ms = String(Date.now() - redeployAt)
    await shot(redeployed, '06-after-redeploy.png')
    note(`redeploy persisted at ${timing.redeploy_ms}ms bundle=${newBundle}`)
    await browser.close()
    browser = undefined
    saved = true
  }
  if (!saved) {
    throw fail('previous build did not finish saving')
  }

  started = Date.now()
  browser = await launch(profile)
  const page = browser.pages()[0] ?? (await browser.newPage())
  note(`browser ${browserName}`)
  watch(page)
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const approvedAt = await approveQr(page, '01-qr-blurred.png', true, 60_000)

  const deadline = approvedAt + listBudgetMs
  let rows = 0
  let realPreview = ''
  while (Date.now() < deadline) {
    assertNoFaults()
    const password = page.getByRole('textbox', { name: '2FA password' })
    if ((await password.count()) > 0) {
      timing.approve_to_chats_ms = String(Date.now() - approvedAt)
      throw fail(
        'test account is waiting for a 2FA password and none is stored',
      )
    }
    const alert = page.locator('[role="alert"]')
    const alertText =
      (await alert.count()) > 0
        ? await alert.first().textContent({ timeout: 200 })
        : ''
    if (String(alertText).includes('Could not load chats')) {
      timing.approve_to_chats_ms = String(Date.now() - approvedAt)
      throw fail('chat list failed to load')
    }
    const shell = page.locator('[aria-label="Telegram chats"]')
    rows = await page.locator('.chat-row').count()
    if ((await shell.count()) > 0 && rows > 0) {
      const previews = await page
        .locator('.chat-row .chat-row-meta.truncate')
        .allTextContents()
      realPreview =
        previews.map(text => text.trim()).find(text => text !== '' && !kindPreview.has(text)) ??
        ''
      if (realPreview !== '') {
        break
      }
    }
    await delay(100)
  }
  timing.approve_to_chats_ms = String(Date.now() - approvedAt)
  await shot(page, '02-chat-list.png')
  if (realPreview === '') {
    throw fail(
      `chat list with a last-message preview was not visible within ${listBudgetMs}ms (rows=${rows}, approve_to_chats_ms=${timing.approve_to_chats_ms})`,
    )
  }
  note(
    `chat list at ${timing.approve_to_chats_ms}ms rows=${rows} preview_chars=${realPreview.length}`,
  )

  const previewRow = page
    .locator('.chat-row')
    .filter({ hasText: realPreview })
    .first()
  await previewRow.click()
  const bubble = page.locator('.tg-bubble').first()
  const historyStart = Date.now()
  try {
    await bubble.waitFor({ state: 'visible', timeout: historyBudgetMs })
  } catch {
    timing.history_ms = String(Date.now() - historyStart)
    await shot(page, '03-open-chat.png')
    throw fail(`opened chat did not render a message within ${historyBudgetMs}ms`)
  }
  const bubbleText = (await bubble.innerText()).replace(/\s+/g, ' ').trim()
  const empty = page.getByText('No messages yet')
  if (bubbleText === '' || (await empty.count()) > 0) {
    timing.history_ms = String(Date.now() - historyStart)
    await shot(page, '03-open-chat.png')
    throw fail('opened chat has no message text')
  }
  timing.history_ms = String(Date.now() - historyStart)
  await shot(page, '03-open-chat.png')
  note(`history at ${timing.history_ms}ms bubble_chars=${bubbleText.length}`)
  await proveRooms(page)

  // A real profile keeps every earlier login as its own directory. Copy the
  // open database, close TDLib, copy the checkpoint, then add a newer leftover
  // so the reload opens that empty directory first and must not log the real
  // one out.
  await waitForSyncSaved(page, 'session')
  const sealedAt = savedCount()
  await sealPage(page)
  await waitForSyncSaved(page, 'sealed session', sealedAt)
  await page.evaluate(async () => {
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open('/tdlib', 21)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('FILE_DATA')) {
          request.result.createObjectStore('FILE_DATA')
        }
      }
      request.onerror = () => {
        reject(request.error)
      }
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    const transaction = opened.transaction('FILE_DATA', 'readwrite')
    const store = transaction.objectStore('FILE_DATA')
    const stamp = new Date()
    const leftover = '00000000-0000-4000-8000-000000000001'
    const directory = {
      timestamp: stamp,
      mode: 16895,
      contents: new Uint8Array(),
    }
    store.put(directory, `/tdlib/${leftover}`)
    store.put(directory, `/tdlib/${leftover}/files`)
    await new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve()
      }
      transaction.onerror = () => {
        reject(transaction.error)
      }
    })
    opened.close()
  })

  const reloadStart = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  try {
    await stillLoggedIn(page, 'reload', '04-after-reload.png')
  } catch (error) {
    timing.reload_ms = String(Date.now() - reloadStart)
    throw error
  }
  timing.reload_ms = String(Date.now() - reloadStart)
  await shot(page, '04-after-reload.png')
  note(`reload persisted at ${timing.reload_ms}ms`)
  const sealedReopen = savedCount()
  await sealPage(page)
  await waitForSyncSaved(page, 'reopen', sealedReopen)

  const reopenStart = Date.now()
  await browser.close()
  browser = await playwright.launchPersistentContext(profile, {
    executablePath: chromium,
    headless: process.env.CRM_CHAT_WEB_HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-dev-shm-usage'],
  })
  const reopened = browser.pages()[0] ?? (await browser.newPage())
  watch(reopened)
  await reopened.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  try {
    await stillLoggedIn(reopened, 'reopen', '05-reopened.png')
  } catch (error) {
    timing.reopen_ms = String(Date.now() - reopenStart)
    throw error
  }
  timing.reopen_ms = String(Date.now() - reopenStart)
  await shot(reopened, '05-reopened.png')
  note(`reopen persisted at ${timing.reopen_ms}ms`)
  const skipped = timing.auth.find(line => line.includes(' skip='))
  if (skipped !== undefined) {
    throw fail(`snapshot was not checkpointed (${skipped})`)
  }
  assertNoFaults()
  note('PASS')
} catch (error) {
  failed = true
  const message = error instanceof Error ? error.message : 'failed'
  if (!logLines.includes(`FAIL ${message}`)) {
    note(`FAIL ${message}`)
  }
  if (browser !== undefined) {
    const page = browser.pages()[0]
    await shot(page, 'failure.png')
  }
} finally {
  await writeTiming()
  if (browser !== undefined) {
    await browser.close().catch(() => undefined)
  }
  server.kill('SIGTERM')
  await rm(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
