import { afterEach, expect, test, vi } from 'vitest'

import { TdWasmRuntime } from './tdlibWasm'

const HASH = '0123456789abcdef0123456789abcdef'
const WASM_JS = '/tdlib/td_wasm.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type Harness = {
  runtime: TdWasmRuntime
  syncs: Array<boolean>
  sent: Array<Record<string, unknown>>
  failSync: (error: unknown) => void
  deliverAuth: { current: boolean }
  creates: { current: number }
}

const install = (
  ids: Array<string>,
  authorization: Record<string, unknown>,
): Harness => {
  const syncs: Array<boolean> = []
  const sent: Array<Record<string, unknown>> = []
  const responses: Array<string> = []
  const deliverAuth = { current: false }
  const creates = { current: 0 }
  let clientId = 0
  let delivered = false
  let syncFailure: unknown = undefined
  const querySelector = document.querySelector.bind(document)
  vi.spyOn(document, 'querySelector').mockImplementation(selector => {
    if (selector === `script[src="${WASM_JS}"]`) {
      return document.createElement('script')
    }
    return querySelector(selector)
  })
  const receive = (): string => {
    if (deliverAuth.current && !delivered && clientId !== 0) {
      delivered = true
      return JSON.stringify({
        '@type': 'updateAuthorizationState',
        '@client_id': clientId,
        authorization_state: authorization,
      })
    }
    return responses.shift() ?? ''
  }
  Reflect.set(globalThis, 'createTdwebModule', () =>
    Promise.resolve({
      cwrap: (name: string) => {
        if (name === 'td_emscripten_create_client_id') {
          return () => {
            creates.current += 1
            clientId += 1
            return clientId
          }
        }
        if (name === 'td_emscripten_send') {
          return (_clientId: number, query: string) => {
            const parsed: unknown = JSON.parse(query)
            if (!isRecord(parsed)) {
              return
            }
            sent.push(parsed)
            const extra = parsed['@extra']
            if (typeof extra === 'string') {
              responses.push(JSON.stringify({ '@type': 'ok', '@extra': extra }))
            }
          }
        }
        if (name === 'td_emscripten_receive') {
          return receive
        }
        if (name === 'td_emscripten_execute') {
          return () => JSON.stringify({ '@type': 'ok' })
        }
        return () => ''
      },
      FS: {
        mkdir: () => undefined,
        mount: () => undefined,
        filesystems: { IDBFS: {} },
        syncfs: (populate: boolean, callback: (error: unknown) => void) => {
          syncs.push(populate)
          callback(syncFailure)
        },
        readdir: () => ['.', '..', ...ids],
      },
    }),
  )
  return {
    runtime: new TdWasmRuntime(),
    syncs,
    sent,
    failSync: error => {
      syncFailure = error
    },
    deliverAuth,
    creates,
  }
}

const hiddenSyncs = (syncs: Array<boolean>): number =>
  syncs.filter(populate => !populate).length

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'createTdwebModule')
})

test('IndexedDB flushes on ready, page hide, and a hidden tab, then keeps flushing', async () => {
  vi.useFakeTimers()
  const harness = install([], {
    '@type': 'authorizationStateReady',
  })
  await harness.runtime.open('acct', 1, HASH)
  expect(harness.syncs).toEqual([true])

  window.dispatchEvent(new Event('pagehide'))
  await vi.advanceTimersByTimeAsync(0)
  expect(hiddenSyncs(harness.syncs)).toBe(1)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(hiddenSyncs(harness.syncs)).toBe(1)

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'hidden',
  })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(0)
  expect(hiddenSyncs(harness.syncs)).toBe(2)

  harness.deliverAuth.current = true
  await vi.advanceTimersByTimeAsync(100)
  expect(hiddenSyncs(harness.syncs)).toBe(3)

  await harness.runtime.sync()
  expect(hiddenSyncs(harness.syncs)).toBe(4)

  const beforeInterval = harness.syncs.length
  await vi.advanceTimersByTimeAsync(5_000)
  expect(harness.syncs.length).toBe(beforeInterval + 1)

  harness.failSync(new Error('QuotaExceeded'))
  await expect(harness.runtime.sync()).rejects.toThrow(/QuotaExceeded/)
  expect(harness.runtime.syncError).toBeInstanceOf(Error)
  if (harness.runtime.syncError instanceof Error) {
    expect(harness.runtime.syncError.message).toContain('QuotaExceeded')
  }

  const beforeRetry = harness.syncs.length
  await vi.advanceTimersByTimeAsync(5_000)
  expect(harness.syncs.length).toBeGreaterThan(beforeRetry)
  expect(harness.runtime.syncError).toBeInstanceOf(Error)
})

test('a restored QR login is discarded instead of blocking the page', async () => {
  vi.useFakeTimers()
  const harness = install(['qr-acct'], {
    '@type': 'authorizationStateWaitOtherDeviceConfirmation',
    link: 'tg://login?token=abc',
  })
  harness.deliverAuth.current = true
  let restored: Awaited<ReturnType<TdWasmRuntime['restore']>> | undefined
  const pending = harness.runtime.restore(1, HASH).then(accounts => {
    restored = accounts
  })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(restored).toEqual([])
  await pending
  expect(harness.sent.map(query => query['@type'])).toContain('logOut')
  const creates = harness.creates.current
  await harness.runtime.open('qr-acct', 1, HASH)
  expect(harness.creates.current).toBe(creates + 1)
})

test('a restored ready account stays signed in', async () => {
  vi.useFakeTimers()
  const harness = install(['ready-one'], {
    '@type': 'authorizationStateReady',
  })
  harness.deliverAuth.current = true
  let restored: Awaited<ReturnType<TdWasmRuntime['restore']>> | undefined
  const pending = harness.runtime.restore(1, HASH).then(accounts => {
    restored = accounts
  })
  await vi.advanceTimersByTimeAsync(3_000)
  expect(restored).toHaveLength(1)
  await pending
  expect(harness.sent.map(query => query['@type'])).not.toContain('logOut')
})
