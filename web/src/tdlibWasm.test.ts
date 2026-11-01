import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  type Pointer,
  type Snapshot,
  assignSnapshot,
  chooseSnapshot,
  usableSnapshot,
} from './tdlibSnapshot'
import { TdWasmRuntime, nextReceiveDelay } from './tdlibWasm'

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
  Reflect.deleteProperty(globalThis, 'crmChatSeal')
})

describe('TDLib wasm receive delay', () => {
  test('runs a due scheduler turn immediately and caps the idle poll at 100ms', () => {
    expect(nextReceiveDelay(undefined)).toBe(100)
    expect(nextReceiveDelay(Number.NaN)).toBe(100)
    expect(nextReceiveDelay(0)).toBe(0)
    expect(nextReceiveDelay(-1)).toBe(0)
    expect(nextReceiveDelay(0.02)).toBe(20)
    expect(nextReceiveDelay(30)).toBe(100)
  })

  test('a due scheduler turn pumps receive before the idle poll', async () => {
    vi.useFakeTimers()
    let receives = 0
    let timeouts = 0
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
      if (name === 'td_emscripten_get_timeout') {
        return () => {
          timeouts += 1
          return timeouts === 1 ? 0 : 30
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
    await vi.advanceTimersToNextTimerAsync()
    const afterFirst = receives
    expect(afterFirst).toBeGreaterThan(0)
    expect(timeouts).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(receives).toBeGreaterThan(afterFirst)
    const hurried = receives
    await vi.advanceTimersByTimeAsync(50)
    expect(receives).toBe(hurried)
  })
})

describe('TDLib wasm log silence', () => {
  test('lowers log verbosity before a client or setTdlibParameters', async () => {
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
    // An empty stream aborts inside TDLib's logger when a warning is emitted.
    expect(executed.some(query => query.includes('logStreamDefault'))).toBe(
      true,
    )
    expect(executed.some(query => query.includes('logStreamEmpty'))).toBe(false)
    expect(executed.some(query => query.includes('setTdlibParameters'))).toBe(
      false,
    )
    const verbosityAt = executed.findIndex(query =>
      query.includes('setLogVerbosityLevel'),
    )
    expect(verbosityAt).toBeGreaterThanOrEqual(0)
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
    let owner: unknown
    const handlers = new Map<string, () => void>()
    const socket = {
      on(this: unknown, event: string, callback: () => void) {
        owner = this
        handlers.set(event, callback)
      },
    }
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
        websocket: socket,
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
    expect(owner).toBe(socket)
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

describe('TDLib wasm snapshots', () => {
  test.each(['directory', 'lookup', 'size'])(
    'a %s read failure cannot commit a partial account tree',
    async failure => {
      vi.useFakeTimers()
      vi.spyOn(document, 'querySelector').mockReturnValue(
        document.createElement('script'),
      )
      const database = new Uint8Array(512)
      database.set(new TextEncoder().encode('SQLite format 3\u0000'))
      database[16] = 2
      database[18] = 2
      let fault = false
      const commit = vi.fn(async () => undefined)
      Reflect.set(globalThis, 'createTdwebModule', () =>
        Promise.resolve({
          cwrap: (name: string) => {
            if (name === 'td_emscripten_execute') {
              return () => ok
            }
            if (name === 'td_emscripten_create_client_id') {
              return () => 1
            }
            return () => ''
          },
          FS: {
            mkdir: () => undefined,
            mount: () => undefined,
            filesystems: { IDBFS: {} },
            syncfs: (_populate: boolean, done: (error: unknown) => void) =>
              done(null),
            readdir: (path: string) => {
              if (fault && failure === 'directory') {
                throw new Error('unreadable directory')
              }
              return path === '/tdlib' ? ['db.sqlite', 'td.binlog'] : []
            },
            lookupPath: (path: string) => {
              if (path.endsWith('db.sqlite')) {
                return { node: { contents: database, mode: 33188 } }
              }
              if (fault && failure === 'lookup') {
                throw new Error('unreadable binlog')
              }
              return {
                node: {
                  contents: new Uint8Array([1]),
                  mode: 33188,
                  usedBytes: fault && failure === 'size' ? 2 : 1,
                },
              }
            },
            writeFile: () => undefined,
            unlink: () => undefined,
          },
        }),
      )
      const runtime = new TdWasmRuntime({
        commit,
        load: async () => undefined,
        legacyDirectories: async () => [],
      })
      await runtime.open('one', 1, 'a'.repeat(32))
      fault = true
      await expect(runtime.sync()).rejects.toThrow()
      expect(commit).not.toHaveBeenCalled()
    },
  )

  test('logout preserves an inactive account, then commits an empty tombstone without legacy fallback', async () => {
    vi.useFakeTimers()
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    const database = new Uint8Array(512)
    database.set(new TextEncoder().encode('SQLite format 3\u0000'))
    database[16] = 2
    database[18] = 2
    let saved: Snapshot | undefined
    let populates = 0
    const commits: Array<boolean | undefined> = []
    Reflect.set(globalThis, 'createTdwebModule', () => {
      const files = new Map<string, Uint8Array>()
      const responses: Array<string> = []
      let clientId = 0
      const node = (path: string) => ({
        contents: files.get(path),
        mode: files.has(path) ? 33188 : 16895,
      })
      return Promise.resolve({
        cwrap: (name: string) => {
          if (name === 'td_emscripten_execute') {
            return () => ok
          }
          if (name === 'td_emscripten_create_client_id') {
            return () => ++clientId
          }
          if (name === 'td_emscripten_send') {
            return (id: number, text: string) => {
              const query: Record<string, unknown> = JSON.parse(text)
              responses.push(
                JSON.stringify({ '@type': 'ok', '@extra': query['@extra'] }),
              )
              responses.push(
                JSON.stringify({
                  '@type': 'updateAuthorizationState',
                  '@client_id': id,
                  authorization_state: {
                    '@type':
                      query['@type'] === 'setTdlibParameters'
                        ? 'authorizationStateReady'
                        : 'authorizationStateClosed',
                  },
                }),
              )
            }
          }
          if (name === 'td_emscripten_receive') {
            return () => responses.shift() ?? ''
          }
          return () => 0.1
        },
        FS: {
          mkdir: () => undefined,
          mount: () => undefined,
          filesystems: { IDBFS: {} },
          syncfs: (populate: boolean, done: (error: unknown) => void) => {
            if (populate) {
              populates += 1
              for (const id of ['first', 'second']) {
                files.set(`/tdlib/${id}/db.sqlite`, database.slice())
              }
            }
            done(null)
          },
          readdir: (path: string) => [
            ...new Set(
              [...files.keys()]
                .filter(key => key.startsWith(`${path}/`))
                .map(key => key.slice(path.length + 1).split('/')[0]),
            ),
          ],
          stat: (path: string) => {
            if (
              !files.has(path) &&
              ![...files.keys()].some(key => key.startsWith(`${path}/`))
            ) {
              throw new Error('ENOENT')
            }
            return node(path)
          },
          lookupPath: (path: string) => ({ node: node(path) }),
          writeFile: (path: string, bytes: Uint8Array) =>
            files.set(path, bytes.slice()),
          unlink: (path: string) => files.delete(path),
        },
      })
    })
    const snapshots = {
      load: async () => saved,
      commit: async (snapshot: Snapshot, forgetPrevious?: boolean) => {
        saved = snapshot
        commits.push(forgetPrevious)
      },
      legacyDirectories: async () => [],
    }
    const runtime = new TdWasmRuntime(snapshots)
    const first = await runtime.open('first', 1, 'a'.repeat(32))
    await vi.advanceTimersByTimeAsync(200)
    const firstLogout = first.logout()
    await vi.advanceTimersByTimeAsync(200)
    await firstLogout
    expect(saved?.files.map(file => file.path)).toEqual([
      '/tdlib/second/db.sqlite',
    ])
    expect(commits.at(-1)).toBe(true)
    const second = await runtime.open('second', 1, 'a'.repeat(32))
    await vi.advanceTimersByTimeAsync(200)
    const secondLogout = second.logout()
    await vi.advanceTimersByTimeAsync(200)
    await secondLogout
    expect(saved?.files).toEqual([])
    expect(saved?.closed).toBe(true)
    expect(commits.at(-1)).toBe(true)
    const reloaded = new TdWasmRuntime(snapshots)
    expect(await reloaded.restore(1, 'a'.repeat(32))).toEqual([])
    expect(populates).toBe(1)
  })

  test.each(['sync', 'second account'])(
    'recovery uses the newest complete tree after %s',
    async update => {
      vi.useFakeTimers()
      vi.spyOn(document, 'querySelector').mockReturnValue(
        document.createElement('script'),
      )
      const database = new Uint8Array(512)
      database.set(new TextEncoder().encode('SQLite format 3\u0000'))
      database[16] = 2
      database[18] = 2
      database[100] = 1
      let fault = false
      let modules = 0
      const restored: Array<number> = []
      Reflect.set(globalThis, 'createTdwebModule', () => {
        modules += 1
        const generation = modules
        let clientId = 0
        const responses: Array<string> = []
        return Promise.resolve({
          cwrap: (name: string) => {
            if (name === 'td_emscripten_execute') {
              return () => ok
            }
            if (name === 'td_emscripten_create_client_id') {
              return () => ++clientId
            }
            if (name === 'td_emscripten_send') {
              return (id: number) => {
                responses.push(
                  JSON.stringify({
                    '@type': 'updateAuthorizationState',
                    '@client_id': id,
                    authorization_state: { '@type': 'authorizationStateReady' },
                  }),
                )
              }
            }
            if (name === 'td_emscripten_receive') {
              return () => {
                if (fault && generation === 1) {
                  throw new Error('simulated receive fault')
                }
                return responses.shift() ?? ''
              }
            }
            return () => 0.1
          },
          FS: {
            mkdir: () => undefined,
            mount: () => undefined,
            filesystems: { IDBFS: {} },
            syncfs: (_populate: boolean, done: (error: unknown) => void) =>
              done(null),
            readdir: (path: string) => (path === '/tdlib' ? ['db.sqlite'] : []),
            lookupPath: () => ({ node: { contents: database, mode: 33188 } }),
            writeFile: (_path: string, bytes: Uint8Array) => {
              if (generation > 1) {
                restored.push(bytes[100] ?? 0)
              }
            },
          },
        })
      })
      const runtime = new TdWasmRuntime({
        load: async () => undefined,
        commit: async () => undefined,
        legacyDirectories: async () => [],
      })
      await runtime.open('first', 1, 'a'.repeat(32))
      await vi.advanceTimersByTimeAsync(200)
      database[100] = 2
      if (update === 'sync') {
        await runtime.sync()
      } else {
        await runtime.open('second', 1, 'a'.repeat(32))
        await vi.advanceTimersByTimeAsync(200)
      }
      fault = true
      await vi.advanceTimersByTimeAsync(500)
      expect(modules).toBe(2)
      expect(restored).toEqual([2])
    },
  )

  test('a save copies bytes and the next open does not sync the live filesystem', async () => {
    vi.useFakeTimers()
    const syncs: Array<boolean> = []
    const written: Array<{ path: string; first: number }> = []
    const records = new Map<string, Snapshot>()
    let pointer: Pointer | undefined
    const snapshots = {
      commit: async (snapshot: Snapshot) => {
        if (!usableSnapshot(snapshot)) {
          throw new Error(
            'could not sync the TDLib database: snapshot is incomplete',
          )
        }
        const assigned = assignSnapshot(pointer, snapshot)
        records.set(assigned.stored.id, assigned.stored)
        pointer = assigned.pointer
        if (assigned.drop !== undefined) {
          records.delete(assigned.drop)
        }
      },
      load: async () =>
        chooseSnapshot(
          pointer?.current === undefined
            ? undefined
            : records.get(pointer.current),
          pointer?.previous === undefined
            ? undefined
            : records.get(pointer.previous),
        ),
      legacyDirectories: async () => [],
    }
    const database = new Uint8Array(512)
    const magic = 'SQLite format 3\u0000'
    for (let index = 0; index < magic.length; index += 1) {
      database[index] = magic.charCodeAt(index)
    }
    database[16] = 0x02
    database[17] = 0x00
    database[18] = 2
    const filesystem = {
      mkdir: () => undefined,
      mount: () => undefined,
      syncfs: (populate: boolean, callback: (error: unknown) => void) => {
        syncs.push(populate)
        callback(null)
      },
      readdir: (path: string) =>
        path === '/tdlib' ? ['.', '..', 'db.sqlite'] : ['.', '..'],
      stat: () => ({ mode: 33188, mtime: new Date(5) }),
      readFile: () => {
        throw new Error('readFile opens the database TDLib is using')
      },
      lookupPath: () => ({
        node: {
          contents: database,
          usedBytes: database.length,
          mode: 33188,
          timestamp: 5,
        },
      }),
      writeFile: (path: string, data: Uint8Array) => {
        written.push({ path, first: data[0] ?? 0 })
      },
      unlink: () => undefined,
      filesystems: { IDBFS: {} },
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
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
        return () => ''
      }
      throw new Error(name)
    }
    Reflect.set(globalThis, 'createTdwebModule', () =>
      Promise.resolve({ cwrap, FS: filesystem }),
    )
    const first = new TdWasmRuntime(snapshots)
    await first.open('acct', 1, 'a'.repeat(32))
    expect(syncs).toEqual([true])
    await first.sync()
    expect(syncs).toEqual([true])
    const saved = database[0] ?? 0
    database[0] = 0
    written.length = 0
    const second = new TdWasmRuntime(snapshots)
    await second.open('acct', 1, 'a'.repeat(32))
    expect(syncs).toEqual([true])
    expect(written).toEqual([{ path: '/tdlib/db.sqlite', first: saved }])
  })

  test('a closed save does not pump receive again', async () => {
    vi.useFakeTimers()
    const database = new Uint8Array(512)
    const magic = 'SQLite format 3\u0000'
    for (let index = 0; index < magic.length; index += 1) {
      database[index] = magic.charCodeAt(index)
    }
    database[16] = 0x02
    database[17] = 0x00
    database[18] = 2
    let closeExtra = ''
    let delivered = false
    let receives = 0
    const filesystem = {
      mkdir: () => undefined,
      mount: () => undefined,
      syncfs: (_populate: boolean, callback: (error: unknown) => void) => {
        callback(null)
      },
      readdir: (path: string) =>
        path === '/tdlib' ? ['.', '..', 'db.sqlite'] : ['.', '..'],
      stat: () => ({ mode: 33188, mtime: new Date(5) }),
      readFile: () => database,
      writeFile: () => undefined,
      unlink: () => undefined,
      filesystems: { IDBFS: {} },
    }
    const snapshots = {
      commit: async () => undefined,
      load: async () => undefined,
      legacyDirectories: async () => [],
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    const cwrap = (name: string) => {
      if (name === 'td_emscripten_execute') {
        return () => ok
      }
      if (name === 'td_emscripten_create_client_id') {
        return () => 7
      }
      if (name === 'td_emscripten_send') {
        return (_clientId: unknown, query: unknown) => {
          const text = String(query)
          if (text.includes('"@type":"close"')) {
            const parsed: unknown = JSON.parse(text)
            if (typeof parsed === 'object' && parsed !== null) {
              const extra = Reflect.get(parsed, '@extra')
              closeExtra = typeof extra === 'string' ? extra : ''
            }
          }
        }
      }
      if (name === 'td_emscripten_receive') {
        return () => {
          receives += 1
          if (closeExtra !== '' && !delivered) {
            delivered = true
            return JSON.stringify({
              '@type': 'updateAuthorizationState',
              '@client_id': 7,
              '@extra': closeExtra,
              authorization_state: { '@type': 'authorizationStateClosing' },
            })
          }
          if (closeExtra !== '' && receives === 4) {
            database[100] = 42
            return JSON.stringify({
              '@type': 'updateAuthorizationState',
              '@client_id': 7,
              authorization_state: { '@type': 'authorizationStateClosed' },
            })
          }
          return ''
        }
      }
      throw new Error(name)
    }
    Reflect.set(globalThis, 'createTdwebModule', () =>
      Promise.resolve({ cwrap, FS: filesystem }),
    )
    const runtime = new TdWasmRuntime(snapshots)
    await runtime.open('acct', 1, 'a'.repeat(32))
    const sealing = runtime.seal()
    await vi.advanceTimersByTimeAsync(500)
    await sealing
    const settled = receives
    expect(delivered).toBe(true)
    expect(settled).toBe(4)
    expect(database[100]).toBe(42)
    await vi.advanceTimersByTimeAsync(200)
    expect(receives).toBe(settled)
  })

  test.each(['send', 'receive'])(
    'a %s trap cannot commit a snapshot marked closed',
    async faultAt => {
      vi.useFakeTimers()
      const failed: Array<string> = []
      const notes: Array<string> = []
      vi.spyOn(console, 'error').mockImplementation(message => {
        failed.push(String(message))
      })
      vi.spyOn(console, 'info').mockImplementation(message => {
        notes.push(String(message))
      })
      const database = new Uint8Array(512)
      const magic = 'SQLite format 3\u0000'
      for (let index = 0; index < magic.length; index += 1) {
        database[index] = magic.charCodeAt(index)
      }
      database[16] = 0x02
      database[17] = 0x00
      database[18] = 2
      let closeExtra = ''
      let delivered = false
      let committed: Uint8Array | undefined
      const filesystem = {
        mkdir: () => undefined,
        mount: () => undefined,
        syncfs: (_populate: boolean, callback: (error: unknown) => void) => {
          callback(null)
        },
        readdir: (path: string) =>
          path === '/tdlib' ? ['.', '..', 'db.sqlite'] : ['.', '..'],
        stat: () => ({ mode: 33188, mtime: new Date(5) }),
        readFile: () => new Uint8Array(database),
        writeFile: () => undefined,
        unlink: () => undefined,
        filesystems: { IDBFS: {} },
      }
      const snapshots = {
        commit: async (snapshot: { files: Array<{ bytes: Uint8Array }> }) => {
          committed = snapshot.files[0]?.bytes
        },
        load: async () => undefined,
        legacyDirectories: async () => [],
      }
      vi.spyOn(document, 'querySelector').mockReturnValue(
        document.createElement('script'),
      )
      const cwrap = (name: string) => {
        if (name === 'td_emscripten_execute') {
          return () => ok
        }
        if (name === 'td_emscripten_create_client_id') {
          return () => 7
        }
        if (name === 'td_emscripten_send') {
          return (_clientId: unknown, query: unknown) => {
            const text = String(query)
            if (text.includes('"@type":"close"')) {
              if (faultAt === 'send') {
                throw new Error('memory access out of bounds')
              }
              const parsed: unknown = JSON.parse(text)
              if (typeof parsed === 'object' && parsed !== null) {
                const extra = Reflect.get(parsed, '@extra')
                closeExtra = typeof extra === 'string' ? extra : ''
              }
            }
          }
        }
        if (name === 'td_emscripten_receive') {
          return () => {
            if (closeExtra !== '' && !delivered) {
              delivered = true
              return JSON.stringify({
                '@type': 'updateAuthorizationState',
                '@client_id': 7,
                '@extra': closeExtra,
                authorization_state: { '@type': 'authorizationStateClosing' },
              })
            }
            if (closeExtra !== '') {
              database[0] = 0
              throw new Error('memory access out of bounds')
            }
            return ''
          }
        }
        throw new Error(name)
      }
      Reflect.set(globalThis, 'createTdwebModule', () =>
        Promise.resolve({ cwrap, FS: filesystem }),
      )
      const runtime = new TdWasmRuntime(snapshots)
      await runtime.open('acct', 1, 'a'.repeat(32))
      const sealing = expect(runtime.seal()).rejects.toThrow(
        'snapshot not sealed',
      )
      await vi.advanceTimersByTimeAsync(100)
      await sealing
      expect(delivered).toBe(faultAt === 'receive')
      expect(
        failed.filter(line => line.startsWith('tdlib receive failed')),
      ).toEqual([])
      expect(committed).toBeUndefined()
      expect(database[0]).toBe(faultAt === 'receive' ? 0 : 83)
    },
  )
})

describe('TDLib wasm reopen', () => {
  test('a trap on the receive after Ready reopens once without logging', async () => {
    vi.useFakeTimers()
    const failed: Array<string> = []
    const notes: Array<string> = []
    vi.spyOn(console, 'error').mockImplementation(message => {
      failed.push(String(message))
    })
    vi.spyOn(console, 'info').mockImplementation(message => {
      notes.push(String(message))
    })
    let modules = 0
    const ready = JSON.stringify({
      '@type': 'updateAuthorizationState',
      '@client_id': 7,
      authorization_state: { '@type': 'authorizationStateReady' },
    })
    const receiveFor = (moduleIndex: number) => {
      let step = 0
      return () => {
        step += 1
        if (moduleIndex === 1) {
          if (step === 1) {
            return ready
          }
          if (step === 2) {
            return ''
          }
          throw new Error('memory access out of bounds')
        }
        if (moduleIndex >= 3) {
          throw new Error('memory access out of bounds')
        }
        if (step === 1) {
          return ready
        }
        if (step === 2 || step === 3) {
          return ''
        }
        throw new Error('memory access out of bounds')
      }
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    Reflect.set(globalThis, 'createTdwebModule', () => {
      modules += 1
      const receive = receiveFor(modules)
      return Promise.resolve({
        cwrap: (name: string) => {
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
            return receive
          }
          throw new Error(name)
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
      })
    })
    const runtime = new TdWasmRuntime()
    const account = await runtime.open('one', 1, 'a'.repeat(32))
    let opened: string | undefined
    const pending = account.untilOpened(30_000).then(phase => {
      opened = phase._tag
    })
    const receiveFailures = () =>
      failed.filter(line => line.startsWith('tdlib receive failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(account.phase._tag).toBe('Ready')
    expect(opened).toBeUndefined()
    expect(modules).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(receiveFailures()).toEqual([])
    expect(notes.filter(line => line.startsWith('tdlib reopen'))).toEqual([
      'tdlib reopen',
    ])
    expect(modules).toBe(2)
    expect(account.phase._tag).toBe('Opening')
    expect(opened).toBeUndefined()
    await vi.advanceTimersByTimeAsync(100)
    expect(account.phase._tag).toBe('Ready')
    expect(opened).toBeUndefined()
    expect(receiveFailures()).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(opened).toBe('Ready')
    expect(receiveFailures()).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(modules).toBe(3)
    expect(notes.filter(line => line.startsWith('tdlib reopen'))).toEqual([
      'tdlib reopen',
      'tdlib reopen',
    ])
    expect(receiveFailures()).toHaveLength(1)
  })

  test('a trap after Ready was published reopens twice on the same files', async () => {
    vi.useFakeTimers()
    const failed: Array<string> = []
    const notes: Array<string> = []
    vi.spyOn(console, 'error').mockImplementation(message => {
      failed.push(String(message))
    })
    vi.spyOn(console, 'info').mockImplementation(message => {
      notes.push(String(message))
    })
    let modules = 0
    const ready = JSON.stringify({
      '@type': 'updateAuthorizationState',
      '@client_id': 7,
      authorization_state: { '@type': 'authorizationStateReady' },
    })
    const receiveFor = (moduleIndex: number) => {
      let step = 0
      return () => {
        step += 1
        if (moduleIndex >= 3) {
          throw new Error('memory access out of bounds')
        }
        if (step === 1) {
          return ready
        }
        if (step === 2 || step === 3) {
          return ''
        }
        throw new Error('memory access out of bounds')
      }
    }
    vi.spyOn(document, 'querySelector').mockReturnValue(
      document.createElement('script'),
    )
    Reflect.set(globalThis, 'createTdwebModule', () => {
      modules += 1
      const receive = receiveFor(modules)
      return Promise.resolve({
        cwrap: (name: string) => {
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
            return receive
          }
          throw new Error(name)
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
      })
    })
    const runtime = new TdWasmRuntime()
    const account = await runtime.open('one', 1, 'a'.repeat(32))
    let opened: string | undefined
    const pending = account.untilOpened(30_000).then(phase => {
      opened = phase._tag
    })
    const receiveFailures = () =>
      failed.filter(line => line.startsWith('tdlib receive failed'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(opened).toBe('Ready')
    expect(modules).toBe(1)
    expect(receiveFailures()).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(receiveFailures()).toEqual([])
    expect(notes.filter(line => line.startsWith('tdlib reopen'))).toEqual([
      'tdlib reopen',
    ])
    expect(modules).toBe(2)
    await vi.advanceTimersByTimeAsync(300)
    expect(notes.filter(line => line.startsWith('tdlib reopen'))).toEqual([
      'tdlib reopen',
      'tdlib reopen',
    ])
    expect(modules).toBe(3)
    expect(receiveFailures()).toHaveLength(1)
  })
})
