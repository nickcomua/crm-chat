#!/usr/bin/env node
// Production-website QR login. Serves the website with integration/website_serve.py,
// approves the QR with a copy of a saved test-account session, and checks the
// chat list, a real last-message preview, opened history, a reload, and a
// redeploy from CRM_CHAT_WEBSITE_PREVIOUS onto CRM_CHAT_WEBSITE. Never prints
// secrets.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

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
const listBudgetMs = 5_000
const historyBudgetMs = 10_000
const reloadBudgetMs = 15_000
const kindPreview = new Set(['personal chat', 'group', 'channel'])
const previousSignInBudgetMs = 120_000

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
  const approveQr = async (page, shotName, recordQr, qrBudgetMs = 30_000) => {
    const qr = page.locator('img[alt="Telegram login QR code"]')
    // The PR base says "Log in with QR". The current site says "Log in by QR code".
    const qrButton = page.getByRole('button', { name: /log in (by|with) qr/i })
    const qrDeadline = Date.now() + qrBudgetMs
    let qrVisible = false
    while (Date.now() < qrDeadline) {
      assertNoFaults()
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
  const previousPage = browser.pages()[0] ?? (await browser.newPage())
  note(`browser ${browserName}`)
  watch(previousPage)
  await previousPage.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const previousApproved = await approveQr(
    previousPage,
    'redeploy-qr.png',
    false,
    60_000,
  )
  const signedDeadline = previousApproved + previousSignInBudgetMs
  let signedIn = false
  while (Date.now() < signedDeadline) {
    // The PR base wasm aborts on Chromium 155 after approval. That page is only
    // the previous deployment. Page errors start counting once the new bundle loads.
    const code = previousPage.locator('img[alt="Telegram login QR code"]')
    const qrStill =
      (await code.count()) > 0 &&
      (await code.first().isVisible().catch(() => false))
    const heading = previousPage.getByRole('heading', { name: 'Telegram chats' })
    const shell = previousPage.locator('[aria-label="Telegram chats"]')
    const headingVisible =
      (await heading.count()) > 0 &&
      (await heading.first().isVisible().catch(() => false))
    const shellVisible =
      (await shell.count()) > 0 &&
      (await shell.first().isVisible().catch(() => false))
    if (!qrStill && (headingVisible || shellVisible)) {
      signedIn = true
      break
    }
    await delay(200)
  }
  if (!signedIn) {
    await shot(previousPage, '06-after-redeploy.png')
    throw fail('previous build did not leave the QR screen')
  }
  timing.previous_signed_in_ms = String(Date.now() - previousApproved)
  note(`previous build signed in at ${timing.previous_signed_in_ms}ms`)
  note('waiting 10s for the previous build to flush')
  await delay(10_000)
  await browser.close()
  browser = undefined
  const redeployAt = Date.now()
  await retarget(root)
  faults.length = 0
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
  await stillLoggedIn(redeployed, 'redeploy', '06-after-redeploy.png')
  timing.redeploy_ms = String(Date.now() - redeployAt)
  await shot(redeployed, '06-after-redeploy.png')
  note(`redeploy persisted at ${timing.redeploy_ms}ms bundle=${newBundle}`)
  await browser.close()
  browser = undefined

  started = Date.now()
  browser = await launch(profile)
  const page = browser.pages()[0] ?? (await browser.newPage())
  note(`browser ${browserName}`)
  watch(page)
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const approvedAt = await approveQr(page, '01-qr-blurred.png', true)

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
  server.kill('SIGTERM')
  await rm(work, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
