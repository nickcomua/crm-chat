import { afterEach, describe, expect, test, vi } from 'vitest'

import { TdWasmRuntime } from './tdlibWasm'

type Call = { name: string; query?: string }

const ok = JSON.stringify({ '@type': 'ok' })

const installModule = (
  execute: (query: string) => string,
): { calls: Array<Call> } => {
  const calls: Array<Call> = []
  const cwrap = (name: string) => {
    if (name === 'td_emscripten_execute') {
      return (query: unknown) => {
        const text = String(query)
        calls.push({ name: 'execute', query: text })
        return execute(text)
      }
    }
    if (name === 'td_emscripten_create_client_id') {
      return () => {
        calls.push({ name: 'create' })
        return 7
      }
    }
    if (name === 'td_emscripten_send') {
      return (clientId: unknown, query: unknown) => {
        calls.push({
          name: 'send',
          query: `${String(clientId)}:${String(query)}`,
        })
      }
    }
    if (name === 'td_emscripten_receive') {
      return () => ''
    }
    throw new Error(name)
  }
  const filesystem = {
    mkdir: () => undefined,
    mount: () => undefined,
    syncfs: (_populate: boolean, callback: (error: unknown) => void) => {
      callback(null)
    },
    readdir: () => [],
    filesystems: { IDBFS: {} },
  }
  vi.spyOn(document, 'querySelector').mockReturnValue(
    document.createElement('script'),
  )
  Reflect.set(globalThis, 'createTdwebModule', () =>
    Promise.resolve({ cwrap, FS: filesystem }),
  )
  return { calls }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, 'createTdwebModule')
})

describe('TDLib wasm log silence', () => {
  test('empties the log stream before a client or setTdlibParameters', async () => {
    vi.useFakeTimers()
    const { calls } = installModule(() => ok)
    const runtime = new TdWasmRuntime()
    await runtime.open('one', 1, 'a'.repeat(32))
    const createdAt = calls.findIndex(call => call.name === 'create')
    const beforeClient = calls.slice(0, createdAt)
    expect(createdAt).toBeGreaterThan(0)
    expect(beforeClient.some(call => call.name === 'send')).toBe(false)
    const executed = beforeClient
      .filter(call => call.name === 'execute')
      .map(call => call.query ?? '')
    expect(executed.some(query => query.includes('setLogVerbosityLevel'))).toBe(
      true,
    )
    expect(
      executed.some(query => query.includes('"new_verbosity_level":0')),
    ).toBe(true)
    expect(executed.some(query => query.includes('logStreamEmpty'))).toBe(true)
    expect(executed.some(query => query.includes('setTdlibParameters'))).toBe(
      false,
    )
    const verbosityAt = executed.findIndex(query =>
      query.includes('setLogVerbosityLevel'),
    )
    const streamAt = executed.findIndex(query =>
      query.includes('logStreamEmpty'),
    )
    expect(verbosityAt).toBeGreaterThanOrEqual(0)
    expect(streamAt).toBeGreaterThan(verbosityAt)
  })

  test('does not create a client when log silence fails', async () => {
    vi.useFakeTimers()
    const { calls } = installModule(() =>
      JSON.stringify({ '@type': 'error', message: 'CANARY-api_hash' }),
    )
    const runtime = new TdWasmRuntime()
    await expect(runtime.open('one', 1, 'a'.repeat(32))).rejects.toThrow(
      'could not silence TDLib logs',
    )
    expect(calls.some(call => call.name === 'create')).toBe(false)
    expect(calls.some(call => call.name === 'send')).toBe(false)
  })

  test('sends setTdlibParameters once, before any authorization update', async () => {
    vi.useFakeTimers()
    const calls: Array<Call> = []
    let delivered = false
    const cwrap = (name: string) => {
      if (name === 'td_emscripten_execute') {
        return () => ok
      }
      if (name === 'td_emscripten_create_client_id') {
        return () => {
          calls.push({ name: 'create' })
          return 7
        }
      }
      if (name === 'td_emscripten_send') {
        return (_clientId: unknown, query: unknown) => {
          calls.push({ name: 'send', query: String(query) })
        }
      }
      if (name === 'td_emscripten_receive') {
        return () => {
          const started = calls.some(call =>
            (call.query ?? '').includes('setTdlibParameters'),
          )
          if (!started || delivered) {
            return ''
          }
          delivered = true
          return JSON.stringify({
            '@type': 'updateAuthorizationState',
            '@client_id': 7,
            authorization_state: {
              '@type': 'authorizationStateWaitTdlibParameters',
            },
          })
        }
      }
      throw new Error(name)
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    Reflect.set(globalThis, 'createTdwebModule', () =>
      Promise.resolve({
        cwrap,
        FS: {
          mkdir: () => undefined,
          mount: () => undefined,
          syncfs: (_populate: boolean, callback: (error: unknown) => void) => {
            callback(null)
          },
          readdir: () => [],
          filesystems: { IDBFS: {} },
        },
      }),
    )
    const runtime = new TdWasmRuntime()
    await runtime.open('one', 1, 'a'.repeat(32))
    const createdAt = calls.findIndex(call => call.name === 'create')
    const parametersAt = calls.findIndex(call =>
      (call.query ?? '').includes('setTdlibParameters'),
    )
    expect(parametersAt).toBeGreaterThan(createdAt)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      calls.filter(call => (call.query ?? '').includes('setTdlibParameters')),
    ).toHaveLength(1)
  })

  test('a websocket message pumps receive before the idle poll', async () => {
    vi.useFakeTimers()
    let receives = 0
    const handlers = new Map<string, () => void>()
    const cwrap = (name: string) => {
      if (name === 'td_emscripten_execute') {
        return () => ok
      }
      if (name === 'td_emscripten_create_client_id') {
        return () => 7
      }
      if (name === 'td_emscripten_send') {
        return () => undefined
      }
      if (name === 'td_emscripten_receive') {
        return () => {
          receives += 1
          return ''
        }
      }
      throw new Error(name)
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    Reflect.set(globalThis, 'createTdwebModule', () =>
      Promise.resolve({
        cwrap,
        websocket: {
          on: (event: string, callback: () => void) => {
            handlers.set(event, callback)
          },
        },
        FS: {
          mkdir: () => undefined,
          mount: () => undefined,
          syncfs: (_populate: boolean, callback: (error: unknown) => void) => {
            callback(null)
          },
          readdir: () => [],
          filesystems: { IDBFS: {} },
        },
      }),
    )
    const runtime = new TdWasmRuntime()
    await runtime.open('one', 1, 'a'.repeat(32))
    await vi.advanceTimersByTimeAsync(0)
    const afterKick = receives
    expect(afterKick).toBeGreaterThan(0)
    handlers.get('message')?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(receives).toBeGreaterThan(afterKick)
    const pumped = receives
    await vi.advanceTimersByTimeAsync(50)
    expect(receives).toBe(pumped)
  })
})
