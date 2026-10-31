import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'

import {
  type AccountLabel,
  type Case,
  type CaseBundle,
  type CaseChat,
  type CaseDraft,
  type CaseEvent,
  type CaseEventKind,
  type CaseFile,
  type CaseKind,
  type CaseMessage,
  type CaseNote,
  type CaseOutcome,
  type CaseParticipant,
  type CaseRole,
  type CaseStatus,
  type FileSourceKind,
  MEMBER_YOU_ID,
  MEMBER_YOU_NAME,
  type MediaKind,
  type Member,
  type MessageRef,
  type MessageSnapshot,
  type Priority,
  SCHEMA_VERSION,
  SECRET_FIELD_NAMES,
  STAGE_NEW_ID,
  STAGE_READY_ID,
  STAGE_WAITING_ID,
  STAGE_WORKING_ID,
  type Stage,
  WEB_WORKSPACE_DATABASE,
} from './generated/core'

const JSON_TABLES: ReadonlyArray<string> = [
  'people',
  'account_labels',
  'account_refs',
  'chat_triage',
  'contacts',
  'chat_contact_links',
  'facts',
  'pins',
  'templates',
  'follow_ups',
  'internal_notes',
  'deals',
  'ai_drafts',
  'members',
  'account_grants',
  'assignments',
  'handoffs',
  'webhook_endpoints',
  'webhook_deliveries',
  'stages',
]

const RECORD_STORES: ReadonlyArray<string> = [
  'schema_meta',
  ...JSON_TABLES,
  'cases',
  'case_chats',
  'case_participants',
  'case_messages',
  'case_notes',
  'case_files',
  'case_events',
]

const CASE_KINDS: ReadonlyArray<CaseKind> = ['Request', 'Deal']
const CASE_STATUSES: ReadonlyArray<CaseStatus> = ['Open', 'Closed']
const CASE_OUTCOMES: ReadonlyArray<CaseOutcome> = [
  'None',
  'Won',
  'Resolved',
  'Lost',
  'Dropped',
]
const PRIORITIES: ReadonlyArray<Priority> = ['Low', 'Normal', 'High', 'Urgent']
const CASE_ROLES: ReadonlyArray<CaseRole> = ['Primary', 'Related']
const MEDIA_KINDS: ReadonlyArray<MediaKind> = [
  'None',
  'Photo',
  'Video',
  'VideoNote',
  'Voice',
  'Audio',
  'File',
  'Sticker',
  'Animation',
  'Other',
]
const FILE_SOURCES: ReadonlyArray<FileSourceKind> = ['Telegram', 'Local']
const EVENT_KINDS: ReadonlyArray<CaseEventKind> = [
  'Created',
  'StageChanged',
  'PriorityChanged',
  'DueChanged',
  'OwnerChanged',
  'TitleChanged',
  'KindChanged',
  'FollowUpSet',
  'FollowUpCleared',
  'FollowUpSnoozed',
  'MessageAttached',
  'MessageDetached',
  'NoteAdded',
  'FileAdded',
  'ParticipantAdded',
  'ParticipantRemoved',
  'ChatLinked',
  'ChatUnlinked',
  'Closed',
  'Reopened',
]

const SEEDED_STAGES: ReadonlyArray<Stage> = [
  { id: STAGE_NEW_ID, name: 'New', color: 'blue', order: 0 },
  { id: STAGE_WORKING_ID, name: 'Working', color: 'violet', order: 1 },
  { id: STAGE_WAITING_ID, name: 'Waiting', color: 'orange', order: 2 },
  { id: STAGE_READY_ID, name: 'Ready', color: 'green', order: 3 },
]

const SEEDED_MEMBER: Member = {
  id: MEMBER_YOU_ID,
  display_name: MEMBER_YOU_NAME,
  role: 'Owner',
  credential_hash: '',
  revoked: false,
}

export type Payload =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Payload>
  | { readonly [key: string]: Payload }

export type WorkspaceTag =
  | 'Invalid'
  | 'DuplicateLink'
  | 'NewerSchema'
  | 'Missing'
  | 'Unavailable'

export class WorkspaceError extends Error {
  readonly _tag: WorkspaceTag
  constructor(_tag: WorkspaceTag, message: string) {
    super(message)
    this._tag = _tag
    this.name = 'WorkspaceError'
  }
}

export const personNotesUnavailable = (place: string): string =>
  `Person notes are unavailable (${place})`

const openings = new Map<string, Promise<Workspace>>()

export class Workspace {
  readonly name: string
  private readonly database: IDBDatabase

  constructor(database: IDBDatabase, name: string) {
    this.database = database
    this.name = name
  }

  close(): void {
    this.database.close()
  }

  async schemaVersion(): Promise<number> {
    const meta = await getValue(this.database, 'schema_meta', 1)
    if (!isRecord(meta)) return 0
    const version = meta['schema_version']
    return typeof version === 'number' ? version : 0
  }

  async putRecord(table: string, id: string, value: unknown): Promise<void> {
    if (!JSON_TABLES.includes(table)) {
      throw new WorkspaceError('Invalid', 'unknown workspace table')
    }
    await putValue(this.database, table, value, id)
  }

  async getRecord(table: string, id: string): Promise<unknown> {
    if (!JSON_TABLES.includes(table)) {
      throw new WorkspaceError('Invalid', 'unknown workspace table')
    }
    const value = await getValue(this.database, table, id)
    return value === undefined ? null : value
  }

  async recordLogin(
    accountId: string,
    label: string,
    payload: Payload,
    now: number,
  ): Promise<AccountLabel> {
    const record = loginRecord(accountId, label, payload)
    if (record.accountId === '') {
      throw new WorkspaceError('Invalid', 'account id is empty')
    }
    const row: AccountLabel = {
      account_id: record.accountId,
      label: record.label,
      updated_at: now,
      observed_name: record.observedName,
      connection: 'connected',
    }
    await putValue(this.database, 'account_labels', row, row.account_id)
    return row
  }

  async noteLogout(accountId: string): Promise<void> {
    await this.setConnection(accountId, 'logged_out')
  }

  async noteAccountRemoved(accountId: string): Promise<void> {
    await this.setConnection(accountId, 'removed')
  }

  async insertCase(draft: CaseDraft, now: number): Promise<CaseBundle> {
    const title = requireCaseTitle(draft.title)
    onePrimary(draft.chats, chat => chat.role, 'a case has one primary chat')
    onePrimary(
      draft.participants,
      participant => participant.role,
      'a case has one primary participant',
    )
    const existing = await getValues(this.database, 'cases')
    const numbers: Array<number> = []
    for (const value of existing) {
      const row = decodeCase(value)
      if (row !== null) numbers.push(row.number)
    }
    const caseRow: Case = {
      id: draft.id,
      number: nextCaseNumber(numbers),
      title,
      kind: draft.kind,
      status: 'Open',
      stage_id: draft.stage_id,
      outcome: 'None',
      outcome_note: '',
      amount_minor: null,
      currency: null,
      priority: draft.priority,
      owner_id: draft.owner_id,
      due_at: draft.due_at,
      follow_up_at: draft.follow_up_at,
      reply_account_id: draft.reply_account_id,
      primary_chat: draft.primary_chat,
      created_at: now,
      updated_at: now,
      closed_at: null,
      last_opened_at: null,
    }
    const chats = draft.chats.map(chat => ({ ...chat, case_id: draft.id }))
    const participants = draft.participants.map(participant => ({
      ...participant,
      case_id: draft.id,
    }))
    const messages = draft.messages.map(message => ({
      ...message,
      case_id: draft.id,
      snapshot: {
        ...message.snapshot,
        text: requireSnapshotText(message.snapshot.text),
      },
    }))
    const notes = draft.notes.map(note => ({ ...note, case_id: draft.id }))
    const files = draft.files.map(file => ({ ...file, case_id: draft.id }))
    const events = draft.events.map(event => ({ ...event, case_id: draft.id }))
    for (const message of messages) {
      await assertNewMessage(this.database, message)
    }
    const records: Array<StoreRecord> = [
      { store: 'cases', value: caseRow, key: caseRow.id },
    ]
    for (const chat of chats) {
      records.push({ store: 'case_chats', value: chat, key: chatKey(chat) })
    }
    for (const participant of participants) {
      records.push({
        store: 'case_participants',
        value: participant,
        key: participantKey(participant),
      })
    }
    for (const message of messages) {
      records.push({
        store: 'case_messages',
        value: message,
        key: messageKey(message),
      })
    }
    for (const note of notes) {
      records.push({ store: 'case_notes', value: note, key: note.id })
    }
    for (const file of files) {
      records.push({ store: 'case_files', value: file, key: file.id })
    }
    for (const event of events) {
      records.push({ store: 'case_events', value: event, key: event.id })
    }
    await writeMany(this.database, records)
    const bundle = await this.caseBundle(draft.id)
    if (bundle === null) {
      throw new WorkspaceError('Missing', 'missing workspace row')
    }
    return bundle
  }

  async attachMessage(message: CaseMessage): Promise<void> {
    if (message.message.message_id === '') {
      throw new WorkspaceError('Invalid', 'message id is empty')
    }
    const next: CaseMessage = {
      ...message,
      snapshot: {
        ...message.snapshot,
        text: requireSnapshotText(message.snapshot.text),
      },
    }
    await assertNewMessage(this.database, next)
    await writeMany(this.database, [
      { store: 'case_messages', value: next, key: messageKey(next) },
    ])
  }

  async closeCase(
    id: string,
    outcome: CaseOutcome,
    note: string,
    at: number,
  ): Promise<Case> {
    const bundle = await this.caseBundle(id)
    if (bundle === null) {
      throw new WorkspaceError('Missing', 'missing workspace row')
    }
    const next: Case = {
      ...bundle.case,
      status: 'Closed',
      outcome,
      outcome_note: requireOutcomeNote(note),
      closed_at: at,
      updated_at: at,
    }
    await putValue(this.database, 'cases', next, id)
    return next
  }

  async caseBundle(id: string): Promise<CaseBundle | null> {
    const caseRow = await readCaseRow(this.database, id)
    if (caseRow === null) return null
    return {
      case: caseRow,
      chats: await readChildren(
        this.database,
        'case_chats',
        id,
        decodeCaseChat,
      ),
      participants: await readChildren(
        this.database,
        'case_participants',
        id,
        decodeParticipant,
      ),
      messages: await readChildren(
        this.database,
        'case_messages',
        id,
        decodeCaseMessage,
      ),
      notes: await readChildren(this.database, 'case_notes', id, decodeNote),
      files: await readChildren(this.database, 'case_files', id, decodeFile),
      events: await readChildren(this.database, 'case_events', id, decodeEvent),
    }
  }

  async dump(): Promise<string> {
    const chunks: Array<unknown> = []
    for (
      let index = 0;
      index < this.database.objectStoreNames.length;
      index += 1
    ) {
      const name = this.database.objectStoreNames.item(index)
      if (name !== null) chunks.push(await getValues(this.database, name))
    }
    return JSON.stringify(chunks)
  }

  private async setConnection(
    accountId: string,
    connection: string,
  ): Promise<void> {
    const value = await getValue(this.database, 'account_labels', accountId)
    if (value === undefined) return
    const row = decodeAccountLabel(value)
    if (row === null) {
      throw new WorkspaceError('Invalid', 'account label is unreadable')
    }
    await putValue(
      this.database,
      'account_labels',
      { ...row, connection },
      accountId,
    )
  }
}

export const openWorkspace = (
  name: string = WEB_WORKSPACE_DATABASE,
): Promise<Workspace> => {
  const cached = openings.get(name)
  if (cached !== undefined) return cached
  const created = openNamed(name)
  openings.set(name, created)
  void created.catch(() => {
    openings.delete(name)
  })
  return created
}

export const closeWorkspace = async (
  name: string = WEB_WORKSPACE_DATABASE,
): Promise<void> => {
  const cached = openings.get(name)
  openings.delete(name)
  if (cached === undefined) return
  const store = await cached
  store.close()
}

export const reopenWorkspace = async (
  name: string = WEB_WORKSPACE_DATABASE,
): Promise<Workspace> => {
  await closeWorkspace(name)
  return openWorkspace(name)
}

export const deleteWorkspace = async (
  name: string = WEB_WORKSPACE_DATABASE,
): Promise<void> => {
  await closeWorkspace(name)
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.addEventListener('success', () => resolve())
    request.addEventListener('blocked', () => resolve())
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('workspace delete failed'))
    })
  })
}

export const readWorkspaceStatus = async (): Promise<{ notice: string }> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    try {
      const value = await invoke('workspace_status')
      if (isRecord(value) && typeof value['notice'] === 'string') {
        return { notice: value['notice'] }
      }
      return { notice: '' }
    } catch {
      return { notice: personNotesUnavailable('app data') }
    }
  }
  try {
    await openWorkspace()
    return { notice: '' }
  } catch {
    return { notice: personNotesUnavailable(globalThis.location.origin) }
  }
}

export const rememberAccounts = async (
  accounts: ReadonlyArray<{ id: string; title: string }>,
): Promise<void> => {
  if (accounts.length === 0) return
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    try {
      await invoke('workspace_remember_accounts', { accounts })
    } catch {
      // Storage must not fail Telegram login.
    }
    return
  }
  try {
    const store = await openWorkspace()
    const now = await Effect.runPromise(Clock.currentTimeMillis)
    for (const account of accounts) {
      await store.recordLogin(
        account.id,
        account.title,
        { account_id: account.id, label: account.title },
        now,
      )
    }
  } catch {
    // Storage must not fail Telegram login.
  }
}

export const noteLoggedOut = async (id: string): Promise<void> => {
  if (tauriInvoke() !== undefined) return
  try {
    const store = await openWorkspace()
    await store.noteLogout(id)
  } catch {
    // The Telegram session is already gone. Keep the CRM rows.
  }
}

const openNamed = async (name: string): Promise<Workspace> => {
  try {
    const database = await openDatabase(
      name,
      SCHEMA_VERSION,
      (store, oldVersion) => {
        if (oldVersion < 1) createVersionOneStores(store)
      },
    )
    await seed(database)
    return new Workspace(database, name)
  } catch (error) {
    if (isVersionError(error)) {
      throw new WorkspaceError(
        'NewerSchema',
        'workspace schema is newer than this build',
      )
    }
    throw error
  }
}

const createVersionOneStores = (database: IDBDatabase): void => {
  for (const name of RECORD_STORES) {
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name)
    }
  }
}

const seed = async (database: IDBDatabase): Promise<void> => {
  const version = await getValue(database, 'schema_meta', 1)
  if (version === undefined) {
    await putValue(
      database,
      'schema_meta',
      { schema_version: SCHEMA_VERSION },
      1,
    )
  }
  for (const stage of SEEDED_STAGES) {
    const existing = await getValue(database, 'stages', stage.id)
    if (existing === undefined) {
      await putValue(database, 'stages', stage, stage.id)
    }
  }
  const member = await getValue(database, 'members', SEEDED_MEMBER.id)
  if (member === undefined) {
    await putValue(database, 'members', SEEDED_MEMBER, SEEDED_MEMBER.id)
  }
}

const loginRecord = (
  accountId: string,
  label: string,
  payload: Payload,
): { accountId: string; label: string; observedName: string } => {
  const secrets = secretValues(payload)
  return {
    accountId: blankIfSecret(accountId, secrets),
    label: blankIfSecret(label, secrets),
    observedName: observedName(stripPayload(payload, secrets)),
  }
}

const secretValues = (payload: Payload): Array<string> => {
  const values: Array<string> = []
  collectSecretValues(payload, values)
  return values
}

const isPayloadRecord = (
  value: Payload,
): value is { readonly [key: string]: Payload } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const collectSecretValues = (payload: Payload, values: Array<string>): void => {
  if (Array.isArray(payload)) {
    for (const item of payload) collectSecretValues(item, values)
    return
  }
  if (!isPayloadRecord(payload)) return
  for (const key of Object.keys(payload)) {
    const value = payload[key]
    if (value === undefined) continue
    if (isSecretField(key)) collectText(value, values)
    collectSecretValues(value, values)
  }
}

const collectText = (payload: Payload, values: Array<string>): void => {
  if (typeof payload === 'string') {
    if (payload !== '') values.push(payload)
    return
  }
  if (Array.isArray(payload)) {
    for (const item of payload) collectText(item, values)
    return
  }
  if (!isPayloadRecord(payload)) return
  for (const key of Object.keys(payload)) {
    const value = payload[key]
    if (value !== undefined) collectText(value, values)
  }
}

const stripPayload = (
  payload: Payload,
  secrets: ReadonlyArray<string>,
): Payload => {
  if (typeof payload === 'string') return blankIfSecret(payload, secrets)
  if (
    typeof payload === 'number' ||
    typeof payload === 'boolean' ||
    payload === null
  ) {
    return payload
  }
  if (Array.isArray(payload)) {
    return payload.map(item => stripPayload(item, secrets))
  }
  if (!isPayloadRecord(payload)) return payload
  const entries: { [key: string]: Payload } = {}
  for (const key of Object.keys(payload)) {
    if (isSecretField(key)) continue
    const value = payload[key]
    if (value === undefined) continue
    entries[key] = stripPayload(value, secrets)
  }
  return entries
}

const blankIfSecret = (text: string, secrets: ReadonlyArray<string>): string =>
  text === '' || secrets.includes(text) ? '' : text

const observedName = (payload: Payload): string => {
  if (!isPayloadRecord(payload)) return ''
  for (const key of ['display_name', 'name', 'title', 'first_name']) {
    const value = payload[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

const normalizeFieldName = (name: string): string =>
  name.replaceAll('_', '').replaceAll('-', '').toLowerCase()

const isSecretField = (name: string): boolean => {
  const normalized = normalizeFieldName(name)
  return SECRET_FIELD_NAMES.some(
    candidate => normalizeFieldName(candidate) === normalized,
  )
}

const requireCaseTitle = (raw: string): string => {
  const trimmed = raw.trim()
  const count = [...trimmed].length
  if (count === 0 || count > 120) {
    throw new WorkspaceError(
      'Invalid',
      'case title must be 1 to 120 characters',
    )
  }
  return trimmed
}

const requireSnapshotText = (raw: string): string => {
  const trimmed = raw.trim()
  if ([...trimmed].length > 500) {
    throw new WorkspaceError(
      'Invalid',
      'snapshot text must be at most 500 characters',
    )
  }
  return trimmed
}

const requireOutcomeNote = (raw: string): string => {
  const trimmed = raw.trim()
  if ([...trimmed].length > 500) {
    throw new WorkspaceError(
      'Invalid',
      'outcome note must be at most 500 characters',
    )
  }
  return trimmed
}

const nextCaseNumber = (used: ReadonlyArray<number>): number => {
  let max = 0
  for (const number of used) if (number > max) max = number
  return max + 1
}

const onePrimary = <T>(
  items: ReadonlyArray<T>,
  role: (item: T) => string,
  message: string,
): void => {
  let count = 0
  for (const item of items) if (role(item) === 'Primary') count += 1
  if (count > 1) throw new WorkspaceError('Invalid', message)
}

type StoreRecord = { store: string; value: unknown; key: IDBValidKey }

const messageKey = (message: CaseMessage): IDBValidKey => [
  message.case_id,
  message.message.account_id,
  message.message.chat_id,
  message.message.message_id,
]

const chatKey = (chat: CaseChat): IDBValidKey => [
  chat.case_id,
  chat.chat.account_id,
  chat.chat.chat_id,
]

const participantKey = (participant: CaseParticipant): IDBValidKey => [
  participant.case_id,
  participant.telegram_user_id,
]

const assertNewMessage = async (
  database: IDBDatabase,
  message: CaseMessage,
): Promise<void> => {
  if (message.message.message_id === '') {
    throw new WorkspaceError('Invalid', 'message id is empty')
  }
  const existing = await getValue(
    database,
    'case_messages',
    messageKey(message),
  )
  if (existing !== undefined) {
    throw new WorkspaceError(
      'DuplicateLink',
      'that message is already linked to this case',
    )
  }
}

const readCaseRow = async (
  database: IDBDatabase,
  id: string,
): Promise<Case | null> => {
  const value = await getValue(database, 'cases', id)
  if (value === undefined) return null
  const decoded = decodeCase(value)
  if (decoded === null) {
    throw new WorkspaceError('Invalid', 'case row is unreadable')
  }
  return decoded
}

const readChildren = async <T extends { case_id: string }>(
  database: IDBDatabase,
  store: string,
  caseId: string,
  decode: (value: unknown) => T | null,
): Promise<Array<T>> => {
  const values = await getValues(database, store)
  const rows: Array<T> = []
  for (const value of values) {
    if (!isRecord(value) || value['case_id'] !== caseId) continue
    const decoded = decode(value)
    if (decoded === null) {
      throw new WorkspaceError(
        'Invalid',
        `workspace ${store} row is unreadable`,
      )
    }
    rows.push(decoded)
  }
  return rows
}

const decodeAccountLabel = (value: unknown): AccountLabel | null => {
  if (!isRecord(value)) return null
  const account_id = readString(value, 'account_id')
  const label = readString(value, 'label')
  const updated_at = readNumber(value, 'updated_at')
  const observed_name = readString(value, 'observed_name')
  const connection = readString(value, 'connection')
  if (
    account_id === null ||
    label === null ||
    updated_at === null ||
    observed_name === null ||
    connection === null
  ) {
    return null
  }
  return { account_id, label, updated_at, observed_name, connection }
}

const decodeCase = (value: unknown): Case | null => {
  if (!isRecord(value)) return null
  const id = readString(value, 'id')
  const number = readNumber(value, 'number')
  const title = readString(value, 'title')
  const kind = readUnion(value['kind'], CASE_KINDS)
  const status = readUnion(value['status'], CASE_STATUSES)
  const stage_id = readString(value, 'stage_id')
  const outcome = readUnion(value['outcome'], CASE_OUTCOMES)
  const outcome_note = readString(value, 'outcome_note')
  const amount_minor = readNumberOrNull(value, 'amount_minor')
  const currency = readStringOrNull(value, 'currency')
  const priority = readUnion(value['priority'], PRIORITIES)
  const owner_id = readString(value, 'owner_id')
  const due_at = readNumberOrNull(value, 'due_at')
  const follow_up_at = readNumberOrNull(value, 'follow_up_at')
  const reply_account_id = readString(value, 'reply_account_id')
  const primary_chat = readRefOrNull(value, 'primary_chat')
  const created_at = readNumber(value, 'created_at')
  const updated_at = readNumber(value, 'updated_at')
  const closed_at = readNumberOrNull(value, 'closed_at')
  const last_opened_at = readNumberOrNull(value, 'last_opened_at')
  if (
    id === null ||
    number === null ||
    title === null ||
    kind === null ||
    status === null ||
    stage_id === null ||
    outcome === null ||
    outcome_note === null ||
    amount_minor === undefined ||
    currency === undefined ||
    priority === null ||
    owner_id === null ||
    due_at === undefined ||
    follow_up_at === undefined ||
    reply_account_id === null ||
    primary_chat === undefined ||
    created_at === null ||
    updated_at === null ||
    closed_at === undefined ||
    last_opened_at === undefined
  ) {
    return null
  }
  return {
    id,
    number,
    title,
    kind,
    status,
    stage_id,
    outcome,
    outcome_note,
    amount_minor,
    currency,
    priority,
    owner_id,
    due_at,
    follow_up_at,
    reply_account_id,
    primary_chat,
    created_at,
    updated_at,
    closed_at,
    last_opened_at,
  }
}

const decodeCaseChat = (value: unknown): CaseChat | null => {
  if (!isRecord(value)) return null
  const case_id = readString(value, 'case_id')
  const chat = readMessageRef(value['chat'])
  const role = readUnion(value['role'], CASE_ROLES)
  const title_snapshot = readString(value, 'title_snapshot')
  const account_label_snapshot = readString(value, 'account_label_snapshot')
  if (
    case_id === null ||
    chat === null ||
    role === null ||
    title_snapshot === null ||
    account_label_snapshot === null
  ) {
    return null
  }
  return { case_id, chat, role, title_snapshot, account_label_snapshot }
}

const decodeParticipant = (value: unknown): CaseParticipant | null => {
  if (!isRecord(value)) return null
  const case_id = readString(value, 'case_id')
  const telegram_user_id = readString(value, 'telegram_user_id')
  const role = readUnion(value['role'], CASE_ROLES)
  const name_snapshot = readString(value, 'name_snapshot')
  const username_snapshot = readString(value, 'username_snapshot')
  if (
    case_id === null ||
    telegram_user_id === null ||
    role === null ||
    name_snapshot === null ||
    username_snapshot === null
  ) {
    return null
  }
  return { case_id, telegram_user_id, role, name_snapshot, username_snapshot }
}

const decodeCaseMessage = (value: unknown): CaseMessage | null => {
  if (!isRecord(value)) return null
  const case_id = readString(value, 'case_id')
  const message = readMessageRef(value['message'])
  const attached_at = readNumber(value, 'attached_at')
  const attached_by = readString(value, 'attached_by')
  const snapshot = decodeSnapshot(value['snapshot'])
  if (
    case_id === null ||
    message === null ||
    attached_at === null ||
    attached_by === null ||
    snapshot === null
  ) {
    return null
  }
  return { case_id, message, attached_at, attached_by, snapshot }
}

const decodeNote = (value: unknown): CaseNote | null => {
  if (!isRecord(value)) return null
  const id = readString(value, 'id')
  const case_id = readString(value, 'case_id')
  const body = readString(value, 'body')
  const created_at = readNumber(value, 'created_at')
  const author_id = readString(value, 'author_id')
  const source = readRefOrNull(value, 'source')
  if (
    id === null ||
    case_id === null ||
    body === null ||
    created_at === null ||
    author_id === null ||
    source === undefined
  ) {
    return null
  }
  return { id, case_id, body, created_at, author_id, source }
}

const decodeFile = (value: unknown): CaseFile | null => {
  if (!isRecord(value)) return null
  const id = readString(value, 'id')
  const case_id = readString(value, 'case_id')
  const added_at = readNumber(value, 'added_at')
  const name = readString(value, 'name')
  const byte_length = readNumber(value, 'byte_length')
  const media_type = readString(value, 'media_type')
  const source_kind = readUnion(value['source_kind'], FILE_SOURCES)
  const source = readRefOrNull(value, 'source')
  const relative_path = readString(value, 'relative_path')
  if (
    id === null ||
    case_id === null ||
    added_at === null ||
    name === null ||
    byte_length === null ||
    media_type === null ||
    source_kind === null ||
    source === undefined ||
    relative_path === null
  ) {
    return null
  }
  return {
    id,
    case_id,
    added_at,
    name,
    byte_length,
    media_type,
    source_kind,
    source,
    relative_path,
  }
}

const decodeEvent = (value: unknown): CaseEvent | null => {
  if (!isRecord(value)) return null
  const id = readString(value, 'id')
  const case_id = readString(value, 'case_id')
  const at = readNumber(value, 'at')
  const kind = readUnion(value['kind'], EVENT_KINDS)
  const from_id = readString(value, 'from_id')
  const to_id = readString(value, 'to_id')
  const from_name = readString(value, 'from_name')
  const to_name = readString(value, 'to_name')
  const quote = readString(value, 'quote')
  const outcome = readUnion(value['outcome'], CASE_OUTCOMES)
  const stage_id = readString(value, 'stage_id')
  const stage_name = readString(value, 'stage_name')
  const follow_up_at = readNumberOrNull(value, 'follow_up_at')
  if (
    id === null ||
    case_id === null ||
    at === null ||
    kind === null ||
    from_id === null ||
    to_id === null ||
    from_name === null ||
    to_name === null ||
    quote === null ||
    outcome === null ||
    stage_id === null ||
    stage_name === null ||
    follow_up_at === undefined
  ) {
    return null
  }
  return {
    id,
    case_id,
    at,
    kind,
    from_id,
    to_id,
    from_name,
    to_name,
    quote,
    outcome,
    stage_id,
    stage_name,
    follow_up_at,
  }
}

const decodeSnapshot = (value: unknown): MessageSnapshot | null => {
  if (!isRecord(value)) return null
  const text = readString(value, 'text')
  const sent_at = readNumber(value, 'sent_at')
  const sender_name = readString(value, 'sender_name')
  const sender_user_id = readString(value, 'sender_user_id')
  const outgoing = readBoolean(value, 'outgoing')
  const media_kind = readUnion(value['media_kind'], MEDIA_KINDS)
  const chat_title = readString(value, 'chat_title')
  const account_label = readString(value, 'account_label')
  if (
    text === null ||
    sent_at === null ||
    sender_name === null ||
    sender_user_id === null ||
    outgoing === null ||
    media_kind === null ||
    chat_title === null ||
    account_label === null
  ) {
    return null
  }
  return {
    text,
    sent_at,
    sender_name,
    sender_user_id,
    outgoing,
    media_kind,
    chat_title,
    account_label,
  }
}

const readMessageRef = (value: unknown): MessageRef | null => {
  if (!isRecord(value)) return null
  const account_id = readString(value, 'account_id')
  const chat_id = readString(value, 'chat_id')
  const telegram_chat_id = readString(value, 'telegram_chat_id')
  const message_id = readString(value, 'message_id')
  const message_thread_id = readString(value, 'message_thread_id')
  if (
    account_id === null ||
    chat_id === null ||
    telegram_chat_id === null ||
    message_id === null ||
    message_thread_id === null
  ) {
    return null
  }
  return {
    account_id,
    chat_id,
    telegram_chat_id,
    message_id,
    message_thread_id,
  }
}

const readRefOrNull = (
  record: Record<string, unknown>,
  key: string,
): MessageRef | null | undefined => {
  const value = record[key]
  if (value === null) return null
  const ref = readMessageRef(value)
  return ref === null ? undefined : ref
}

const readUnion = <T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
): T | null => {
  if (typeof value !== 'string') return null
  for (const candidate of allowed) {
    if (candidate === value) return candidate
  }
  return null
}

const readString = (
  record: Record<string, unknown>,
  key: string,
): string | null => {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

const readNumber = (
  record: Record<string, unknown>,
  key: string,
): number | null => {
  const value = record[key]
  return typeof value === 'number' ? value : null
}

const readBoolean = (
  record: Record<string, unknown>,
  key: string,
): boolean | null => {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

const readNumberOrNull = (
  record: Record<string, unknown>,
  key: string,
): number | null | undefined => {
  const value = record[key]
  if (value === null) return null
  if (typeof value === 'number') return value
  return undefined
}

const readStringOrNull = (
  record: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  const value = record[key]
  if (value === null) return null
  if (typeof value === 'string') return value
  return undefined
}

const isRecord = (
  value: unknown,
): value is { readonly [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isVersionError = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'VersionError'

const openDatabase = (
  name: string,
  version: number,
  upgrade?: (database: IDBDatabase, oldVersion: number) => void,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.addEventListener('upgradeneeded', event => {
      const oldVersion =
        event instanceof IDBVersionChangeEvent ? event.oldVersion : 0
      upgrade?.(request.result, oldVersion)
    })
    request.addEventListener('success', () => resolve(request.result))
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('workspace open failed'))
    })
  })

const request = (made: IDBRequest): Promise<unknown> =>
  new Promise((resolve, reject) => {
    made.addEventListener('success', () => resolve(made.result))
    made.addEventListener('error', () => {
      reject(made.error ?? new Error('workspace request failed'))
    })
  })

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.addEventListener('complete', () => resolve())
    tx.addEventListener('abort', () => {
      reject(tx.error ?? new Error('workspace transaction aborted'))
    })
  })

const getValue = async (
  database: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<unknown> => {
  const tx = database.transaction(store, 'readonly')
  return request(tx.objectStore(store).get(key))
}

const getValues = async (
  database: IDBDatabase,
  store: string,
): Promise<Array<unknown>> => {
  const tx = database.transaction(store, 'readonly')
  const value = await request(tx.objectStore(store).getAll())
  if (!Array.isArray(value)) return []
  const rows: Array<unknown> = []
  for (const row of value) rows.push(row)
  return rows
}

const putValue = async (
  database: IDBDatabase,
  store: string,
  value: unknown,
  key: IDBValidKey,
): Promise<void> => {
  const tx = database.transaction(store, 'readwrite')
  tx.objectStore(store).put(value, key)
  await transactionDone(tx)
}

const writeMany = (
  database: IDBDatabase,
  records: ReadonlyArray<StoreRecord>,
): Promise<void> => {
  const names: Array<string> = []
  for (const record of records) {
    if (!names.includes(record.store)) names.push(record.store)
  }
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readwrite')
    tx.addEventListener('complete', () => resolve())
    tx.addEventListener('abort', () => {
      reject(tx.error ?? new Error('workspace transaction aborted'))
    })
    for (const record of records) {
      tx.objectStore(record.store).add(record.value, record.key)
    }
  })
}

const tauriInvoke = ():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined => {
  const internals: unknown = Reflect.get(globalThis, '__TAURI_INTERNALS__')
  if (!isRecord(internals)) return undefined
  const invoke: unknown = Reflect.get(internals, 'invoke')
  if (typeof invoke !== 'function') return undefined
  return (command, args) => Promise.resolve(invoke(command, args))
}
