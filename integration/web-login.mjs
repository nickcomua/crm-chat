#!/usr/bin/env node
// Production-website QR login. Serves CRM_CHAT_WEBSITE, approves the QR with a
// copy of a saved test-account session, and checks the chat list, a real
// last-message preview, opened history, and a reload. Never prints secrets.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, createReadStream, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const root = process.env.CRM_CHAT_WEBSITE
const playwrightCore = process.env.PLAYWRIGHT_CORE
const chromium = process.env.CHROMIUM
const shots =
  process.env.CRM_CHAT_WEB_SHOTS ??
  join(process.env.HOME ?? tmpdir(), '.local/state/kam-t3/shots/fix-web-connect')
const tdqr =
  process.env.CRM_CHAT_TDQR ??
  join(process.env.HOME ?? '', '.local/state/kam-t3/tools/tdqr.py')
const slot = process.env.CRM_CHAT_TDQR_SLOT ?? '1'
const listBudgetMs = 5_000
const historyBudgetMs = 10_000
const reloadBudgetMs = 15_000
const kindPreview = new Set(['personal chat', 'group', 'channel'])

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

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

if (!root || !existsSync(join(root, 'index.html'))) {
  console.error('integration-test-web: CRM_CHAT_WEBSITE is not a website build')
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

const credentials = Buffer.from(
  JSON.stringify({ apiId, apiHash }),
  'utf8',
)

const serveFile = (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/runtime/telegram-app') {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': String(credentials.length),
    })
    response.end(credentials)
    return
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const candidate = normalize(join(root, relative))
  const inside = candidate === root || candidate.startsWith(`${root}${sep}`)
  let file = inside && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, 'index.html')
  if (!existsSync(file)) {
    response.writeHead(404, { 'Cache-Control': 'no-store' })
    response.end()
    return
  }
  const type = mime[extname(file)] ?? 'application/octet-stream'
  const cache =
    url.pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': String(statSync(file).size),
  })
  createReadStream(file).pipe(response)
}

const server = createServer((request, response) => {
  try {
    serveFile(request, response)
  } catch (error) {
    note(`http ${redact(error instanceof Error ? error.message : 'error')}`)
    response.writeHead(500)
    response.end()
  }
})
await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
const port = typeof address === 'object' && address !== null ? address.port : 0
const pageUrl = `http://127.0.0.1:${port}/`
note(`serving website on ${pageUrl}`)

await mkdir(shots, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'crm-web-login-'))
const profile = join(work, 'profile')
const timingPath = join(shots, 'timing.log')
const started = Date.now()
const browserName = process.env.CRM_CHAT_CHROMIUM_NAME ?? 'chromium'
const timing = {
  browser: browserName,
  qr_visible_ms: '',
  approve_to_chats_ms: '',
  history_ms: '',
  reload_ms: '',
  reopen_ms: '',
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
  /Aborted\(|RuntimeError|memory access out of bounds/i.test(text)
const watch = page => {
  page.on('console', message => {
    const text = message.text()
    if (
      text.startsWith('tdlib auth authorizationState') ||
      text === 'tdlib sync saved'
    ) {
      timing.auth.push(redact(text))
      note(text)
    }
    if (!runtimeFault(text)) {
      return
    }
    const line = redact(text).slice(0, 400)
    faults.push(line)
    note(`console ${message.type()} ${line}`)
  })
  page.on('pageerror', error => {
    const line = redact(String(error.stack ?? error.message)).slice(0, 400)
    faults.push(line)
    note(`pageerror ${line}`)
  })
}
const assertNoFaults = () => {
  if (faults.length > 0) {
    throw fail(`page error: ${faults[0]}`)
  }
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

try {
  const { chromium: playwright } = await import(playwrightCore)
  browser = await playwright.launchPersistentContext(profile, {
    executablePath: chromium,
    headless: process.env.CRM_CHAT_WEB_HEADED !== '1',
    viewport: { width: 1440, height: 900 },
    args: ['--disable-dev-shm-usage'],
  })
  const page = browser.pages()[0] ?? (await browser.newPage())
  note(`browser ${browserName}`)
  watch(page)
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })

  const qr = page.locator('img[alt="Telegram login QR code"]')
  const qrButton = page.getByRole('button', { name: 'Log in by QR code' })
  const qrDeadline = Date.now() + 30_000
  let qrVisible = false
  while (Date.now() < qrDeadline) {
    assertNoFaults()
    if ((await qr.count()) > 0 && (await qr.first().isVisible().catch(() => false))) {
      qrVisible = true
      break
    }
    if ((await qrButton.count()) > 0 && (await qrButton.first().isEnabled().catch(() => false))) {
      await qrButton.first().click().catch(() => undefined)
    }
    await delay(200)
  }
  if (!qrVisible) {
    await shot(page, '01-qr-blurred.png')
    throw fail('QR was not visible within 30s')
  }
  timing.qr_visible_ms = String(Date.now() - started)
  note(`qr visible at ${timing.qr_visible_ms}ms`)

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
  await shot(page, '01-qr-blurred.png')

  const approvedAt = await new Promise((resolve, reject) => {
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

  // A real profile keeps every earlier login as its own directory. Give the
  // signed-in database time to flush, then add a newer leftover the way a
  // later visit does, and only then reload.
  await delay(2_000)
  const saveDeadline = Date.now() + reloadBudgetMs
  while (!timing.auth.includes('tdlib sync saved') && Date.now() < saveDeadline) {
    await delay(100)
  }
  if (!timing.auth.includes('tdlib sync saved')) {
    await shot(page, '04-after-reload.png')
    throw fail('session was not saved before reload')
  }
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset.tdlibSync === '0',
      undefined,
      { timeout: reloadBudgetMs },
    )
  } catch {
    await shot(page, '04-after-reload.png')
    throw fail('session save was still running at reload')
  }
  await page.evaluate(async () => {
    const opened = await new Promise((resolve, reject) => {
      const request = indexedDB.open('/tdlib', 21)
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

  const stillLoggedIn = async (nextPage, label, shotName) => {
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
      throw fail(
        qrVisible
          ? `${label} returned to the QR screen`
          : `${label} did not keep a last-message preview within ${reloadBudgetMs}ms`,
      )
    }
    note(`${label} preview_chars=${preview.length}`)
  }

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
  await page.waitForFunction(
    () => document.documentElement.dataset.tdlibSync === '0',
    undefined,
    { timeout: reloadBudgetMs },
  )

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
  assertNoFaults()
  note('PASS')
} catch (error) {
  failed = true
  const message = error instanceof Error ? error.message : 'failed'
  if (!logLines.some(line => line.startsWith('FAIL'))) {
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
  server.close()
  await rm(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
