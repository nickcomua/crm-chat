import { expect, test } from 'vitest'

import {
  type Snapshot,
  type SnapshotFile,
  assessFiles,
  assignSnapshot,
  chooseSnapshot,
  nextPointer,
} from './tdlibSnapshot'

const sqlite = (pages = 1): Uint8Array => {
  const bytes = new Uint8Array(512 * pages)
  const magic = 'SQLite format 3\u0000'
  for (let index = 0; index < magic.length; index += 1) {
    bytes[index] = magic.charCodeAt(index)
  }
  bytes[16] = 0x02
  bytes[17] = 0x00
  bytes[18] = 2
  return bytes
}

const file = (path: string, bytes: Uint8Array, mtime = 1): SnapshotFile => ({
  path,
  bytes,
  mtime,
  mode: 33188,
})

const snapshot = (
  id: string,
  files: Array<SnapshotFile>,
  closed = false,
): Snapshot => ({
  id,
  closed,
  files,
})

const walHeader = (page: number, little: boolean): Uint8Array => {
  const bytes = new Uint8Array(32)
  if (little) {
    bytes[0] = 0x83
    bytes[1] = 0x06
    bytes[2] = 0x7f
    bytes[3] = 0x37
    bytes[8] = page & 0xff
    bytes[9] = (page >> 8) & 0xff
  } else {
    bytes[0] = 0x37
    bytes[1] = 0x7f
    bytes[2] = 0x06
    bytes[3] = 0x82
    bytes[10] = (page >> 8) & 0xff
    bytes[11] = page & 0xff
  }
  return bytes
}

test('a sqlite file is rejected when the header or wal does not match', () => {
  const database = file('/tdlib/acct/db.sqlite', sqlite())
  expect(assessFiles([database]).ok).toBe(true)

  const torn = file('/tdlib/acct/db.sqlite', sqlite().subarray(0, 100))
  expect(assessFiles([torn]).reason).toBe('sqlite header')

  expect(
    assessFiles([
      database,
      file('/tdlib/acct/db.sqlite-wal', walHeader(512, true)),
    ]).ok,
  ).toBe(true)

  const shortWal = walHeader(512, true).subarray(0, 24)
  expect(
    assessFiles([database, file('/tdlib/acct/db.sqlite-wal', shortWal)]).reason,
  ).toBe('wal')

  expect(assessFiles([file('/etc/passwd', sqlite())]).reason).toBe('path')
  expect(assessFiles([file('/tdlib/../db.sqlite', sqlite())]).reason).toBe(
    'path',
  )
})

test('an encrypted database is accepted when its wal page size divides it', () => {
  const database = file('/tdlib/acct/db.sqlite', new Uint8Array(4096))
  const wal = file('/tdlib/acct/db.sqlite-wal', walHeader(4096, false))
  expect(assessFiles([database, wal]).ok).toBe(true)
  expect(
    assessFiles([file('/tdlib/acct/db.sqlite', new Uint8Array(1000))]).reason,
  ).toBe('sqlite header')
})

test('the pointer keeps the previous snapshot when the new one is unusable', () => {
  const older = snapshot(
    'older',
    [file('/tdlib/acct/db.sqlite', sqlite(), 10)],
    true,
  )
  const newer = snapshot('newer', [file('/tdlib/acct/db.sqlite', sqlite(), 20)])
  const torn = snapshot('torn', [
    file('/tdlib/acct/db.sqlite', new Uint8Array(32)),
  ])
  expect(chooseSnapshot(newer, older)?.id).toBe('newer')
  expect(chooseSnapshot(torn, older)?.id).toBe('older')
  expect(chooseSnapshot(torn, torn)).toBeUndefined()

  const first = nextPointer(undefined, older.id)
  const second = nextPointer(first.pointer, newer.id)
  const third = nextPointer(second.pointer, 'third')
  expect(first.pointer).toEqual({ current: 'older' })
  expect(first.drop).toBeUndefined()
  expect(second.pointer).toEqual({ current: 'newer', previous: 'older' })
  expect(second.drop).toBeUndefined()
  expect(third.pointer).toEqual({ current: 'third', previous: 'newer' })
  expect(third.drop).toBe('older')
  const rewrite = nextPointer(second.pointer, newer.id)
  expect(rewrite.pointer.previous).toBe('older')
  expect(rewrite.drop).toBeUndefined()

  const firstSave = assignSnapshot(undefined, older)
  const secondSave = assignSnapshot(firstSave.pointer, newer)
  expect(firstSave.stored.id).toBe('s1')
  expect(secondSave.stored.id).toBe('s2')
  expect(secondSave.pointer).toEqual({
    current: 's2',
    previous: 's1',
    serial: 2,
  })
  expect(secondSave.drop).toBeUndefined()
  expect(secondSave.stored.files[0]?.mtime).toBe(20)
})
