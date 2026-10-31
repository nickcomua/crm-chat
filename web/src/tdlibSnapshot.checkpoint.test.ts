import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

import { settleSnapshotFiles } from './tdlibSnapshot'

const file = (path: string, bytes: Uint8Array) => ({
  path,
  bytes,
  mtime: 1,
  mode: 33188,
})

test('a committed wal is folded into the database and the wal is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-wal-'))
  const databasePath = join(dir, 'db.sqlite')
  try {
    const db = new DatabaseSync(databasePath)
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
    db.prepare('INSERT INTO t(v) VALUES (?)').run('alpha')
    db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    db.prepare('INSERT INTO t(v) VALUES (?)').run('beta')
    const database = new Uint8Array(readFileSync(databasePath))
    const wal = new Uint8Array(readFileSync(`${databasePath}-wal`))
    db.close()

    const settled = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', database),
      file('/tdlib/acct/db.sqlite-wal', wal),
      file('/tdlib/acct/td.binlog', new Uint8Array([1, 2, 3])),
    ])
    expect(settled.checkpointed).toBe(true)
    expect(settled.files.map(item => item.path)).toEqual([
      '/tdlib/acct/db.sqlite',
      '/tdlib/acct/td.binlog',
    ])
    const checkpoint = settled.files[0]?.bytes
    expect(checkpoint).toBeInstanceOf(Uint8Array)
    if (checkpoint === undefined) {
      return
    }
    const openedPath = join(dir, 'opened.sqlite')
    writeFileSync(openedPath, checkpoint)
    const opened = new DatabaseSync(openedPath, { readOnly: true })
    expect(opened.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    })
    expect(opened.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([
      { v: 'alpha' },
      { v: 'beta' },
    ])
    opened.close()

    const short = database.subarray(0, database.length / 2)
    const extended = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', short),
      file('/tdlib/acct/db.sqlite-wal', wal),
    ])
    expect(extended.checkpointed).toBe(true)
    expect(extended.reason).toBe('')
    expect(extended.files.map(item => item.path)).toEqual([
      '/tdlib/acct/db.sqlite',
    ])
    const grown = extended.files[0]?.bytes
    expect(grown?.length).toBe(database.length)
    if (grown !== undefined) {
      const grownPath = join(dir, 'grown.sqlite')
      writeFileSync(grownPath, grown)
      const grownDb = new DatabaseSync(grownPath, { readOnly: true })
      expect(grownDb.prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      })
      expect(grownDb.prepare('SELECT v FROM t ORDER BY id').all()).toEqual([
        { v: 'alpha' },
        { v: 'beta' },
      ])
      grownDb.close()
    }
    const refit = settleSnapshotFiles(
      [
        file('/tdlib/acct/db.sqlite', short),
        file('/tdlib/acct/db.sqlite-wal', wal),
      ],
      false,
    )
    expect(refit.checkpointed).toBe(true)
    expect(refit.files.map(item => item.path)).toEqual([
      '/tdlib/acct/db.sqlite',
    ])
    expect(refit.files[0]?.bytes.length).toBe(short.length)
    expect(refit.detail).toContain('inplace')

    const idle = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', database),
      file('/tdlib/acct/db.sqlite-wal', wal.subarray(0, 32)),
    ])
    expect(idle.checkpointed).toBe(true)
    expect(idle.reason).toBe('')
    expect(idle.files.map(item => item.path)).toEqual(['/tdlib/acct/db.sqlite'])
    expect(idle.files[0]?.bytes).toEqual(database)

    const emptyWal = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', database),
      file('/tdlib/acct/db.sqlite-wal', new Uint8Array()),
    ])
    expect(emptyWal.checkpointed).toBe(false)
    expect(emptyWal.reason).toBe('')
    expect(emptyWal.files.map(item => item.path)).toEqual([
      '/tdlib/acct/db.sqlite',
    ])

    const torn = wal.slice()
    torn[24] = torn[24] === 0 ? 1 : 0
    const rejected = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', database),
      file('/tdlib/acct/db.sqlite-wal', torn),
    ])
    expect(rejected.checkpointed).toBe(false)
    expect(rejected.reason).toBe('wal-header')
    expect(rejected.files.map(item => item.path)).toEqual([
      '/tdlib/acct/db.sqlite',
      '/tdlib/acct/db.sqlite-wal',
    ])

    // An encrypted TDLib file has no SQLite magic. The salt stays in the
    // database page, and only the pages present in the wal are replaced.
    const encrypted = database.slice()
    encrypted.fill(0xab, 0, 16)
    const folded = settleSnapshotFiles([
      file('/tdlib/acct/db.sqlite', encrypted),
      file('/tdlib/acct/db.sqlite-wal', wal),
    ])
    expect(folded.checkpointed).toBe(true)
    expect(folded.reason).toBe('')
    const restored = folded.files[0]?.bytes
    expect(restored?.subarray(0, 16)).toEqual(encrypted.subarray(0, 16))
    expect(restored?.subarray(16)).toEqual(checkpoint.subarray(16))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
