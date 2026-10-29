import {
  TdAccount,
  type TdQuery,
  type TdSink,
  databaseDirectory,
  parametersQuery,
  validAccountId,
} from './tdlibProtocol'

const WASM_JS = '/tdlib/td_wasm.js'
const OPEN_TIMEOUT = 30_000

type Cwrap = (
  name: string,
  returnType: string | null,
  args: Array<string>,
) => (...args: Array<unknown>) => unknown

type SyncFs = {
  mkdir: (path: string) => void
  mount: (
    filesystem: unknown,
    options: Record<string, unknown>,
    path: string,
  ) => void
  filesystems: { IDBFS?: unknown }
  syncfs: (populate: boolean, callback: (error: unknown) => void) => void
  readdir: (path: string) => Array<string>
}

type TdModule = {
  cwrap: Cwrap
  FS: SyncFs
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isCwrap = (value: unknown): value is Cwrap => typeof value === 'function'

const isSyncFs = (value: unknown): value is SyncFs =>
  isRecord(value) &&
  typeof value['mkdir'] === 'function' &&
  typeof value['mount'] === 'function' &&
  typeof value['syncfs'] === 'function' &&
  typeof value['readdir'] === 'function' &&
  isRecord(value['filesystems'])

const isModule = (value: unknown): value is TdModule =>
  isRecord(value) && isCwrap(value['cwrap']) && isSyncFs(value['FS'])

const isFactory = (
  value: unknown,
): value is (options: Record<string, unknown>) => Promise<unknown> =>
  typeof value === 'function'

const mkdir = (fs: SyncFs, path: string): void => {
  try {
    fs.mkdir(path)
  } catch (_error) {
    // The directory is created again when an account is restored.
  }
}

const syncFailure = (error: unknown): Error => {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  if (detail === '') {
    return new Error('could not sync the TDLib database')
  }
  return new Error(`could not sync the TDLib database: ${detail}`)
}

const syncFs = (fs: SyncFs, populate: boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    fs.syncfs(populate, error => {
      if (error) {
        reject(syncFailure(error))
        return
      }
      resolve()
    })
  })

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`) !== null) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.onload = () => {
      resolve()
    }
    script.onerror = () => {
      reject(new Error('could not load TDLib'))
    }
    document.head.appendChild(script)
  })

type ClientSlot = {
  account: TdAccount
  apiHash: string
  apiId: number
  clientId: number
  directory: string
}

export class TdWasmRuntime {
  private module: TdModule | undefined
  private readonly slots = new Map<string, ClientSlot>()
  private readonly pending = new Map<string, (value: unknown) => void>()
  private extra = 0
  private syncTimer: ReturnType<typeof setInterval> | undefined
  private syncTail: Promise<void> = Promise.resolve()
  private lifecycleBound = false
  private opening: Promise<void> | undefined
  syncError: unknown = undefined

  private functions(): {
    create: () => number
    send: (clientId: number, query: string) => void
    receive: () => string
  } {
    const module = this.module
    if (module === undefined) {
      throw new Error('TDLib is not loaded')
    }
    const create = module.cwrap('td_emscripten_create_client_id', 'number', [])
    const send = module.cwrap('td_emscripten_send', null, ['number', 'string'])
    const receive = module.cwrap('td_emscripten_receive', 'string', [])
    return {
      create: () => {
        const id = create()
        return typeof id === 'number' ? id : 0
      },
      send: (clientId, query) => {
        send(clientId, query)
      },
      receive: () => {
        const value = receive()
        return typeof value === 'string' ? value : ''
      },
    }
  }

  private async openModule(): Promise<void> {
    if (this.module !== undefined) {
      return
    }
    if (this.opening !== undefined) {
      await this.opening
      return
    }
    this.opening = this.loadModule()
    try {
      await this.opening
    } finally {
      this.opening = undefined
    }
  }

  private async loadModule(): Promise<void> {
    await loadScript(WASM_JS)
    const factory = Reflect.get(globalThis, 'createTdwebModule')
    if (!isFactory(factory)) {
      throw new Error('could not load TDLib')
    }
    const created = await factory({
      locateFile: (path: string) => `/tdlib/${path}`,
    })
    if (!isModule(created)) {
      throw new Error('could not load TDLib')
    }
    const filesystem = created.FS.filesystems.IDBFS
    if (filesystem === undefined) {
      throw new Error('TDLib has no IndexedDB filesystem')
    }
    mkdir(created.FS, '/tdlib')
    created.FS.mount(filesystem, {}, '/tdlib')
    await syncFs(created.FS, true)
    this.module = created
    this.armSyncTimer()
    this.bindLifecycle()
    this.receiveSoon()
  }

  private receiveSoon(): void {
    setTimeout(() => {
      this.receive()
    }, 0)
  }

  private receive(): void {
    const functions = this.functions()
    for (;;) {
      const raw = functions.receive()
      if (raw === '') {
        break
      }
      const value: unknown = JSON.parse(raw)
      if (!isRecord(value)) {
        continue
      }
      const extra = value['@extra']
      if (typeof extra === 'string') {
        const waiter = this.pending.get(extra)
        if (waiter !== undefined) {
          this.pending.delete(extra)
          waiter(value)
        }
      }
      const clientId = value['@client_id']
      if (typeof clientId !== 'number') {
        continue
      }
      for (const slot of this.slots.values()) {
        if (slot.clientId === clientId) {
          this.onUpdate(slot, value)
        }
      }
    }
    setTimeout(() => {
      this.receive()
    }, 100)
  }

  private onUpdate(slot: ClientSlot, value: Record<string, unknown>): void {
    const state = value['authorization_state']
    if (
      value['@type'] === 'updateAuthorizationState' &&
      isRecord(state) &&
      state['@type'] === 'authorizationStateWaitTdlibParameters'
    ) {
      const filesystem = this.module?.FS
      if (filesystem !== undefined) {
        mkdir(filesystem, slot.directory)
        mkdir(filesystem, `${slot.directory}/files`)
      }
      void this.dispatch(
        slot.clientId,
        parametersQuery(slot.directory, slot.apiId, slot.apiHash),
      ).catch(() => {
        slot.account.apply({
          '@type': 'updateAuthorizationState',
          authorization_state: {
            '@type': 'authorizationStateClosed',
          },
        })
      })
      return
    }
    const wasReady = slot.account.phase._tag === 'Ready'
    slot.account.apply(value)
    if (!wasReady && slot.account.phase._tag === 'Ready') {
      this.flushSoon()
    }
  }

  private dispatch(clientId: number, query: TdQuery): Promise<unknown> {
    const extra = `q${this.extra}`
    this.extra += 1
    const functions = this.functions()
    return new Promise(resolve => {
      this.pending.set(extra, resolve)
      functions.send(clientId, JSON.stringify({ ...query, '@extra': extra }))
      this.receiveSoon()
      setTimeout(() => {
        if (!this.pending.has(extra)) {
          return
        }
        this.pending.delete(extra)
        resolve({ '@type': 'error', message: 'REQUEST_FAILED' })
      }, OPEN_TIMEOUT)
    })
  }

  async open(id: string, apiId: number, apiHash: string): Promise<TdAccount> {
    if (!validAccountId(id) || apiId <= 0 || apiHash.length !== 32) {
      throw new Error('API_ID_INVALID')
    }
    const existing = this.slots.get(id)
    if (existing !== undefined) {
      return existing.account
    }
    await this.openModule()
    const clientId = this.functions().create()
    const directory = databaseDirectory(id)
    const sink: TdSink = {
      send: query => this.dispatch(clientId, query),
      close: async () => {
        this.slots.delete(id)
        const filesystem = this.module?.FS
        if (filesystem !== undefined) {
          await syncFs(filesystem, false)
        }
      },
    }
    const account = new TdAccount(sink, id)
    this.slots.set(id, { account, apiHash, apiId, clientId, directory })
    this.functions().send(
      clientId,
      JSON.stringify({
        '@type': 'setLogVerbosityLevel',
        new_verbosity_level: 0,
      }),
    )
    this.receiveSoon()
    return account
  }

  async restore(apiId: number, apiHash: string): Promise<Array<TdAccount>> {
    await this.openModule()
    const filesystem = this.module?.FS
    if (filesystem === undefined) {
      return []
    }
    await syncFs(filesystem, true)
    const ids = filesystem
      .readdir('/tdlib')
      .filter(name => name !== '.' && name !== '..' && validAccountId(name))
      .sort()
    const accounts: Array<TdAccount> = []
    for (const id of ids) {
      const account = await this.open(id, apiId, apiHash)
      const phase = await account
        .untilOpened(OPEN_TIMEOUT)
        .catch(() => account.phase)
      if (phase._tag === 'Ready') {
        accounts.push(account)
      } else {
        await account.discard()
      }
    }
    return accounts
  }

  private flushSoon(): void {
    void this.sync().catch(error => {
      this.syncError = error
    })
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound) {
      return
    }
    this.lifecycleBound = true
    window.addEventListener('pagehide', () => {
      this.flushSoon()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushSoon()
      }
    })
  }

  private clearSyncTimer(): void {
    if (this.syncTimer === undefined) {
      return
    }
    clearInterval(this.syncTimer)
    this.syncTimer = undefined
  }

  private armSyncTimer(): void {
    this.clearSyncTimer()
    if (this.module === undefined) {
      return
    }
    this.syncTimer = setInterval(() => {
      this.flushSoon()
    }, 5000)
  }

  async sync(): Promise<void> {
    const run = this.syncTail.then(async () => {
      const filesystem = this.module?.FS
      if (filesystem === undefined) {
        return
      }
      this.clearSyncTimer()
      try {
        await syncFs(filesystem, false)
        this.syncError = undefined
      } catch (error) {
        const failure = error instanceof Error ? error : syncFailure(error)
        this.syncError = failure
        throw failure
      } finally {
        this.armSyncTimer()
      }
    })
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

export const browserRuntime = new TdWasmRuntime()
