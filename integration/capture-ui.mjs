const core = process.env.PLAYWRIGHT_CORE
const base = process.env.UI_BASE
const outDir = process.env.UI_OUT
const chromiumPath = process.env.CHROMIUM
if (!core || !base || !outDir || !chromiumPath) {
  throw new Error('PLAYWRIGHT_CORE, UI_BASE, UI_OUT, and CHROMIUM are required')
}

const { chromium } = await import(core)

const shots = [
  { name: 'login-phone', screen: 'login', text: 'Sign in to Telegram' },
  { name: 'login-manual', screen: 'login-manual', text: 'my.telegram.org' },
  { name: 'login-code', screen: 'code', text: 'Enter code' },
  { name: 'login-password', screen: 'password', text: 'Two-step verification' },
  { name: 'login-qr', screen: 'qr', text: 'Log in by QR code' },
  { name: 'chat-thread', screen: 'thread', text: 'See you at the station.' },
  { name: 'menu', screen: 'menu', text: 'About this build' },
  { name: 'chat-menu', screen: 'chat-menu', text: 'Auto-delete' },
]

const browser = await chromium.launch({
  executablePath: chromiumPath,
  args: ['--disable-dev-shm-usage'],
})
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
})

for (const shot of shots) {
  const url = `${base}/preview.html?screen=${shot.screen}`
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.getByText(shot.text, { exact: false }).first().waitFor()
  await page.evaluate(() => {
    document.getElementById('foldkit-devtools')?.remove()
  })
  await page.screenshot({
    path: `${outDir}/${shot.name}.png`,
    fullPage: false,
  })
  console.log(shot.name)
}

await browser.close()
