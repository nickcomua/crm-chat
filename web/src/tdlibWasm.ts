import {
  RUNTIME_REOPEN,
  TdAccount,
  type TdQuery,
  type TdSink,
  databaseDirectory,
  parametersQuery,
  validAccountId,
} from './tdlibProtocol'
import {
  type LegacyDirectory,
  type Snapshot,
  type SnapshotFile,
  assessFiles,
  commitSnapshot,
  loadSnapshot,
  readLegacyDirectories,
  settleSnapshotFiles,
} from './tdlibSnapshot'

const WASM_JS = '/tdlib/td_wasm.js'
const OPEN_TIMEOUT = 30_000
const IDLE_RECEIVE_MS = 100
// A fresh login can fault twice after Ready: the dialog-filter check, then
// malloc on the reopened instance. A third fault is logged.
const RECEIVE_RECOVERIES = 2

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
  rmdir?: (path: string) => void
  readFile?: (path: string) => Uint8Array
  writeFile?: (path: string, data: Uint8Array) => void
  utime?: (path: string, atime: number, mtime: number) => void
  // Reading the node avoids FS.open. A second handle on a database TDLib has
  // open makes SQLite abort() on the next receive.
  lookupPath?: (path: string) => { node?: MemNode }
}

type MemNode = {
  contents?: Uint8Array | object
  usedBytes?: number
  mode?: number
  timestamp?: number
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

const FILE_MODE = 33188

const canSnapshot = (filesystem: SyncFs): boolean =>
  filesystem.writeFile !== undefined &&
  (filesystem.lookupPath !== undefined || filesystem.readFile !== undefined)

const copyNodeBytes = (node: MemNode): Uint8Array | undefined => {
  const contents = node.contents
  if (!(contents instanceof Uint8Array)) {
    return undefined
  }
  const used = node.usedBytes ?? contents.length
  const copy = new Uint8Array(used)
  copy.set(contents.subarray(0, Math.min(used, contents.length)))
  return copy
}

const mkdirParents = (filesystem: SyncFs, path: string): void => {
  const parts = path.split('/').filter(part => part !== '')
  let current = ''
  for (const part of parts) {
    current = `${current}/${part}`
    mkdir(filesystem, current)
  }
}

const captureTree = (filesystem: SyncFs): Array<SnapshotFile> | undefined => {
  const lookup = filesystem.lookupPath
  const readFile = filesystem.readFile
  const stat = filesystem.stat
  if (lookup === undefined && (readFile === undefined || stat === undefined)) {
    return undefined
  }
  const files: Array<SnapshotFile> = []
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
      if (name === '.' || name === '..' || name.endsWith('-shm')) {
        continue
      }
      const child = `${path}/${name}`
      if (lookup !== undefined) {
        let node: MemNode | undefined
        try {
          node = lookup(child).node
        } catch {
          continue
        }
        if (node === undefined) {
          continue
        }
        const mode = node.mode ?? FILE_MODE
        if ((mode & MODE_TYPE) === DIRECTORY_MODE) {
          visit(child, depth + 1)
          continue
        }
        const copy = copyNodeBytes(node)
        if (copy === undefined) {
          continue
        }
        files.push({
          path: child,
          bytes: copy,
          mtime: node.timestamp ?? 0,
          mode,
        })
        continue
      }
      if (readFile === undefined || stat === undefined) {
        continue
      }
      let info: { mode?: number; mtime?: Date }
      try {
        info = stat(child)
      } catch {
        continue
      }
      if (((info.mode ?? 0) & MODE_TYPE) === DIRECTORY_MODE) {
        visit(child, depth + 1)
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = readFile(child)
      } catch {
        continue
      }
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const mtime = info.mtime instanceof Date ? info.mtime.getTime() : 0
      files.push({
        path: child,
        bytes: copy,
        mtime,
        mode: info.mode ?? FILE_MODE,
      })
    }
  }
  visit('/tdlib', 0)
  return files
}

const installSettled = (
  filesystem: SyncFs,
  files: ReadonlyArray<SnapshotFile>,
  grow = true,
): { files: number; checkpointed: boolean; reason: string; detail: string } => {
  const settled = settleSnapshotFiles(files, grow)
  materialize(filesystem, settled.files)
  if (!settled.checkpointed) {
    return {
      files: settled.files.length,
      checkpointed: false,
      reason: settled.reason,
      detail: settled.detail,
    }
  }
  const kept = new Set(settled.files.map(file => file.path))
  const unlink = filesystem.unlink
  if (unlink !== undefined) {
    for (const file of files) {
      if (kept.has(file.path)) {
        continue
      }
      try {
        unlink(file.path)
      } catch {
        // The wal is absent until TDLib creates it on this filesystem.
      }
    }
  }
  return {
    files: settled.files.length,
    checkpointed: true,
    reason: '',
    detail: settled.detail,
  }
}

const materialize = (
  filesystem: SyncFs,
  files: ReadonlyArray<SnapshotFile>,
): void => {
  const writeFile = filesystem.writeFile
  if (writeFile === undefined) {
    return
  }
  for (const file of files) {
    if (!file.path.startsWith('/tdlib/') || file.path.endsWith('-shm')) {
      continue
    }
    mkdirParents(filesystem, file.path.slice(0, file.path.lastIndexOf('/')))
    writeFile(file.path, file.bytes)
    filesystem.utime?.(file.path, file.mtime, file.mtime)
  }
}

const pathExists = (filesystem: SyncFs, path: string): boolean => {
  const stat = filesystem.stat
  if (stat === undefined) {
    return false
  }
  try {
    stat(path)
    return true
  } catch {
    return false
  }
}

// An empty directory is a leftover login with nothing to open. TDLib only
// has a session once it has written the binlog or the sqlite database.
const hasSavedDatabase = (filesystem: SyncFs, id: string): boolean => {
  const directory = databaseDirectory(id)
  return (
    pathExists(filesystem, `${directory}/db.sqlite`) ||
    pathExists(filesystem, `${directory}/td.binlog`)
  )
}

const removeTree = (filesystem: SyncFs, path: string): void => {
  const unlink = filesystem.unlink
  if (unlink === undefined) {
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
    let mode = 0
    try {
      mode = filesystem.stat?.(child)?.mode ?? 0
    } catch {
      mode = 0
    }
    if ((mode & MODE_TYPE) === DIRECTORY_MODE) {
      removeTree(filesystem, child)
      try {
        filesystem.rmdir?.(child)
      } catch {
        // The directory can already be gone.
      }
      continue
    }
    try {
      unlink(child)
    } catch {
      // The file can already be gone.
    }
  }
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

type SnapshotIO = {
  commit: (snapshot: Snapshot) => Promise<void>
  load: () => Promise<Snapshot | undefined>
  legacyDirectories: () => Promise<Array<LegacyDirectory>>
}

const indexedSnapshots = (): SnapshotIO => ({
  commit: commitSnapshot,
  load: loadSnapshot,
  legacyDirectories: readLegacyDirectories,
})

export class TdWasmRuntime {
  private readonly snapshots: SnapshotIO
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
  // close() starts TDLib's destructor. A later receive() walks freed wasm
  // memory ("memory access out of bounds") or re-enters the scheduler
  // ("!scheduler_->has_guard_"). Stay paused until the next open().
  private receivePaused = false
  // The newest wal commit sometimes appends a page that makes a receive
  // trap in free() after Ready. The first open folds that page in. A trap
  // before that open is published reopens once without growing. A later
  // trap, after the chat list is up, is usually a corrupt malloc heap in
  // the same instance, so it also reopens once on the same files. The
  // second trap is logged.
  private foldGrow = true
  private openSettled = false
  private recoveries = 0
  // Copied the moment Ready is confirmed, before a later receive can abort.
  // The reopen loads this instead of an empty IndexedDB.
  private hotFiles: Array<SnapshotFile> | undefined
  // Accounts whose files stay in the snapshot while another login owns the
  // only wasm instance. Two clients on one instance share one Emscripten
  // socket callback, so a second QR approval never reaches TDLib.
  private readonly parked = new Map<
    string,
    { apiId: number; apiHash: string }
  >()
  // Files for accounts that are not open on this instance. A fresh login
  // must not mount them: loadChats then stalls beside the other database.
  private stashed: Array<SnapshotFile> | undefined
  private isolateNext = false
  // The Ready transition's files are an incomplete database. Persisting them
  // and reopening after the next trap comes back as a new phone login.
  // Stay false until a sync that follows the chat-list read.
  private chatListDurable = false
  // Snapshot taken before the trapping receive. Used when the post-trap
  // copy reopens as a new phone login.
  private fallbackHot: Array<SnapshotFile> | undefined
  private reopenTail: Promise<void> | undefined
  // Bytes copied before close. Used when the destructor receive traps, so the
  // saved snapshot is not the half-destroyed filesystem.
  private sealedFiles: Array<SnapshotFile> | undefined
  private closeClean = true
  syncError: unknown = undefined

  constructor(snapshots?: SnapshotIO) {
    this.snapshots = snapshots ?? indexedSnapshots()
  }

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
    // Verbosity 0 hides traffic and message text. logStreamEmpty leaves a null
    // writer, and the wasm logger then traps on the next warning
    // ("table index is out of bounds" / Aborted()). logStreamDefault is stderr.
    const execute = this.functions().execute
    const queries = [
      {
        '@type': 'setLogStream',
        log_stream: { '@type': 'logStreamDefault' },
      },
      { '@type': 'setLogVerbosityLevel', new_verbosity_level: 0 },
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
    // Populate before any td_* call. syncfs while TDLib is running replaces
    // the live file buffers and the next receive faults.
    const isolate = this.isolateNext
    this.isolateNext = false
    const snapshotCapable = canSnapshot(created.FS)
    const held = isolate || !snapshotCapable ? undefined : this.hotFiles
    const snapshot =
      held !== undefined && held.length > 0
        ? { files: held }
        : snapshotCapable && !isolate
          ? await this.snapshots.load().catch(() => undefined)
          : undefined
    const installed =
      snapshot !== undefined && snapshot.files.length > 0
        ? installSettled(created.FS, snapshot.files, this.foldGrow)
        : undefined
    console.info(
      isolate
        ? 'tdlib snapshot parked'
        : installed !== undefined
          ? `tdlib snapshot files=${installed.files}${installed.checkpointed ? ' checkpointed' : ''}${installed.detail === '' ? '' : ` ${installed.detail}`}${installed.reason === '' ? '' : ` skip=${installed.reason}`}`
          : 'tdlib snapshot missing',
    )
    if (installed !== undefined) {
      const extras = await this.snapshots.legacyDirectories().catch(() => [])
      for (const extra of extras) {
        if (pathExists(created.FS, extra.path)) {
          continue
        }
        mkdirParents(created.FS, extra.path)
        created.FS.utime?.(extra.path, extra.mtime, extra.mtime)
      }
    } else if (!isolate) {
      await this.enqueueSync(true)
      const captured = snapshotCapable ? captureTree(created.FS) : undefined
      const databases =
        captured?.filter(
          file =>
            file.path.endsWith('.sqlite') && !file.path.endsWith('.sqlite-wal'),
        ) ?? []
      if (captured !== undefined && databases.length > 0) {
        const settled = settleSnapshotFiles(captured)
        if (!assessFiles(settled.files).ok) {
          removeTree(created.FS, '/tdlib')
        } else if (settled.checkpointed) {
          installSettled(created.FS, captured)
        }
      }
    }
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

  private haltReceive(): void {
    this.receivePaused = true
    if (this.receiveTimer !== undefined) {
      clearTimeout(this.receiveTimer)
      this.receiveTimer = undefined
      this.receiveQueued = false
    }
  }

  private scheduleReceive(delay: number): void {
    if (this.receivePaused || this.receiveQueued) {
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

  private reportReceiveError(error: unknown): void {
    // A trap leaves the scheduler guard held, so the next receive prints
    // "!scheduler_->has_guard_" and aborts again. Stop the loop.
    this.haltReceive()
    const name = error instanceof Error ? error.name : 'Error'
    const message = error instanceof Error ? error.message : String(error)
    const stack =
      error instanceof Error && typeof error.stack === 'string'
        ? error.stack.split('\n').slice(0, 12).join(' | ')
        : ''
    console.error(
      `tdlib receive failed: ${name}: ${message}${stack === '' ? '' : ` | ${stack}`}`,
    )
  }

  private receive(): void {
    // A snapshot copies the sqlite files while TDLib is paused. receive is
    // the only thing that writes them. IDBFS syncfs is worse: its save
    // replaces the live MEMFS buffers and the next receive aborts.
    if (this.receivePaused || this.module === undefined) {
      return
    }
    if (this.syncing) {
      this.scheduleReceive(50)
      return
    }
    try {
      this.pumpReceive()
    } catch (error) {
      // Before Ready is published, drop the appended wal page. Afterwards
      // keep the bytes: the heap, not the fold, is what just faulted.
      if (this.recoveries < RECEIVE_RECOVERIES && this.slots.size > 0) {
        this.recoveries += 1
        const keepGrow = this.openSettled
        this.haltReceive()
        // The receive that trapped may have flushed the auth key into the
        // files after the earlier copy. Keep that earlier copy only if this
        // one reopens as a new phone login.
        if (!this.chatListDurable) {
          const previous = this.hotFiles
          this.rememberHotSnapshot()
          if (this.hotFiles !== previous) {
            this.fallbackHot = previous
          }
        }
        void this.reopenAfterFault(keepGrow)
        return
      }
      this.reportReceiveError(error)
    }
  }

  // td_send only queues close. The Td destructor, including the SQLite
  // checkpoint, runs inside the td_receive that sees authorizationStateClosed.
  // That call returns empty: ClientManager swallows the update and destroys
  // the actor. The next receive walks the freed scheduler and traps in free().
  private finishClose(): void {
    const functions = this.functions()
    this.receivePaused = true
    for (let step = 0; step < 64; step += 1) {
      let raw = ''
      try {
        raw = functions.receive()
      } catch {
        // The destructor receive can trap after a folded database has already
        // served the chat list. The page is going away. Keep the pre-close
        // copy instead of logging a receive failure the reload would inherit.
        this.closeClean = false
        console.info('tdlib close stopped')
        return
      }
      if (raw === '') {
        return
      }
    }
  }

  private pumpReceive(): void {
    this.bindSocketWake()
    const functions = this.functions()
    // Sample before the loop. The pump that first applies Ready must not
    // count as settled: the free() trap is the receive after that apply.
    const startedReady = [...this.slots.values()].some(
      slot => slot.account.phase._tag === 'Ready',
    )
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
    if (startedReady) {
      // Keep the newest files until the chat list is saved. The first
      // post-Ready copy can still be missing the auth key.
      if (!this.openSettled || !this.chatListDurable) {
        this.rememberHotSnapshot()
      }
      this.openSettled = true
      for (const slot of this.slots.values()) {
        slot.account.releaseReady()
      }
    } else {
      for (const slot of this.slots.values()) {
        slot.account.holdReady()
      }
    }
    this.scheduleReceive(nextReceiveDelay(this.mainTimeout()))
  }

  private rememberHotSnapshot(): void {
    const filesystem = this.module?.FS
    if (filesystem === undefined || !canSnapshot(filesystem)) {
      return
    }
    try {
      const captured = captureTree(filesystem)
      if (captured !== undefined && captured.length > 0) {
        this.hotFiles = captured
      }
    } catch {
      // Keep the previous copy when this one cannot be read.
    }
  }

  // Drop this wasm instance and open the saved files on a new one.
  // keepGrow is false only when Ready was not published yet: that trap is
  // the appended wal page. A trap after the chat list is up keeps the fold.
  private async reopenAfterFault(keepGrow: boolean): Promise<void> {
    if (this.reopenTail !== undefined) {
      return this.reopenTail
    }
    const run = this.reopenNow(keepGrow)
    this.reopenTail = run
    try {
      await run
    } finally {
      this.reopenTail = undefined
    }
  }

  private async reopenNow(keepGrow: boolean): Promise<void> {
    const slots = await this.reopenOnce(keepGrow)
    const fallback = this.fallbackHot
    this.fallbackHot = undefined
    if (
      fallback === undefined ||
      !keepGrow ||
      this.chatListDurable ||
      !slots.some(slot => slot.account.phase._tag === 'WaitPhone')
    ) {
      return
    }
    // The post-trap copy was not signed in. Open the earlier one.
    this.hotFiles = fallback
    this.foldGrow = true
    await this.reopenOnce(true)
  }

  private async reopenOnce(keepGrow: boolean): Promise<Array<ClientSlot>> {
    this.openSettled = true
    if (!keepGrow) {
      this.foldGrow = false
    }
    console.info(keepGrow ? 'tdlib reopen' : 'tdlib reopen without growing')
    const slots = [...this.slots.values()]
    for (const slot of slots) {
      slot.account.holdWaiters()
      // The failed open already stored Ready. Put the account back in Opening
      // so a timed-out untilOpened does not treat the dead runtime as signed in.
      slot.account.apply({
        '@type': 'updateAuthorizationState',
        authorization_state: {
          '@type': 'authorizationStateWaitTdlibParameters',
        },
      })
    }
    this.releaseModule()
    try {
      await this.loadModule()
      for (const slot of slots) {
        if (!this.slots.has(slot.account.id)) {
          continue
        }
        slot.parametersSent = false
        slot.clientId = this.functions().create()
        this.sendParameters(slot, true)
      }
      this.openSettled = false
      // loadModule stays paused so a socket wake cannot receive before the
      // client id exists. Unpause only after parameters are queued.
      this.receivePaused = false
      this.receiveSoon()
      for (const slot of slots) {
        if (!this.slots.has(slot.account.id)) {
          continue
        }
        // Queries from the page wait on reopenTail. Answer them only after
        // this client has left Opening, so getChats is not sent too early.
        await slot.account.untilOpened(OPEN_TIMEOUT).catch(() => undefined)
      }
    } catch (error) {
      this.reportReceiveError(error)
    }
    return slots
  }

  private releaseModule(): void {
    this.clearSyncTimer()
    if (this.receiveTimer !== undefined) {
      clearTimeout(this.receiveTimer)
      this.receiveTimer = undefined
      this.receiveQueued = false
    }
    for (const resolve of this.pending.values()) {
      resolve({ '@type': 'error', message: RUNTIME_REOPEN })
    }
    this.pending.clear()
    this.module = undefined
    this.syncing = false
    this.opening = undefined
    // A socket callback from the dropped module calls receiveSoon. Receiving
    // before loadModule assigns the new instance throws "TDLib is not loaded"
    // and the harness treats that as a crash.
    this.receivePaused = true
  }

  // TDLib creates the client on the first request and emits nothing before
  // that, including authorizationStateWaitTdlibParameters. Parameters have to
  // be that first request; waiting for the update never opens a socket.
  private sendParameters(slot: ClientSlot, fromReopen = false): void {
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
      fromReopen,
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

  private dispatch(
    clientId: number,
    query: TdQuery,
    fromReopen = false,
  ): Promise<unknown> {
    if (!fromReopen && this.reopenTail !== undefined) {
      const wait = this.reopenTail
      return wait.then(() => this.dispatch(clientId, query))
    }
    const extra = `q${this.extra}`
    this.extra += 1
    const functions = this.functions()
    return new Promise(resolve => {
      if (query['@type'] === 'close') {
        this.haltReceive()
        functions.send(clientId, JSON.stringify({ ...query, '@extra': extra }))
        this.finishClose()
        resolve({ '@type': 'ok' })
        return
      }
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

  hasLive(id: string): boolean {
    return this.module !== undefined && this.slots.has(id)
  }

  private snapshotFiles(
    live: Array<SnapshotFile> | undefined,
  ): Array<SnapshotFile> | undefined {
    const stashed = this.stashed ?? []
    if (stashed.length === 0) {
      return live
    }
    const current = live ?? []
    const livePaths = new Set(current.map(file => file.path))
    const kept = stashed.filter(file => !livePaths.has(file.path))
    const merged = [...kept, ...current]
    return merged.length > 0 ? merged : live
  }

  // Drop the live instance without logOut. isolate starts the next open on an
  // empty filesystem so a new QR login does not sit beside another database.
  // The parked files are merged back into the next snapshot.
  async detachSignedIn(isolate = false): Promise<void> {
    for (const slot of this.slots.values()) {
      this.parked.set(slot.account.id, {
        apiId: slot.apiId,
        apiHash: slot.apiHash,
      })
    }
    if (this.module !== undefined) {
      await this.sync().catch(() => undefined)
      const filesystem = this.module?.FS
      if (filesystem !== undefined && canSnapshot(filesystem)) {
        try {
          const captured = captureTree(filesystem)
          const merged = this.snapshotFiles(captured)
          if (merged !== undefined && merged.length > 0) {
            this.stashed = merged
            this.hotFiles = isolate ? undefined : merged
          }
        } catch {
          // sync() already committed the IndexedDB copy.
        }
      }
    }
    this.isolateNext = isolate
    if (isolate) {
      this.hotFiles = undefined
    }
    this.discardModule()
    this.openSettled = false
    this.foldGrow = true
    this.recoveries = 0
    this.chatListDurable = false
  }

  async revive(id: string): Promise<TdAccount | undefined> {
    if (this.hasLive(id)) {
      return this.slots.get(id)?.account
    }
    const creds = this.parked.get(id)
    if (creds === undefined) {
      return undefined
    }
    await this.detachSignedIn()
    const account = await this.open(id, creds.apiId, creds.apiHash)
    await account.untilOpened(OPEN_TIMEOUT).catch(() => undefined)
    return account
  }

  async open(id: string, apiId: number, apiHash: string): Promise<TdAccount> {
    if (!validAccountId(id) || apiId <= 0 || apiHash.length !== 32) {
      throw new Error('API_ID_INVALID')
    }
    const existing = this.slots.get(id)
    if (existing !== undefined) {
      return existing.account
    }
    this.receivePaused = false
    await this.openModule()
    this.silenceLogs()
    const clientId = this.functions().create()
    const directory = databaseDirectory(id)
    const sink: TdSink = {
      send: query => {
        const current = this.slots.get(id)
        return this.dispatch(current?.clientId ?? clientId, query)
      },
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

  // close() returns at authorizationStateClosing. The destructor keeps
  // running on later receive() calls, so the next directory needs a new wasm
  // instance. Receiving on the instance that just closed traps after Ready.
  private discardModule(): void {
    this.clearSyncTimer()
    if (this.receiveTimer !== undefined) {
      clearTimeout(this.receiveTimer)
      this.receiveTimer = undefined
      this.receiveQueued = false
    }
    for (const resolve of this.pending.values()) {
      resolve({ '@type': 'error', message: 'REQUEST_FAILED' })
    }
    this.pending.clear()
    this.slots.clear()
    this.module = undefined
    this.syncing = false
    this.opening = undefined
    this.receivePaused = false
  }

  async restore(apiId: number, apiHash: string): Promise<Array<TdAccount>> {
    await this.openModule()
    const filesystem = this.module?.FS
    if (filesystem === undefined) {
      return []
    }
    const ids = filesystem
      .readdir('/tdlib')
      .filter(
        name =>
          name !== '.' &&
          name !== '..' &&
          validAccountId(name) &&
          hasSavedDatabase(filesystem, name),
      )
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
    // screen. Keep every directory that is already authorized. Close a
    // leftover without logOut, on its own wasm instance, so its destructor
    // cannot take the signed-in clients with it.
    const ready: Array<TdAccount> = []
    for (const [index, id] of ids.entries()) {
      const account = await this.open(id, apiId, apiHash)
      const phase = await account
        .untilOpened(OPEN_TIMEOUT)
        .catch(() => account.phase)
      if (phase._tag === 'Ready') {
        ready.push(account)
        continue
      }
      await account.release()
      const more = index < ids.length - 1
      if (!more && ready.length === 0) {
        continue
      }
      const kept = ready.map(item => item.id)
      this.discardModule()
      ready.length = 0
      for (const keptId of kept) {
        const again = await this.open(keptId, apiId, apiHash)
        const againPhase = await again
          .untilOpened(OPEN_TIMEOUT)
          .catch(() => again.phase)
        if (againPhase._tag === 'Ready') {
          ready.push(again)
          continue
        }
        await again.release()
      }
      if (!more) {
        break
      }
    }
    return ready
  }

  // logOut destroys the wasm client. Snapshot the other directories first,
  // drop the logged-out files, then open those accounts on a new instance.
  async logoutAccount(id: string): Promise<Array<TdAccount>> {
    const staying = [...this.slots.values()]
      .filter(slot => slot.account.id !== id)
      .map(slot => ({
        id: slot.account.id,
        apiId: slot.apiId,
        apiHash: slot.apiHash,
      }))
    this.parked.delete(id)
    const leaving = this.slots.get(id)
    if (leaving !== undefined) {
      await leaving.account.logout()
    }
    const filesystem = this.module?.FS
    if (filesystem !== undefined) {
      const directory = databaseDirectory(id)
      removeTree(filesystem, directory)
      try {
        filesystem.rmdir?.(directory)
      } catch {
        // The directory can already be gone after logOut.
      }
      if (canSnapshot(filesystem)) {
        const captured = this.snapshotFiles(
          (captureTree(filesystem) ?? []).filter(
            file => !file.path.startsWith(`${directory}/`),
          ),
        )
        this.stashed = captured?.filter(
          file => !file.path.startsWith(`${directory}/`),
        )
        this.hotFiles = captured
        await this.snapshots.commit({
          id: 'pending',
          closed: true,
          files: captured ?? [],
        })
      }
    }
    this.discardModule()
    const reopened: Array<TdAccount> = []
    for (const slot of staying) {
      const account = await this.open(slot.id, slot.apiId, slot.apiHash)
      await account.untilOpened(OPEN_TIMEOUT).catch(() => undefined)
      reopened.push(account)
    }
    return reopened
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
    Reflect.set(globalThis, 'crmChatSeal', () => this.seal())
    // Do not flush from pagehide or visibility. Unload aborts the snapshot
    // transaction, and receiving close while the page is being destroyed
    // traps in free(). Reload calls crmChatSeal while the page can still wait.
  }

  // Close TDLib first so SQLite checkpoints, then copy the files. The periodic
  // save cannot close: the chat list is on screen. Reload and browser close
  // call this while the page can still wait.
  async seal(): Promise<void> {
    this.haltReceive()
    this.closeClean = true
    const filesystem = this.module?.FS
    let before: Array<SnapshotFile> | undefined
    if (filesystem !== undefined && canSnapshot(filesystem)) {
      try {
        before = captureTree(filesystem)
      } catch {
        before = undefined
      }
    }
    const accounts = [...this.slots.values()].map(slot => slot.account)
    for (const account of accounts) {
      await account.release()
    }
    if (!this.closeClean && before !== undefined && before.length > 0) {
      this.sealedFiles = before
    }
    try {
      await this.enqueueSync(false, true)
    } finally {
      this.sealedFiles = undefined
    }
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
      // Wait until readAccount has synced. The earlier Ready files reopen
      // as authorizationStateWaitPhoneNumber.
      if (!this.chatListDurable) {
        return
      }
      const ready = [...this.slots.values()].some(
        slot => slot.account.phase._tag === 'Ready',
      )
      if (!ready) {
        return
      }
      this.flushSoon()
    }, 5000)
  }

  private noteChatListDurable(): void {
    const ready = [...this.slots.values()].some(
      slot => slot.account.phase._tag === 'Ready',
    )
    if (ready) {
      this.chatListDurable = true
    }
  }

  private async persist(filesystem: SyncFs, closed: boolean): Promise<boolean> {
    const captured = this.snapshotFiles(
      this.sealedFiles ?? captureTree(filesystem),
    )
    // Folding the wal is pure JavaScript over a detached copy, but it is
    // slow enough to stall td_receive. The next load folds the pair before
    // any td_* call. Here, copy while receive is paused and release it
    // before the IndexedDB write.
    this.syncing = false
    if (!this.receivePaused) {
      this.receiveSoon()
    }
    if (captured === undefined) {
      // Unit tests stub syncfs and have no file bytes. Production copies the
      // MEMFS node instead: IDBFS syncfs replaces the live buffer, and
      // readFile opens a second handle that makes SQLite abort().
      this.syncing = true
      try {
        await syncFs(filesystem, false)
      } finally {
        this.syncing = false
      }
      return true
    }
    const files = captured.filter(file => !file.path.endsWith('-shm'))
    if (files.length === 0) {
      return false
    }
    const assessment = assessFiles(files)
    if (!assessment.ok) {
      if (!closed) {
        return false
      }
      throw new Error(`could not sync the TDLib database: ${assessment.reason}`)
    }
    await this.snapshots.commit({
      id: 'pending',
      closed,
      files,
    })
    return true
  }

  private enqueueSync(populate: boolean, closed = false): Promise<void> {
    const run = this.syncTail.then(async () => {
      const filesystem = this.module?.FS
      if (filesystem === undefined) {
        return
      }
      this.clearSyncTimer()
      this.syncing = true
      document.documentElement.dataset['tdlibSync'] = '1'
      try {
        if (populate) {
          await syncFs(filesystem, true)
        } else if (await this.persist(filesystem, closed)) {
          this.syncError = undefined
          console.info('tdlib sync saved')
          this.noteChatListDurable()
        }
      } catch (error) {
        const failure = error instanceof Error ? error : syncFailure(error)
        this.syncError = failure
        throw failure
      } finally {
        this.syncing = false
        document.documentElement.dataset['tdlibSync'] = '0'
        if (closed) {
          // Closing already finished the useful part of TDLib's shutdown.
          // Pumping receive again after that destructor starts walks freed
          // wasm state and traps with "memory access out of bounds". The
          // snapshot is committed, and the page is about to go away.
          this.clearSyncTimer()
          if (this.receiveTimer !== undefined) {
            clearTimeout(this.receiveTimer)
            this.receiveTimer = undefined
            this.receiveQueued = false
          }
        } else {
          this.armSyncTimer()
          if (!this.receivePaused) {
            this.receiveSoon()
          }
        }
      }
    })
    this.syncTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async sync(): Promise<void> {
    return this.enqueueSync(false, false)
  }
}

export const browserRuntime = new TdWasmRuntime()
