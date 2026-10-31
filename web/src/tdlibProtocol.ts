export type ChatKind = 'Dialog' | 'Group' | 'Channel'

export type Chat = {
  id: string
  title: string
  kind: ChatKind
}

export type Account = {
  id: string
  title: string
  chats: Array<Chat>
}

export type Message = {
  id: string
  text: string
  outgoing: boolean
  date: number
}

export type ChatPreview = {
  id: string
  time: string
  preview: string
  unread: number
  receipt: 'none' | 'sent' | 'read'
}

export const clockTime = (unix: number): string => {
  if (!Number.isFinite(unix) || unix <= 0) {
    return ''
  }
  const date = new Date(unix * 1000)
  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')
  return `${hours}:${minutes}`
}

export type AuthStep =
  | { _tag: 'Code'; id: string }
  | { _tag: 'Password'; id: string; hint: string }
  | { _tag: 'Qr'; id: string; link: string }
  | { _tag: 'Authorized'; account: Account }

export type Phase =
  | { _tag: 'Opening' }
  | { _tag: 'WaitPhone' }
  | { _tag: 'WaitCode' }
  | { _tag: 'WaitPassword'; hint: string }
  | { _tag: 'WaitQr'; link: string }
  | { _tag: 'Ready' }
  | { _tag: 'Closed' }
  | { _tag: 'Failed'; error: string }

export type TdQuery = Record<string, unknown>

export type TdSink = {
  send: (query: TdQuery) => Promise<unknown>
  close: () => Promise<void>
  // Drops the client without writing the in-memory filesystem back.
  drop?: () => Promise<void>
  // Copies the in-memory database to IndexedDB. Absent on the desktop sink.
  sync?: () => Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined

const typeName = (value: unknown): string => {
  const name = field(value, '@type')
  return typeof name === 'string' ? name : ''
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : ''

// releaseModule answers in-flight queries with this when a receive trap drops
// the wasm instance. Callers retry once; the retry waits until the new
// instance has left Opening.
export const RUNTIME_REOPEN = 'RUNTIME_REOPEN'

export const validAccountId = (id: string): boolean =>
  id.length > 0 &&
  id.length <= 80 &&
  [...id].every(
    character =>
      (character >= 'a' && character <= 'z') ||
      (character >= 'A' && character <= 'Z') ||
      (character >= '0' && character <= '9') ||
      character === '-' ||
      character === '_',
  )

export const publicError = (value: unknown): string | undefined => {
  if (typeName(value) !== 'error') {
    return undefined
  }
  const message = text(field(value, 'message'))
  if (
    message.length > 0 &&
    [...message].every(
      character =>
        (character >= 'A' && character <= 'Z') ||
        (character >= '0' && character <= '9') ||
        character === '_',
    )
  ) {
    return message
  }
  return 'REQUEST_FAILED'
}

export const chatKind = (
  typeName: string,
  isChannel: boolean,
): ChatKind | undefined => {
  if (typeName === 'chatTypePrivate' || typeName === 'chatTypeSecret') {
    return 'Dialog'
  }
  if (typeName === 'chatTypeBasicGroup') {
    return 'Group'
  }
  if (typeName === 'chatTypeSupergroup') {
    return isChannel ? 'Channel' : 'Group'
  }
  return undefined
}

export const phaseFromAuthorization = (state: unknown): Phase => {
  const name = typeName(state)
  if (name === 'authorizationStateWaitTdlibParameters') {
    return { _tag: 'Opening' }
  }
  if (name === 'authorizationStateWaitPhoneNumber') {
    return { _tag: 'WaitPhone' }
  }
  if (name === 'authorizationStateWaitCode') {
    return { _tag: 'WaitCode' }
  }
  if (name === 'authorizationStateWaitPassword') {
    return {
      _tag: 'WaitPassword',
      hint: text(field(state, 'password_hint')),
    }
  }
  if (name === 'authorizationStateWaitOtherDeviceConfirmation') {
    const link = text(field(state, 'link'))
    return link === ''
      ? { _tag: 'Failed', error: 'REQUEST_FAILED' }
      : { _tag: 'WaitQr', link }
  }
  if (name === 'authorizationStateReady') {
    return { _tag: 'Ready' }
  }
  if (
    name === 'authorizationStateClosed' ||
    name === 'authorizationStateClosing' ||
    name === 'authorizationStateLoggingOut'
  ) {
    return { _tag: 'Closed' }
  }
  if (
    name === 'authorizationStateWaitRegistration' ||
    name === 'authorizationStateWaitEmailAddress' ||
    name === 'authorizationStateWaitEmailCode' ||
    name === 'authorizationStateWaitPremiumPurchase'
  ) {
    return {
      _tag: 'Failed',
      error: 'Create your Telegram account in an official app first.',
    }
  }
  return { _tag: 'Failed', error: 'REQUEST_FAILED' }
}

const idValue = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value !== '') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

const chatIdArgument = (raw: string): number | string => {
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : raw
}

export const parametersQuery = (
  directory: string,
  apiId: number,
  apiHash: string,
): TdQuery => ({
  '@type': 'setTdlibParameters',
  api_hash: apiHash,
  api_id: apiId,
  application_version: '0.1.0',
  database_directory: directory,
  database_encryption_key: '',
  device_model: 'CRM Chat Web',
  files_directory: `${directory}/files`,
  system_language_code: 'en',
  system_version: '',
  use_chat_info_database: true,
  use_file_database: true,
  use_message_database: true,
  use_secret_chats: false,
  use_test_dc: false,
})

const accountTitle = (me: unknown): string => {
  const title = [text(field(me, 'first_name')), text(field(me, 'last_name'))]
    .filter(part => part !== '')
    .join(' ')
  return title === '' ? 'Telegram account' : title
}

const plain = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim()
  }
  return text(field(value, 'text')).trim()
}

const nestedText = (content: unknown, key: string, name: string): string =>
  text(field(field(content, key), name)).trim()

// Chat-list wording from Telegram Web K's English lang pack (AttachPhoto,
// AttachAudio, Chat.Service.PeerJoinedTelegram, AttachPhotoExpired). A caption
// wins over the media label, the same way the Web K dialog row does.
export const messagePreview = (content: unknown): string => {
  const caption = plain(field(content, 'caption'))
  switch (typeName(content)) {
    case 'messageText':
      return plain(field(content, 'text'))
    case 'messagePhoto':
      return caption === '' ? 'Photo' : caption
    case 'messageVideo':
      return caption === '' ? 'Video' : caption
    case 'messageAnimation':
      return caption === '' ? 'GIF' : caption
    case 'messageSticker': {
      const emoji = nestedText(content, 'sticker', 'emoji')
      return emoji === '' ? 'Sticker' : emoji
    }
    case 'messageVoiceNote':
      return 'Voice message'
    case 'messageVideoNote':
      return 'Video message'
    case 'messageAudio': {
      const title = nestedText(content, 'audio', 'title')
      if (title !== '') {
        return title
      }
      const file = nestedText(content, 'audio', 'file_name')
      return file === '' ? 'Audio file' : file
    }
    case 'messageDocument': {
      if (caption !== '') {
        return caption
      }
      const file = nestedText(content, 'document', 'file_name')
      return file === '' ? 'File' : file
    }
    case 'messageContact':
      return 'Contact'
    case 'messageLocation': {
      const live = field(content, 'live_period')
      return typeof live === 'number' && live > 0 ? 'Live Location' : 'Location'
    }
    case 'messageVenue': {
      const title = nestedText(content, 'venue', 'title')
      return title === '' ? 'Location' : title
    }
    case 'messagePoll': {
      const question = plain(field(field(content, 'poll'), 'question'))
      return question === '' ? 'Poll' : question
    }
    case 'messageGame': {
      const title = nestedText(content, 'game', 'title')
      return title === '' ? 'Game' : title
    }
    case 'messageDice': {
      const emoji = text(field(content, 'emoji')).trim()
      return emoji === '' ? '🎲' : emoji
    }
    case 'messageContactRegistered':
      return 'joined Telegram'
    case 'messageExpiredPhoto':
      return 'Photo has expired'
    case 'messageExpiredVideo':
      return 'Video has expired'
    case 'messageCall': {
      const reason = typeName(field(content, 'discard_reason'))
      if (
        reason === 'callDiscardReasonMissed' ||
        reason === 'callDiscardReasonDeclined'
      ) {
        return 'Missed call'
      }
      return 'Call'
    }
    case 'messageUnsupported':
      return 'Unsupported message'
    default:
      return ''
  }
}

const messageFrom = (value: unknown): Message | undefined => {
  const id = idValue(field(value, 'id'))
  if (id === undefined) {
    return undefined
  }
  const date = field(value, 'date')
  return {
    id,
    text: messagePreview(field(value, 'content')),
    outgoing: field(value, 'is_outgoing') === true,
    date: typeof date === 'number' ? date : 0,
  }
}

const STEP_TIMEOUT = 60_000
const DISCARD_TIMEOUT = 2_000

export class TdAccount {
  phase: Phase = { _tag: 'Opening' }
  chatListError: string | undefined = undefined
  previews: Array<ChatPreview> = []
  private readonly waiters: Array<() => void> = []
  private foldersReady = false
  private refetchChats = false
  private readonly folderWaiters: Array<() => void> = []

  constructor(
    private readonly sink: TdSink,
    readonly id: string,
  ) {}

  private generation = 0
  // Ready is published only after the following receive returns. That receive
  // has trapped in free() on a folded database, and the UI must still be in
  // Opening so restore can wait for the reopen.
  private readyHeld = false

  apply(value: unknown): void {
    if (typeName(value) === 'updateChatFolders') {
      this.foldersReady = true
      for (const waiter of this.folderWaiters.splice(0)) {
        waiter()
      }
    }
    if (typeName(value) !== 'updateAuthorizationState') {
      return
    }
    this.phase = phaseFromAuthorization(field(value, 'authorization_state'))
    this.generation += 1
    const generation = this.generation
    // Wake after the receive pump returns. A trap in that same pump can
    // cancel the wake and reopen the database before the UI leaves Opening.
    queueMicrotask(() => {
      if (generation !== this.generation) {
        return
      }
      for (const waiter of this.waiters.splice(0)) {
        waiter()
      }
    })
  }

  holdWaiters(): void {
    this.generation += 1
  }

  // The folder update belongs to the client that was just dropped. The next
  // loadChats has to wait for the reopened client's own update, or it runs
  // before the filter list exists and the chat list stays empty.
  forgetFolders(): void {
    this.foldersReady = false
    this.refetchChats = true
  }

  holdReady(): void {
    if (this.phase._tag !== 'Ready') {
      return
    }
    this.readyHeld = true
    this.holdWaiters()
  }

  releaseReady(): void {
    if (!this.readyHeld || this.phase._tag !== 'Ready') {
      return
    }
    this.readyHeld = false
    const generation = this.generation
    queueMicrotask(() => {
      if (generation !== this.generation) {
        return
      }
      for (const waiter of this.waiters.splice(0)) {
        waiter()
      }
    })
  }

  private async send(query: TdQuery): Promise<unknown> {
    const once = async () => {
      const response = await this.sink.send(query)
      const error = publicError(response)
      if (error !== undefined) {
        throw new Error(error)
      }
      return response
    }
    try {
      return await once()
    } catch (error) {
      if (!(error instanceof Error) || error.message !== RUNTIME_REOPEN) {
        throw error
      }
      return once()
    }
  }

  private waitFor(
    predicate: (phase: Phase) => boolean,
    timeout = STEP_TIMEOUT,
  ): Promise<Phase> {
    if (predicate(this.phase)) {
      return Promise.resolve(this.phase)
    }
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!predicate(this.phase)) {
          this.waiters.push(check)
          return
        }
        clearTimeout(timer)
        resolve(this.phase)
      }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(check)
        if (index >= 0) {
          this.waiters.splice(index, 1)
        }
        reject(new Error('Telegram did not answer in time'))
      }, timeout)
      this.waiters.push(check)
    })
  }

  async untilOpened(timeout: number): Promise<Phase> {
    return this.waitFor(phase => phase._tag !== 'Opening', timeout)
  }

  private async step(): Promise<AuthStep> {
    const phase = this.phase
    if (phase._tag === 'WaitCode') {
      return { _tag: 'Code', id: this.id }
    }
    if (phase._tag === 'WaitPassword') {
      return { _tag: 'Password', id: this.id, hint: phase.hint }
    }
    if (phase._tag === 'WaitQr') {
      return { _tag: 'Qr', id: this.id, link: phase.link }
    }
    if (phase._tag === 'Ready') {
      return { _tag: 'Authorized', account: await this.readAccount() }
    }
    if (phase._tag === 'Failed') {
      throw new Error(phase.error)
    }
    if (phase._tag === 'Closed') {
      throw new Error('Login expired. Add the account again.')
    }
    throw new Error('Telegram is still starting')
  }

  private async afterRequest(sent: Promise<unknown>): Promise<AuthStep> {
    const seen = this.generation
    const next = this.waitFor(() => this.generation !== seen)
    await sent
    await Promise.resolve()
    await next
    return this.step()
  }

  async beginPhone(phone: string): Promise<AuthStep> {
    await this.waitFor(
      phase =>
        phase._tag === 'WaitPhone' ||
        phase._tag === 'Ready' ||
        phase._tag === 'Failed',
    )
    if (this.phase._tag === 'Ready') {
      return this.step()
    }
    if (this.phase._tag === 'Failed') {
      throw new Error(this.phase.error)
    }
    const sent = this.send({
      '@type': 'setAuthenticationPhoneNumber',
      phone_number: phone,
      settings: {
        '@type': 'phoneNumberAuthenticationSettings',
        allow_flash_call: false,
        allow_missed_call: false,
        is_current_phone_number: false,
        has_unknown_phone_number: false,
        allow_sms_retriever_api: false,
        firebase_authentication_settings: null,
        authentication_tokens: [],
      },
    })
    return this.afterRequest(sent)
  }

  async beginQr(): Promise<AuthStep> {
    await this.waitFor(
      phase =>
        phase._tag === 'WaitPhone' ||
        phase._tag === 'WaitQr' ||
        phase._tag === 'Ready' ||
        phase._tag === 'Failed',
    )
    if (this.phase._tag === 'Ready' || this.phase._tag === 'WaitQr') {
      return this.step()
    }
    if (this.phase._tag === 'Failed') {
      throw new Error(this.phase.error)
    }
    const sent = this.send({
      '@type': 'requestQrCodeAuthentication',
      other_user_ids: [],
    })
    return this.afterRequest(sent)
  }

  async submitCode(code: string): Promise<AuthStep> {
    return this.afterRequest(
      this.send({ '@type': 'checkAuthenticationCode', code }),
    )
  }

  async submitPassword(password: string): Promise<AuthStep> {
    return this.afterRequest(
      this.send({ '@type': 'checkAuthenticationPassword', password }),
    )
  }

  poll(): Promise<AuthStep> {
    return this.step()
  }

  private async fetchChatIds(): Promise<Array<unknown> | undefined> {
    const chats = await this.send({
      '@type': 'getChats',
      chat_list: { '@type': 'chatListMain' },
      limit: 100,
    }).catch((error: unknown) => {
      this.chatListError =
        error instanceof Error && error.message !== ''
          ? error.message
          : 'REQUEST_FAILED'
      return undefined
    })
    if (chats === undefined) {
      return undefined
    }
    this.chatListError = undefined
    const ids = field(chats, 'chat_ids')
    return Array.isArray(ids) ? ids : []
  }

  private foldersOpened(): Promise<boolean> {
    if (this.foldersReady) {
      return Promise.resolve(true)
    }
    return new Promise(resolve => {
      const finish = (ready: boolean) => {
        clearTimeout(timer)
        resolve(ready)
      }
      const timer = setTimeout(() => {
        const index = this.folderWaiters.indexOf(onUpdate)
        if (index >= 0) {
          this.folderWaiters.splice(index, 1)
        }
        finish(false)
      }, 3_000)
      const onUpdate = () => {
        finish(true)
      }
      this.folderWaiters.push(onUpdate)
    })
  }

  private async loadChatIds(): Promise<Array<unknown> | undefined> {
    // getChats reads rows already in the database. loadChats hits the network
    // and aborts in DialogFilterManager::get_dialog_filter_folder_ids when a
    // filter id is not loaded yet (`dialog_filter != nullptr`). The first
    // updateChatFolders is sent while that reload is still running, so wait
    // it out. If the update never arrives, skip loadChats.
    const saved = await this.fetchChatIds()
    if (saved !== undefined && saved.length > 0) {
      this.chatListError = undefined
      return saved
    }
    const folders = await this.foldersOpened()
    if (!folders) {
      return saved
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 1_000)
    })
    await this.send({
      '@type': 'loadChats',
      chat_list: { '@type': 'chatListMain' },
      limit: 100,
    }).catch(() => undefined)
    return this.fetchChatIds()
  }

  async readAccount(): Promise<Account> {
    this.chatListError = undefined
    this.previews = []
    const me = await this.send({ '@type': 'getMe' })
    let ids = await this.loadChatIds()
    const timedOut = this.chatListError === 'REQUEST_FAILED'
    const empty = ids !== undefined && ids.length === 0
    if (timedOut || empty) {
      this.chatListError = undefined
      const again = await this.loadChatIds()
      if (again !== undefined) {
        ids = again
      }
    }
    // A reopened client can answer getChats before the network list arrives.
    // Keep asking while the list is empty so the shell does not stay blank.
    if (this.refetchChats) {
      this.refetchChats = false
      let emptyPasses = 0
      while (ids !== undefined && ids.length === 0 && emptyPasses < 4) {
        emptyPasses += 1
        this.chatListError = undefined
        const again = await this.loadChatIds()
        if (again === undefined) {
          break
        }
        ids = again
      }
    }
    if (ids === undefined) {
      return { id: this.id, title: accountTitle(me), chats: [] }
    }
    const parsed: Array<Chat> = []
    const previews: Array<ChatPreview> = []
    for (const chatId of ids) {
      const raw = idValue(chatId)
      if (raw === undefined) {
        continue
      }
      const chat = await this.send({
        '@type': 'getChat',
        chat_id: chatIdArgument(raw),
      }).catch(() => undefined)
      if (chat === undefined) {
        continue
      }
      const chatType = field(chat, 'type')
      const kind = chatKind(
        typeName(chatType),
        field(chatType, 'is_channel') === true,
      )
      if (kind === undefined) {
        continue
      }
      const title = text(field(chat, 'title'))
      const id = `${this.id}:${raw}`
      parsed.push({
        id,
        title: title === '' ? 'Unnamed chat' : title,
        kind,
      })
      const last = messageFrom(field(chat, 'last_message'))
      if (last !== undefined && last.text !== '') {
        const unread = field(chat, 'unread_count')
        previews.push({
          id,
          time: clockTime(last.date),
          preview: last.text,
          unread: typeof unread === 'number' && unread > 0 ? unread : 0,
          receipt: last.outgoing ? 'sent' : 'none',
        })
      }
    }
    this.previews = previews
    // Sync after the chat rows are loaded. The Ready transition's files are
    // still an incomplete database and crash TDLib on the next visit.
    if (this.sink.sync !== undefined) {
      await this.sink.sync()
    }
    return { id: this.id, title: accountTitle(me), chats: parsed }
  }

  async messages(chatId: string): Promise<Array<Message>> {
    const raw = chatId.startsWith(`${this.id}:`)
      ? chatId.slice(this.id.length + 1)
      : chatId
    const response = await this.send({
      '@type': 'getChatHistory',
      chat_id: chatIdArgument(raw),
      from_message_id: 0,
      limit: 40,
      offset: 0,
      only_local: false,
    })
    const messages = field(response, 'messages')
    if (!Array.isArray(messages)) {
      return []
    }
    return messages
      .flatMap(value => {
        const message = messageFrom(value)
        return message === undefined ? [] : [message]
      })
      .reverse()
  }

  async logout(): Promise<void> {
    await this.send({ '@type': 'logOut' }).catch(() => undefined)
    await this.waitFor(
      phase =>
        phase._tag === 'Closed' ||
        phase._tag === 'WaitPhone' ||
        phase._tag === 'Failed',
    ).catch(() => undefined)
    await this.sink.close()
  }

  async release(): Promise<void> {
    // Do not receive after close. The destructor traps on the next
    // td_receive ("memory access out of bounds", scheduler has_guard_).
    // The files stay put; drop() does not log out.
    await this.send({ '@type': 'close' }).catch(() => undefined)
    if (this.sink.drop !== undefined) {
      await this.sink.drop()
    }
  }

  async discard(): Promise<void> {
    const tag = this.phase._tag
    const inProgress =
      tag === 'WaitPhone' ||
      tag === 'WaitCode' ||
      tag === 'WaitPassword' ||
      tag === 'WaitQr'
    if (!inProgress) {
      // Opening, Failed, Closed, or an open that never left Opening. Do not
      // log out and do not sync: that would replace the saved IndexedDB copy.
      if (this.sink.drop !== undefined) {
        await this.sink.drop()
      }
      return
    }
    await Promise.race([
      this.send({ '@type': 'logOut' }).catch(() => undefined),
      new Promise<void>(resolve => {
        setTimeout(resolve, DISCARD_TIMEOUT)
      }),
    ])
    await this.sink.close()
  }
}

export const databaseDirectory = (id: string): string => `/tdlib/${id}`
