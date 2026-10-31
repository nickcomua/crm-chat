// IndexedDB snapshots of the TDLib filesystem.
//
// Emscripten's IDBFS syncfs saves each file from the live MEMFS node, and
// loadLocalEntry replaces that node's buffer with a subarray. Doing that while
// TDLib is running faults the wasm heap ("memory access out of bounds",
// "table index is out of bounds"). A snapshot is a detached copy of every
// file, written in one transaction together with the pointer. A transaction
// that does not commit leaves the previous pointer in place, so a reload never
// opens a half-written tree.

export const SNAPSHOT_DB = 'crm-chat-tdlib'
export const LEGACY_DB = '/tdlib'
export const LEGACY_STORE = 'FILE_DATA'

const DIRECTORY_MODE = 16384
const MODE_TYPE = 61440
const SQLITE_MAGIC = 'SQLite format 3\u0000'

export type SnapshotFile = {
  path: string
  bytes: Uint8Array
  mtime: number
  mode: number
}

export type Snapshot = {
  id: string
  closed: boolean
  files: Array<SnapshotFile>
}

export type Pointer = {
  current?: string
  previous?: string
  serial?: number
}

export type Assessment = {
  ok: boolean
  reason: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isSafeDatabasePath = (path: string): boolean => {
  if (!path.startsWith('/tdlib/')) {
    return false
  }
  return path.split('/').every(part => part !== '..' && part !== '.')
}

const isDirectoryMode = (mode: number): boolean =>
  (mode & MODE_TYPE) === DIRECTORY_MODE

const pageSizeOf = (bytes: Uint8Array): number | undefined => {
  if (bytes.length < 100 || bytes.length < 16) {
    return undefined
  }
  let magic = ''
  for (let index = 0; index < 16; index += 1) {
    magic += String.fromCharCode(bytes[index] ?? 0)
  }
  if (magic !== SQLITE_MAGIC) {
    return undefined
  }
  const raw = ((bytes[16] ?? 0) << 8) | (bytes[17] ?? 0)
  const page = raw === 1 ? 65536 : raw
  if (page < 512 || page > 65536 || (page & (page - 1)) !== 0) {
    return undefined
  }
  if (bytes.length % page !== 0) {
    return undefined
  }
  return page
}

const readU32 = (
  bytes: Uint8Array,
  offset: number,
  little: boolean,
): number => {
  const slice = bytes.subarray(offset, offset + 4)
  if (slice.length < 4) {
    return 0
  }
  const view = new DataView(slice.buffer, slice.byteOffset, 4)
  return view.getUint32(0, little)
}

const walEndian = (bytes: Uint8Array): boolean | undefined => {
  if (bytes.length < 32) {
    return undefined
  }
  const big =
    bytes[0] === 0x37 &&
    bytes[1] === 0x7f &&
    bytes[2] === 0x06 &&
    (bytes[3] === 0x82 || bytes[3] === 0x83)
  if (big) {
    return false
  }
  const little =
    (bytes[0] === 0x82 || bytes[0] === 0x83) &&
    bytes[1] === 0x06 &&
    bytes[2] === 0x7f &&
    bytes[3] === 0x37
  return little ? true : undefined
}

const walMatches = (wal: Uint8Array, pageSize: number): boolean => {
  if (wal.length === 0) {
    return true
  }
  const little = walEndian(wal)
  if (little === undefined) {
    return false
  }
  const storedPage = readU32(wal, 8, little)
  if (storedPage !== pageSize) {
    return false
  }
  const frame = 24 + pageSize
  const body = wal.length - 32
  return body >= 0 && body % frame === 0
}

const databasePath = (path: string): string | undefined => {
  if (path.endsWith('.sqlite-wal') || path.endsWith('-shm')) {
    return undefined
  }
  if (path.endsWith('.sqlite')) {
    return path
  }
  return undefined
}

const powerOfTwoPage = (page: number): boolean =>
  page >= 512 && page <= 65536 && (page & (page - 1)) === 0

// A checkpointed database has no wal. Plaintext files carry the SQLite magic.
// TDLib's encrypted files do not, but they stay a multiple of the page size.
const databaseOk = (
  bytes: Uint8Array,
  wal: Uint8Array | undefined,
): Assessment | undefined => {
  const page = pageSizeOf(bytes)
  if (page !== undefined) {
    if (wal !== undefined && !walMatches(wal, page)) {
      return { ok: false, reason: 'wal' }
    }
    if (wal !== undefined && wal.length > 0 && bytes[18] !== 2) {
      return { ok: false, reason: 'wal without wal mode' }
    }
    return undefined
  }
  if (wal !== undefined && wal.length > 0) {
    const little = walEndian(wal)
    const walPage = little === undefined ? 0 : readU32(wal, 8, little)
    if (
      little === undefined ||
      !powerOfTwoPage(walPage) ||
      bytes.length % walPage !== 0 ||
      !walMatches(wal, walPage)
    ) {
      return { ok: false, reason: 'wal' }
    }
    return undefined
  }
  if (bytes.length >= 512 && bytes.length % 512 === 0) {
    return undefined
  }
  return { ok: false, reason: 'sqlite header' }
}

export const assessFiles = (
  files: ReadonlyArray<Pick<SnapshotFile, 'path' | 'bytes'>>,
): Assessment => {
  const byPath = new Map<string, Uint8Array>()
  for (const file of files) {
    if (!isSafeDatabasePath(file.path)) {
      return { ok: false, reason: 'path' }
    }
    if (!(file.bytes instanceof Uint8Array)) {
      return { ok: false, reason: 'bytes' }
    }
    byPath.set(file.path, file.bytes)
  }
  for (const [path, bytes] of byPath) {
    const database = databasePath(path)
    if (database === undefined) {
      continue
    }
    const failed = databaseOk(bytes, byPath.get(`${database}-wal`))
    if (failed !== undefined) {
      return failed
    }
  }
  return { ok: true, reason: '' }
}

const isSnapshotFile = (value: unknown): value is SnapshotFile => {
  if (!isRecord(value)) {
    return false
  }
  return (
    typeof value['path'] === 'string' &&
    value['bytes'] instanceof Uint8Array &&
    typeof value['mtime'] === 'number' &&
    Number.isFinite(value['mtime']) &&
    typeof value['mode'] === 'number'
  )
}

const isSnapshot = (value: unknown): value is Snapshot => {
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    return false
  }
  if (typeof value['closed'] !== 'boolean' || !Array.isArray(value['files'])) {
    return false
  }
  return value['files'].every(file => isSnapshotFile(file))
}

const isPointer = (value: unknown): value is Pointer => {
  if (!isRecord(value)) {
    return false
  }
  const current = value['current']
  const previous = value['previous']
  const serial = value['serial']
  return (
    (current === undefined || typeof current === 'string') &&
    (previous === undefined || typeof previous === 'string') &&
    (serial === undefined ||
      (typeof serial === 'number' && Number.isFinite(serial)))
  )
}

// TDLib encrypts the database even when database_encryption_key is empty:
// the empty string selects the built-in key, so the file has no SQLite
// magic. The wal still stores ordinary frames, and each page image is the
// on-disk bytes (ciphertext included). sqlite's walCheckpoint copies those
// images into the database and truncates to the commit size. Do that before
// a new wasm instance opens the files. Replaying the wal inside Emscripten
// comes back as a new login. A checksum that stops early leaves the original
// pair untouched. Never rewrite header bytes: on an encrypted page that
// destroys the salt. `grow` false keeps an earlier commit that fits the
// file when the newest commit would append pages. That appended page has
// faulted in free() after Ready.
const checkpointDatabase = (
  database: Uint8Array,
  wal: Uint8Array,
  grow = true,
): { bytes: Uint8Array; detail: string } | { reason: string } => {
  const db = new Uint8Array(database)
  const log = new Uint8Array(wal)
  if (log.length < 32 || db.length < 512) {
    return { reason: 'short' }
  }
  if (
    log[0] !== 0x37 ||
    log[1] !== 0x7f ||
    log[2] !== 0x06 ||
    (log[3] !== 0x82 && log[3] !== 0x83)
  ) {
    return { reason: 'wal-magic' }
  }
  const littleWords = log[3] === 0x82
  const page = readU32(log, 8, false)
  if (!powerOfTwoPage(page) || db.length % page !== 0) {
    return { reason: 'page' }
  }
  const sum = (
    offset: number,
    length: number,
    first: number,
    second: number,
  ): [number, number] => {
    let s0 = first
    let s1 = second
    const view = new DataView(log.buffer, log.byteOffset + offset, length)
    for (let index = 0; index < length; index += 8) {
      const left = view.getUint32(index, littleWords)
      const right = view.getUint32(index + 4, littleWords)
      s0 = (s0 + left + s1) >>> 0
      s1 = (s1 + right + s0) >>> 0
    }
    return [s0, s1]
  }
  const header = sum(0, 24, 0, 0)
  if (
    header[0] !== readU32(log, 24, false) ||
    header[1] !== readU32(log, 28, false)
  ) {
    return { reason: 'wal-header' }
  }
  const salt1 = readU32(log, 16, false)
  const salt2 = readU32(log, 20, false)
  let sum0 = header[0]
  let sum1 = header[1]
  const frame = 24 + page
  const pending: Array<{ pageNo: number; bytes: Uint8Array }> = []
  const committed = new Map<number, Uint8Array>()
  let fit = new Map<number, Uint8Array>()
  let fitCommit = 0
  let lastCommit = 0
  let frames = 0
  let stop = 'end'
  for (let offset = 32; offset + frame <= log.length; offset += frame) {
    if (
      readU32(log, offset + 8, false) !== salt1 ||
      readU32(log, offset + 12, false) !== salt2
    ) {
      stop = 'salt'
      break
    }
    // sqlite rejects page 0 before it mixes the frame into the checksum.
    const pageNo = readU32(log, offset, false)
    if (pageNo === 0) {
      stop = 'page'
      break
    }
    const covered = sum(offset, 8, sum0, sum1)
    const pageSum = sum(offset + 24, page, covered[0], covered[1])
    if (
      pageSum[0] !== readU32(log, offset + 16, false) ||
      pageSum[1] !== readU32(log, offset + 20, false)
    ) {
      stop = 'checksum'
      break
    }
    sum0 = pageSum[0]
    sum1 = pageSum[1]
    const size = readU32(log, offset + 4, false)
    frames += 1
    pending.push({
      pageNo,
      bytes: log.slice(offset + 24, offset + 24 + page),
    })
    if (size > 0) {
      lastCommit = size
      for (const item of pending) {
        if (item.pageNo > 0 && item.pageNo <= size) {
          committed.set(item.pageNo, item.bytes)
        }
      }
      pending.length = 0
      if (size * page === db.length) {
        fitCommit = size
        fit = new Map(committed)
      }
    }
  }
  const filePages = db.length / page
  const describe = (commit: number, outPages: number, note: string): string =>
    `commit=${commit} file=${filePages} out=${outPages} frames=${frames} stop=${stop}${note === '' ? '' : ` ${note}`}`
  if (lastCommit <= 0) {
    // SQLite close checkpoints and leaves a header with no frames. That
    // database is already settled. A longer wal with no commit is a torn
    // transaction and must not replace the file.
    if (log.length === 32) {
      return { bytes: db, detail: describe(filePages, filePages, 'idle') }
    }
    return { reason: 'uncommitted' }
  }
  const bytesNeeded = lastCommit * page
  // Folding a commit smaller than the file drops pages the binlog still
  // expects, and the next open comes back as a new login.
  if (bytesNeeded < db.length) {
    return { reason: 'torn' }
  }
  let pages = committed
  let outLength = bytesNeeded
  let note = ''
  if (!grow && bytesNeeded > db.length) {
    if (fitCommit > 0) {
      pages = fit
      outLength = db.length
      note = 'fit'
    } else {
      // No commit matches the file. Keep the pages that fit and let TDLib
      // treat the missing tail as unread, instead of appending a page that
      // has faulted in free() after Ready.
      outLength = db.length
      note = 'inplace'
    }
  }
  if (outLength > db.length + log.length) {
    return { reason: 'gap' }
  }
  const originalPages = filePages
  if (outLength > db.length) {
    for (let pageNo = originalPages + 1; pageNo <= lastCommit; pageNo += 1) {
      if (!pages.has(pageNo)) {
        return { reason: 'gap' }
      }
    }
  }
  const settled = new Uint8Array(outLength)
  settled.set(db.subarray(0, Math.min(db.length, settled.length)))
  for (const [pageNo, bytes] of pages) {
    const at = (pageNo - 1) * page
    if (at >= 0 && at + page <= settled.length) {
      settled.set(bytes, at)
    }
  }
  if (pageSizeOf(db) !== undefined && pageSizeOf(settled) === undefined) {
    return { reason: 'settled' }
  }
  return {
    bytes: settled,
    detail: describe(
      note === 'fit' ? fitCommit : lastCommit,
      outLength / page,
      note,
    ),
  }
}

export const settleSnapshotFiles = (
  files: ReadonlyArray<SnapshotFile>,
  grow = true,
): {
  files: Array<SnapshotFile>
  checkpointed: boolean
  reason: string
  detail: string
} => {
  const byPath = new Map(files.map(file => [file.path, file]))
  const dropped = new Set<string>()
  const replaced = new Map<string, Uint8Array>()
  let reason = ''
  let detail = ''
  for (const file of files) {
    if (!file.path.endsWith('.sqlite') || file.path.endsWith('.sqlite-wal')) {
      continue
    }
    const wal = byPath.get(`${file.path}-wal`)
    if (wal === undefined) {
      continue
    }
    if (wal.bytes.length === 0) {
      dropped.add(wal.path)
      continue
    }
    const settled = checkpointDatabase(file.bytes, wal.bytes, grow)
    if (!('bytes' in settled)) {
      if (reason === '') {
        reason = settled.reason
      }
      continue
    }
    replaced.set(file.path, settled.bytes)
    dropped.add(wal.path)
    detail = settled.detail
  }
  if (replaced.size === 0) {
    return {
      files: files.filter(
        file => !file.path.endsWith('-shm') && !dropped.has(file.path),
      ),
      checkpointed: false,
      reason,
      detail,
    }
  }
  const next: Array<SnapshotFile> = []
  for (const file of files) {
    if (dropped.has(file.path) || file.path.endsWith('-shm')) {
      continue
    }
    const bytes = replaced.get(file.path)
    if (bytes === undefined) {
      next.push(file)
      continue
    }
    next.push({ path: file.path, bytes, mtime: file.mtime, mode: file.mode })
  }
  return { files: next, checkpointed: true, reason: '', detail }
}

export const usableSnapshot = (value: unknown): value is Snapshot => {
  if (!isSnapshot(value) || value.files.length === 0) {
    return false
  }
  const kept = value.files.filter(file => !file.path.endsWith('-shm'))
  return assessFiles(kept).ok
}

export const chooseSnapshot = (
  current: unknown,
  previous: unknown,
): Snapshot | undefined => {
  if (usableSnapshot(current)) {
    return current
  }
  if (usableSnapshot(previous)) {
    return previous
  }
  return undefined
}

export const nextPointer = (
  existing: Pointer | undefined,
  id: string,
): { pointer: Pointer; drop?: string } => {
  const previous =
    existing?.current !== undefined && existing.current !== id
      ? existing.current
      : existing?.previous
  const pointer: Pointer = { current: id }
  if (previous !== undefined) {
    pointer.previous = previous
  }
  const dropped = existing?.previous
  if (dropped !== undefined && dropped !== id && dropped !== pointer.previous) {
    return { pointer, drop: dropped }
  }
  return { pointer }
}

// The id comes from the pointer's serial, which lives in the same database as
// the snapshots. A new page keeps counting, so a key is never reused.
export const assignSnapshot = (
  existing: Pointer | undefined,
  snapshot: Snapshot,
): { stored: Snapshot; pointer: Pointer; drop?: string } => {
  const serial = (existing?.serial ?? 0) + 1
  const stored: Snapshot = {
    id: `s${serial.toString(16)}`,
    closed: snapshot.closed,
    files: snapshot.files.filter(file => !file.path.endsWith('-shm')),
  }
  const next = nextPointer(existing, stored.id)
  const pointer: Pointer = { ...next.pointer, serial }
  if (next.drop === undefined) {
    return { stored, pointer }
  }
  return { stored, pointer, drop: next.drop }
}

const openSnapshotDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(SNAPSHOT_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records')
      }
    }
    request.onerror = () => {
      reject(request.error ?? new Error('could not open the snapshot database'))
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
  })

const finish = (db: IDBDatabase, tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      db.close()
      resolve()
    }
    tx.onerror = () => {
      db.close()
      reject(tx.error ?? new Error('could not write the snapshot'))
    }
    tx.onabort = () => {
      db.close()
      reject(tx.error ?? new Error('snapshot transaction aborted'))
    }
  })

export const commitSnapshot = async (snapshot: Snapshot): Promise<void> => {
  if (!usableSnapshot(snapshot)) {
    throw new Error('could not sync the TDLib database: snapshot is incomplete')
  }
  const db = await openSnapshotDb()
  const tx = db.transaction('records', 'readwrite')
  const store = tx.objectStore('records')
  const done = finish(db, tx)
  const existingRequest = store.get('pointer')
  existingRequest.onsuccess = () => {
    const existing = isPointer(existingRequest.result)
      ? existingRequest.result
      : undefined
    const assigned = assignSnapshot(existing, snapshot)
    store.put(assigned.stored, `snap:${assigned.stored.id}`)
    store.put(assigned.pointer, 'pointer')
    if (assigned.drop !== undefined) {
      store.delete(`snap:${assigned.drop}`)
    }
  }
  await done
}

export const loadSnapshot = async (): Promise<Snapshot | undefined> => {
  let db: IDBDatabase
  try {
    db = await openSnapshotDb()
  } catch {
    return undefined
  }
  if (!db.objectStoreNames.contains('records')) {
    db.close()
    return undefined
  }
  return new Promise(resolve => {
    const tx = db.transaction('records', 'readonly')
    const store = tx.objectStore('records')
    let settled = false
    const settle = (value: Snapshot | undefined) => {
      if (settled) {
        return
      }
      settled = true
      resolve(value)
    }
    tx.oncomplete = () => {
      db.close()
    }
    tx.onerror = () => {
      db.close()
      settle(undefined)
    }
    const read = (id: string | undefined, fallback: string | undefined) => {
      if (id === undefined) {
        settle(undefined)
        return
      }
      const request = store.get(`snap:${id}`)
      request.onerror = () => {
        settle(undefined)
      }
      request.onsuccess = () => {
        const chosen = chooseSnapshot(request.result, undefined)
        if (chosen !== undefined) {
          settle(chosen)
          return
        }
        if (fallback !== undefined && fallback !== id) {
          read(fallback, undefined)
          return
        }
        settle(undefined)
      }
    }
    const pointerRequest = store.get('pointer')
    pointerRequest.onerror = () => {
      settle(undefined)
    }
    pointerRequest.onsuccess = () => {
      const pointer = pointerRequest.result
      if (!isPointer(pointer)) {
        settle(undefined)
        return
      }
      read(pointer.current, pointer.previous)
    }
  })
}

export type LegacyDirectory = {
  path: string
  mtime: number
}

// Directories the previous demo server stored in IDBFS. File bytes stay in
// the snapshot; these entries only add account directories the snapshot does
// not already have, such as a newer empty leftover login.
export const readLegacyDirectories = (): Promise<Array<LegacyDirectory>> =>
  new Promise(resolve => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(LEGACY_DB)
    } catch {
      resolve([])
      return
    }
    request.onupgradeneeded = () => {
      request.transaction?.abort()
    }
    request.onerror = () => {
      resolve([])
    }
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LEGACY_STORE)) {
        db.close()
        resolve([])
        return
      }
      const found: Array<LegacyDirectory> = []
      const tx = db.transaction(LEGACY_STORE, 'readonly')
      const cursor = tx.objectStore(LEGACY_STORE).openCursor()
      cursor.onerror = () => {
        db.close()
        resolve(found)
      }
      cursor.onsuccess = () => {
        const row = cursor.result
        if (row === null) {
          return
        }
        const key = row.key
        const value: unknown = row.value
        if (typeof key === 'string' && isRecord(value)) {
          const mode = value['mode']
          const timestamp = value['timestamp']
          const mtime =
            timestamp instanceof Date
              ? timestamp.getTime()
              : typeof timestamp === 'number'
                ? timestamp
                : 0
          if (
            typeof mode === 'number' &&
            isDirectoryMode(mode) &&
            isSafeDatabasePath(key)
          ) {
            found.push({ path: key, mtime })
          }
        }
        row.continue()
      }
      tx.oncomplete = () => {
        db.close()
        resolve(found)
      }
      tx.onerror = () => {
        db.close()
        resolve(found)
      }
    }
  })
