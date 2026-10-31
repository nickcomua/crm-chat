import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'

import {
  type CaseDraft,
  type CaseEvent,
  type CaseFile,
  type CaseNote,
  DESKTOP_WORKSPACE_FILE,
  MEMBER_YOU_ID,
  type Person,
  SCHEMA_VERSION,
  STAGE_WORKING_ID,
  WEB_WORKSPACE_DATABASE,
} from './generated/core'
import {
  WorkspaceError,
  closeWorkspace,
  deleteWorkspace,
  openWorkspace,
  personNotesUnavailable,
  reopenWorkspace,
} from './workspace'

const HASH = '0123456789abcdef0123456789abcdef'

const person = (): Person => ({
  id: 'person-olena',
  display_name: 'Olena',
  name_overridden: false,
  created_at: 1,
  updated_at: 1,
  pinned_in_people: false,
})

const olenaDraft = (): CaseDraft => {
  const caseId = 'case-olena'
  const chat = {
    account_id: 'sales',
    chat_id: 'sales:olena',
    telegram_chat_id: '100',
    message_id: '',
    message_thread_id: '0',
  }
  const note: CaseNote = {
    id: 'note-1',
    case_id: caseId,
    body: 'Asked the supplier',
    created_at: 1_763_100_000_000,
    author_id: MEMBER_YOU_ID,
    source: null,
  }
  const file: CaseFile = {
    id: 'file-1',
    case_id: caseId,
    added_at: 1_763_200_000_000,
    name: 'price.pdf',
    byte_length: 12,
    media_type: 'application/pdf',
    source_kind: 'Local',
    source: null,
    relative_path: 'price.pdf',
  }
  const event: CaseEvent = {
    id: 'event-1',
    case_id: caseId,
    at: 1_763_000_000_000,
    kind: 'Created',
    from_id: '',
    to_id: STAGE_WORKING_ID,
    from_name: '',
    to_name: 'Working',
    quote: '',
    outcome: 'None',
    stage_id: STAGE_WORKING_ID,
    stage_name: 'Working',
    follow_up_at: null,
  }
  return {
    id: caseId,
    title: '  Olena, 40 seats  ',
    kind: 'Deal',
    stage_id: STAGE_WORKING_ID,
    priority: 'High',
    owner_id: MEMBER_YOU_ID,
    due_at: 1_763_337_600_000,
    follow_up_at: 1_763_400_000_000,
    reply_account_id: 'sales',
    primary_chat: { ...chat },
    chats: [
      {
        case_id: caseId,
        chat: { ...chat },
        role: 'Primary',
        title_snapshot: 'Olena',
        account_label_snapshot: 'Sales',
      },
    ],
    participants: [
      {
        case_id: caseId,
        telegram_user_id: '200',
        role: 'Primary',
        name_snapshot: 'Olena',
        username_snapshot: 'olena',
      },
    ],
    messages: [
      {
        case_id: caseId,
        message: { ...chat, message_id: '50' },
        attached_at: 1_763_000_000_000,
        attached_by: MEMBER_YOU_ID,
        snapshot: {
          text: '  can you do 40 seats by Friday?  ',
          sent_at: 1_763_000_000_000,
          sender_name: 'Olena',
          sender_user_id: '200',
          outgoing: false,
          media_kind: 'None',
          chat_title: 'Olena',
          account_label: 'Sales',
        },
      },
    ],
    notes: [note],
    files: [file],
    events: [event],
  }
}

test('web and desktop share schema version 1 and not a file name', () => {
  const desktopFile: string = DESKTOP_WORKSPACE_FILE
  const webDatabase: string = WEB_WORKSPACE_DATABASE
  expect(SCHEMA_VERSION).toBe(1)
  expect(desktopFile).toBe('workspace.sqlite')
  expect(webDatabase).toBe('crm-chat-workspace')
  expect(desktopFile).not.toBe(webDatabase)
  expect(desktopFile).not.toBe('cases.sqlite')
  expect(webDatabase).not.toBe('crm-chat-cases')
  expect(personNotesUnavailable('https://crm-chat.example')).toBe(
    'Person notes are unavailable (https://crm-chat.example)',
  )
})

test('a reload keeps the person and a cleared origin starts empty', async () => {
  const name = 'crm-chat-reload'
  const store = await openWorkspace(name)
  await store.putRecord('people', 'person-olena', person())
  await store.recordLogin(
    'acct-1',
    'Work',
    {
      api_hash: HASH,
      api_id: '42424242',
      session: 'session-do-not-store',
      access_hash: '777000111',
      display_name: 'Olena',
    },
    1,
  )
  const text = await store.dump()
  expect(text).not.toContain(HASH)
  expect(text).not.toContain('42424242')
  expect(text).not.toContain('session-do-not-store')
  expect(text).not.toContain('777000111')
  expect(text).toContain('Olena')
  expect(text).toContain('Work')
  expect(await store.schemaVersion()).toBe(1)
  await closeWorkspace(name)
  const reloaded = await reopenWorkspace(name)
  expect(await reloaded.getRecord('people', 'person-olena')).toEqual(person())
  await reloaded.noteLogout('acct-1')
  await reloaded.noteAccountRemoved('acct-1')
  await reloaded.recordLogin('acct-2', 'Personal', { label: 'Personal' }, 2)
  expect(await reloaded.getRecord('people', 'person-olena')).toEqual(person())
  const label = await reloaded.getRecord('account_labels', 'acct-1')
  expect(label).toMatchObject({ connection: 'removed', observed_name: 'Olena' })
  await deleteWorkspace(name)
  const fresh = await openWorkspace(name)
  expect(await fresh.getRecord('people', 'person-olena')).toBeNull()
  await deleteWorkspace(name)
})

test('two web installations do not share a case', async () => {
  const left = await openWorkspace('crm-chat-left')
  const right = await openWorkspace('crm-chat-right')
  await left.insertCase(olenaDraft(), 100)
  expect(await right.caseBundle('case-olena')).toBeNull()
  await deleteWorkspace('crm-chat-left')
  await deleteWorkspace('crm-chat-right')
})

test('the fixture case round-trips and numbers are not reused', async () => {
  const name = 'crm-chat-case'
  const store = await openWorkspace(name)
  expect(await store.getRecord('stages', STAGE_WORKING_ID)).toMatchObject({
    name: 'Working',
  })
  const bundle = await store.insertCase(olenaDraft(), 100)
  expect(bundle.case.number).toBe(1)
  expect(bundle.case.title).toBe('Olena, 40 seats')
  expect(bundle.case.kind).toBe('Deal')
  expect(bundle.case.stage_id).toBe(STAGE_WORKING_ID)
  expect(bundle.case.priority).toBe('High')
  expect(bundle.case.due_at).toBe(1_763_337_600_000)
  expect(bundle.participants[0]?.name_snapshot).toBe('Olena')
  expect(bundle.messages[0]?.snapshot.text).toBe(
    'can you do 40 seats by Friday?',
  )
  expect(bundle.notes[0]?.body).toBe('Asked the supplier')
  expect(bundle.events[0]?.kind).toBe('Created')
  const linked = bundle.messages[0]
  if (linked === undefined) {
    throw new Error('fixture case has no message')
  }
  await expect(store.attachMessage(linked)).rejects.toMatchObject({
    _tag: 'DuplicateLink',
  })
  const closed = await store.closeCase('case-olena', 'Won', 'shipped', 200)
  expect(closed.number).toBe(1)
  expect(closed.status).toBe('Closed')
  const draft = olenaDraft()
  const message = draft.messages[0]
  const note = draft.notes[0]
  const event = draft.events[0]
  const file = draft.files[0]
  const chat = draft.chats[0]
  if (
    message === undefined ||
    note === undefined ||
    event === undefined ||
    file === undefined ||
    chat === undefined
  ) {
    throw new Error('fixture case is incomplete')
  }
  const created = await store.insertCase(
    {
      ...draft,
      id: 'case-next',
      messages: [
        { ...message, message: { ...message.message, message_id: '51' } },
      ],
      notes: [{ ...note, id: 'note-2' }],
      events: [{ ...event, id: 'event-2' }],
      files: [{ ...file, id: 'file-2' }],
      chats: [{ ...chat, chat: { ...chat.chat, chat_id: 'sales:next' } }],
      primary_chat: { ...chat.chat, chat_id: 'sales:next', message_id: '' },
    },
    300,
  )
  expect(created.case.number).toBe(2)
  await closeWorkspace(name)
  const reloaded = await reopenWorkspace(name)
  const kept = await reloaded.caseBundle('case-olena')
  expect(kept?.case.number).toBe(1)
  expect(kept?.case.title).toBe('Olena, 40 seats')
  expect(kept?.messages[0]?.snapshot.text).toBe(
    'can you do 40 seats by Friday?',
  )
  expect(kept?.messages[0]?.snapshot.account_label).toBe('Sales')
  await deleteWorkspace(name)
})

test('a newer schema is refused and the person row stays', async () => {
  const name = 'crm-chat-migrate'
  const store = await openWorkspace(name)
  await store.putRecord('people', 'person-olena', person())
  await closeWorkspace(name)
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 2)
    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      if (!database.objectStoreNames.contains('migration_probe')) {
        database.createObjectStore('migration_probe')
      }
      const tx = request.transaction
      tx?.objectStore('schema_meta').put({ schema_version: 2 }, 1)
    })
    request.addEventListener('success', () => {
      request.result.close()
      resolve()
    })
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('upgrade failed'))
    })
  })
  await expect(openWorkspace(name)).rejects.toBeInstanceOf(WorkspaceError)
  await expect(openWorkspace(name)).rejects.toMatchObject({
    _tag: 'NewerSchema',
  })
  const text = await new Promise<string>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.addEventListener('success', () => {
      const database = request.result
      const tx = database.transaction('people', 'readonly')
      const read = tx.objectStore('people').get('person-olena')
      read.addEventListener('success', () => {
        const dumped = JSON.stringify(read.result)
        database.close()
        resolve(dumped)
      })
      read.addEventListener('error', () => {
        database.close()
        reject(read.error ?? new Error('read failed'))
      })
    })
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('open failed'))
    })
  })
  expect(text).toContain('Olena')
  await deleteWorkspace(name)
})
