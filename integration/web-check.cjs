// Web-path Telegram check: GramJS over WSS, the same socket options as
// web/src/telegram.ts connectionOptions. CommonJS because the telegram
// package is CommonJS; Vite resolves the same specifiers for the page.
// Credentials come from the process environment. The Nix app starts this
// script under `secretspec run --provider bws --scope app`. Do not print
// secret values.

const { Api, TelegramClient } = require('telegram')
const { LogLevel } = require('telegram/extensions/Logger')
const { PromisedWebSockets } = require('telegram/extensions/PromisedWebSockets')
const { ConnectionTCPObfuscated } = require('telegram/network/connection')
const { StringSession } = require('telegram/sessions')

const timeoutMs = 45_000

// Keep in step with web/src/telegram.ts connectionOptions. autoReconnect is
// off so a failed check surfaces instead of retrying forever.
const connectionOptions = {
  useWSS: true,
  networkSocket: PromisedWebSockets,
  connection: ConnectionTCPObfuscated,
  connectionRetries: 3,
  requestRetries: 2,
  autoReconnect: false,
  deviceModel: 'CRM Chat Web',
}

const redact = (text) => {
  let out = String(text)
  for (const key of [
    'TG_ID',
    'TG_HASH',
    'TG_API_ID_1',
    'TG_API_HASH_1',
    'TG_API_ID_2',
    'TG_API_HASH_2',
    'TG_SESSION_FILE_1',
    'TG_SESSION_FILE_2',
    'TG_USER_ID_1',
  ]) {
    const value = process.env[key]
    if (value && value.length >= 4) {
      out = out.split(value).join('[redacted]')
    }
  }
  return out
}

const fail = (message) => {
  console.error(`web: ${redact(message)}`)
  process.exitCode = 1
}

const credentials = () => {
  const apiId = process.env.TG_ID
  const apiHash = process.env.TG_HASH
  if (!apiId || !apiHash) {
    fail(
      'TG_ID and TG_HASH did not resolve. Run this through secretspec run --provider bws --scope app.',
    )
    return undefined
  }
  if (!/^[1-9]\d*$/.test(apiId) || !/^[a-f\d]{32}$/i.test(apiHash)) {
    fail('resolved TG_ID or TG_HASH is not in the shape the apps accept')
    return undefined
  }
  const apiIdNumber = Number(apiId)
  if (!Number.isSafeInteger(apiIdNumber)) {
    fail('TG_ID does not fit in a Telegram api_id')
    return undefined
  }
  return { apiId: apiIdNumber, apiHash }
}

const rpcName = (error) => {
  if (error && typeof error === 'object' && typeof error.errorMessage === 'string') {
    return error.errorMessage.replace(/_\d+/g, '')
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/)
  return match ? match[0].replace(/_\d+/g, '') : 'unknown'
}

const invalidApp = (error) => {
  const name = rpcName(error)
  return name === 'API_ID_INVALID' || name === 'API_ID_PUBLISHED_FLOOD'
}

const withClient = async (apiId, apiHash, body) => {
  // Node's GramJS default is a raw DC address. The browser path, which this
  // check is proving, starts at DC 4 on vesta.web.telegram.org over WSS.
  const session = new StringSession('')
  session.setDC(4, 'vesta.web.telegram.org', 443)
  const client = new TelegramClient(session, apiId, apiHash, connectionOptions)
  client.setLogLevel(LogLevel.NONE)
  try {
    await client.connect()
    return await body(client)
  } finally {
    await client.destroy()
  }
}

const limited = (work) =>
  Promise.race([
    work,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timed out')), timeoutMs)
    }),
  ])

const tokenLabel = (result) => {
  const name = result?.className ?? ''
  if (name.includes('MigrateTo')) {
    return 'migrate'
  }
  if (name.includes('Success')) {
    return 'success'
  }
  if (name.includes('LoginToken')) {
    return 'token'
  }
  return undefined
}

const proveAccepted = async (apiId, apiHash) => {
  await withClient(apiId, apiHash, async (client) => {
    const config = await client.invoke(new Api.help.GetConfig())
    if (!Array.isArray(config.dcOptions) || config.dcOptions.length === 0) {
      throw new Error('help.getConfig returned no datacenters')
    }
    const token = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId,
        apiHash,
        exceptIds: [],
      }),
    )
    const accepted = tokenLabel(token)
    if (!accepted) {
      throw new Error('exportLoginToken returned an unexpected result')
    }
    console.log(
      `web gramjs wss: pass (help.getConfig dc_options=${config.dcOptions.length}, exportLoginToken=${accepted})`,
    )
  })
}

const proveRejected = async () => {
  const apiId = 1
  const apiHash = '00000000000000000000000000000000'
  try {
    await withClient(apiId, apiHash, async (client) => {
      await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId,
          apiHash,
          exceptIds: [],
        }),
      )
    })
  } catch (error) {
    if (!invalidApp(error)) {
      throw new Error(
        `invalid credentials rejected with an unexpected error (${rpcName(error)})`,
      )
    }
    console.log('web gramjs wss: pass (invalid credentials rejected)')
    return
  }
  throw new Error('invalid credentials were accepted')
}

const main = async () => {
  const resolved = credentials()
  if (!resolved) {
    return
  }
  try {
    await limited(proveAccepted(resolved.apiId, resolved.apiHash))
    await limited(proveRejected())
  } catch (error) {
    fail(error instanceof Error ? error.message : 'credential check failed')
  }
}

main()
