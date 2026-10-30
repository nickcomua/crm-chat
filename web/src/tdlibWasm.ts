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
const IDLE_RECEIVE_MS = 100

// A timeout at or below zero means TDLib's scheduler is already due. The
// official worker runs that turn immediately. Parking it on the idle poll
// stretches a few hundred turns into the long pause after QR approval.
export const nextReceiveDelay = (
  timeoutSeconds: number | undefined,
): number => {
  if (timeoutSeconds === undefined || Number.isNaN(timeoutSeconds)) {
    return IDLE_RECEIVE_MS
  }
  if (timeoutSeconds <= 0) {
    return 0
  }
  return Math.min(timeoutSeconds * 1000, IDLE_RECEIVE_MS)
}

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
  stat?: (path: string) => { mode?: number; mtime?: Date }
  unlink?: (path: string) => void
}

type TdModule = {
  cwrap: Cwrap
  FS: SyncFs
  websocket?: SocketWake
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

const DIRECTORY_MODE = 16384
const MODE_TYPE = 61440

const directoryTime = (filesystem: SyncFs, id: string): number => {
  const stat = filesystem.stat
  if (stat === undefined) {
    return 0
  }
  let newest = 0
  const visit = (path: string, depth: number): void => {
    if (depth > 6) {
      return
    }
    let info: { mode?: number; mtime?: Date }
    try {
      info = stat(path)
    } catch {
      return
    }
    const time = info.mtime instanceof Date ? info.mtime.getTime() : 0
    if (time > newest) {
      newest = time
    }
    if (((info.mode ?? 0) & MODE_TYPE) !== DIRECTORY_MODE) {
      return
    }
    let names: Array<string> = []
    try {
      names = filesystem.readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') {
        continue
      }
      visit(`${path}/${name}`, depth + 1)
    }
  }
  visit(databaseDirectory(id), 0)
  return newest
}

// SQLite's -shm file is shared memory from the last process. Copying it into
// a new browser makes TDLib abort after Ready. The wal is enough to recover.
const dropSharedMemory = (filesystem: SyncFs): void => {
  const unlink = filesystem.unlink
  if (unlink === undefined) {
    return
  }
  const visit = (path: string, depth: number): void => {
    if (depth > 6) {
      return
    }
    let names: Array<string> = []
    try {
      names = filesystem.readdir(path)
    } catch {
      return
    }
    for (const name of names) {
      if (name === '.' || name === '..') {
        continue
      }
      const child = `${path}/${name}`
      if (name.endsWith('-shm')) {
        try {
          unlink(child)
        } catch {
          // The file can already be gone after a previous populate.
        }
        continue
      }
      visit(child, depth + 1)
    }
  }
  visit('/tdlib', 0)
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

type SocketWake = {
  on?: (event: string, callback: () => void) => void
}

type ClientSlot = {
  account: TdAccount
  apiHash: string
  apiId: number
  clientId: number
  directory: string
  parametersSent: boolean
}

export class TdWasmRuntime {
  private module: TdModule | undefined
  private readonly slots = new Map<string, ClientSlot>()
  private readonly pending = new Map<string, (value: unknown) => void>()
  private extra = 0
  private syncTimer: ReturnType<typeof setInterval> | undefined
  private syncTail: Promise<void> = Promise.resolve()
  private syncing = false
  private lifecycleBound = false
  private opening: Promise<void> | undefined
  private receiveQueued = false
  private receiveTimer: ReturnType<typeof setTimeout> | undefined
  syncError: unknown = undefined

  private functions(): {
    create: () => number
    execute: (query: string) => string
    send: (clientId: number, query: string) => void
    receive: () => string
  } {
    const module = this.module
    if (module === undefined) {
      throw new Error('TDLib is not loaded')
    }
    const create = module.cwrap('td_emscripten_create_client_id', 'number', [])
    const execute = module.cwrap('td_emscripten_execute', 'string', ['string'])
    const send = module.cwrap('td_emscripten_send', null, ['number', 'string'])
    const receive = module.cwrap('td_emscripten_receive', 'string', [])
    return {
      create: () => {
        const id = create()
        return typeof id === 'number' ? id : 0
      },
      execute: query => {
        const value = execute(query)
        return typeof value === 'string' ? value : ''
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

  private silenceLogs(): void {
    const execute = this.functions().execute
    const queries = [
      { '@type': 'setLogVerbosityLevel', new_verbosity_level: 0 },
      {
        '@type': 'setLogStream',
        log_stream: { '@type': 'logStreamEmpty' },
      },
    ]
    for (const query of queries) {
      const raw = execute(JSON.stringify(query))
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        throw new Error('could not silence TDLib logs')
      }
      if (!isRecord(value) || value['@type'] !== 'ok') {
        throw new Error('could not silence TDLib logs')
      }
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
    this.module = created
    await this.enqueueSync(true)
    dropSharedMemory(created.FS)
    this.silenceLogs()
    this.armSyncTimer()
    this.bindLifecycle()
    this.bindSocketWake()
    this.receiveSoon()
  }

  // Emscripten 3.1.1 delivers socket bytes on Module.websocket. TDLib only
  // reads them inside td_emscripten_receive, so a socket event has to pump
  // the loop instead of waiting for the idle poll.
  private bindSocketWake(): void {
    const socket = this.module?.websocket
    const wake = socket?.on
    if (socket === undefined || wake === undefined) {
      return
    }
    const pump = () => {
      this.receiveSoon()
    }
    for (const event of [
      'open',
      'message',
      'error',
      'close',
      'connection',
      'listen',
    ]) {
      // SOCKFS.mount stores one callback on the socket object. A bare call
      // would file it on the wrong `this`, and a later mount clears it.
      wake.call(socket, event, pump)
    }
  }

  private scheduleReceive(delay: number): void {
    if (this.receiveQueued) {
      return
    }
    this.receiveQueued = true
    this.receiveTimer = setTimeout(() => {
      this.receiveTimer = undefined
      this.receiveQueued = false
      this.receive()
    }, delay)
  }

  private receiveSoon(): void {
    if (this.receiveTimer !== undefined) {
      clearTimeout(this.receiveTimer)
      this.receiveTimer = undefined
      this.receiveQueued = false
    }
    this.scheduleReceive(0)
  }

  private mainTimeout(): number | undefined {
    const module = this.module
    if (module === undefined) {
      return undefined
    }
    try {
      const wrapped = module.cwrap('td_emscripten_get_timeout', 'number', [])
      const value = wrapped()
      return typeof value === 'number' ? value : undefined
    } catch {
      return undefined
    }
  }

  private receive(): void {
    // IndexedDB copies the database files straight out of wasm memory. A
    // receive turn in the middle of that copy grows the heap and TDLib then
    // faults with "memory access out of bounds".
    if (this.syncing) {
      this.scheduleReceive(50)
      return
    }
    this.bindSocketWake()
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
    this.scheduleReceive(nextReceiveDelay(this.mainTimeout()))
  }

  // TDLib creates the client on the first request and emits nothing before
  // that, including authorizationStateWaitTdlibParameters. Parameters have to
  // be that first request; waiting for the update never opens a socket.
  private sendParameters(slot: ClientSlot): void {
    if (slot.parametersSent) {
      return
    }
    slot.parametersSent = true
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
  }

  private onUpdate(slot: ClientSlot, value: Record<string, unknown>): void {
    const state = value['authorization_state']
    if (value['@type'] === 'updateAuthorizationState' && isRecord(state)) {
      const name = state['@type']
      if (typeof name === 'string' && name.startsWith('authorizationState')) {
        console.info(`tdlib auth ${name}`)
      }
    }
    if (
      value['@type'] === 'updateAuthorizationState' &&
      isRecord(state) &&
      state['@type'] === 'authorizationStateWaitTdlibParameters'
    ) {
      this.sendParameters(slot)
      return
    }
    slot.account.apply(value)
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
    this.silenceLogs()
    const clientId = this.functions().create()
    const directory = databaseDirectory(id)
    const sink: TdSink = {
      send: query => this.dispatch(clientId, query),
      close: async () => {
        this.slots.delete(id)
        await this.sync()
      },
      drop: async () => {
        this.slots.delete(id)
      },
      sync: () => this.sync(),
    }
    const account = new TdAccount(sink, id)
    const slot: ClientSlot = {
      account,
      apiHash,
      apiId,
      clientId,
      directory,
      parametersSent: false,
    }
    this.slots.set(id, slot)
    this.sendParameters(slot)
    this.receiveSoon()
    return account
  }

  async restore(apiId: number, apiHash: string): Promise<Array<TdAccount>> {
    await this.openModule()
    const filesystem = this.module?.FS
    if (filesystem === undefined) {
      return []
    }
    await this.enqueueSync(true)
    dropSharedMemory(filesystem)
    const ids = filesystem
      .readdir('/tdlib')
      .filter(name => name !== '.' && name !== '..' && validAccountId(name))
      .sort((left, right) => {
        const newer =
          directoryTime(filesystem, right) - directoryTime(filesystem, left)
        if (newer !== 0) {
          return newer
        }
        return left < right ? -1 : left > right ? 1 : 0
      })
    // Each login keeps its own directory. Opening a leftover and logging it
    // out used to discard the signed-in database and return the page to the QR
    // screen. Keep the newest one that is already authorized, and close the
    // others without logOut so their files stay put.
    for (const id of ids) {
      const account = await this.open(id, apiId, apiHash)
      const phase = await account
        .untilOpened(OPEN_TIMEOUT)
        .catch(() => account.phase)
      if (phase._tag === 'Ready') {
        return [account]
      }
      await account.release()
    }
    return []
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
    // A sync that starts while the document is unloading writes a partial
    // IndexedDB. The next visit then opens a torn database and TDLib aborts.
    // The login sync and the interval below finish while the page is alive.
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
      const ready = [...this.slots.values()].some(
        slot => slot.account.phase._tag === 'Ready',
      )
      if (!ready) {
        return
      }
      this.flushSoon()
    }, 5000)
  }

  private enqueueSync(populate: boolean): Promise<void> {
    const run = this.syncTail.then(async () => {
      const filesystem = this.module?.FS
      if (filesystem === undefined) {
        return
      }
      this.clearSyncTimer()
      this.syncing = true
      document.documentElement.dataset['tdlibSync'] = '1'
      try {
        await syncFs(filesystem, populate)
        if (!populate) {
          this.syncError = undefined
          console.info('tdlib sync saved')
        }
      } catch (error) {
        const failure = error instanceof Error ? error : syncFailure(error)
        this.syncError = failure
        throw failure
      } finally {
        this.syncing = false
        document.documentElement.dataset['tdlibSync'] = '0'
        this.armSyncTimer()
        this.receiveSoon()
      }
    })
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async sync(): Promise<void> {
    return this.enqueueSync(false)
  }
}

export const browserRuntime = new TdWasmRuntime()
