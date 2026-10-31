#!/usr/bin/env node
// Browser proof of the 1970 Last-Modified redeploy bug. Nix store files are
// dated 1970-01-01, so this stamps both sites the same way. Exit 1 when the
// reloaded page does not run the new bundle.
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const python = process.env.CRM_CHAT_PYTHON ?? 'python3'
const serveScript =
  process.env.CRM_CHAT_WEBSITE_SERVE ??
  fileURLToPath(new URL('./website_serve.py', import.meta.url))
const playwrightCore = process.env.PLAYWRIGHT_CORE
const chromium = process.env.CHROMIUM
const legacy = process.env.CRM_CHAT_SERVE_LEGACY === '1'

const stamp = async file => {
  const epoch = new Date(1000)
  await utimes(file, epoch, epoch)
}

const writeSite = async (dir, name) => {
  await mkdir(join(dir, 'assets'), { recursive: true })
  const html = join(dir, 'index.html')
  const script = join(dir, 'assets', `index-${name}.js`)
  await writeFile(
    html,
    `<!doctype html><script type="module" src="/assets/index-${name}.js"></script>\n`,
  )
  await writeFile(script, `/* ${name} */\n`)
  await stamp(html)
  await stamp(script)
}

const work = await mkdtemp(join(tmpdir(), 'crm-redeploy-'))
const oldSite = join(work, 'old')
const newSite = join(work, 'new')
const link = join(work, 'site')
const profile = join(work, 'profile')
await writeSite(oldSite, 'OLD')
await writeSite(newSite, 'NEW')
await symlink(oldSite, link)
const server = spawn(python, [serveScript, link, '0'], {
  env: process.env,
  stdio: ['ignore', 'pipe', 'inherit'],
})
const pageUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const onExit = code => reject(new Error(`website server exited ${code}`))
  server.once('exit', onExit)
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
const { chromium: playwright } = await import(playwrightCore)
let failed = false
let browser
try {
  browser = await playwright.launchPersistentContext(profile, {
    executablePath: chromium,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-dev-shm-usage'],
  })
  const page = browser.pages()[0] ?? (await browser.newPage())
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  await browser.close()
  browser = undefined
  await unlink(link)
  await symlink(newSite, link)
  browser = await playwright.launchPersistentContext(profile, {
    executablePath: chromium,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-dev-shm-usage'],
  })
  const reopened = browser.pages()[0] ?? (await browser.newPage())
  const statuses = []
  reopened.on('response', response => {
    const url = new URL(response.url())
    if (url.pathname === '/' || url.pathname === '/index.html') {
      statuses.push(response.status())
    }
  })
  await reopened.goto(pageUrl, { waitUntil: 'domcontentloaded' })
  const names = await reopened.evaluate(() =>
    [...document.scripts].map(script => script.src.split('/').pop()),
  )
  const loaded = names.includes('index-NEW.js')
  console.log(
    `mode=${legacy ? 'legacy' : 'new'} status=${statuses.join(',') || 'none'} scripts=${names.join(',') || 'none'}`,
  )
  if (!loaded) {
    console.log('FAIL redeploy kept the previous bundle')
    failed = true
  } else {
    console.log('PASS redeploy loaded index-NEW.js')
  }
} finally {
  if (browser !== undefined) {
    await browser.close().catch(() => undefined)
  }
  server.kill('SIGTERM')
  await rm(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
