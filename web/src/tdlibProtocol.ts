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

export type AuthStep =
  | { _tag: 'Code'; id: string }
  | { _tag: 'Password'; id: string }
  | { _tag: 'Qr'; id: string; link: string }
  | { _tag: 'Authorized'; account: Account }

export type Phase =
  | { _tag: 'Opening' }
  | { _tag: 'WaitPhone' }
  | { _tag: 'WaitCode' }
  | { _tag: 'WaitPassword' }
  | { _tag: 'WaitQr'; link: string }
  | { _tag: 'Ready' }
  | { _tag: 'Closed' }
  | { _tag: 'Failed'; error: string }

export type TdQuery = Record<string, unknown>

export type TdSink = {
  send: (query: TdQuery) => Promise<unknown>
  close: () => Promise<void>
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
    return { _tag: 'WaitPassword' }
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

const messageFrom = (value: unknown): Message | undefined => {
  const id = idValue(field(value, 'id'))
  if (id === undefined) {
    return undefined
  }
  const content = field(value, 'content')
  const name = typeName(content)
  const body =
    name === 'messageText'
      ? text(field(field(content, 'text'), 'text'))
      : name.startsWith('message')
        ? name.slice('message'.length)
        : ''
  const date = field(value, 'date')
  return {
    id,
    text: body,
    outgoing: field(value, 'is_outgoing') === true,
    date: typeof date === 'number' ? date : 0,
  }
}

const STEP_TIMEOUT = 60_000
const DISCARD_TIMEOUT = 2_000

export class TdAccount {
  phase: Phase = { _tag: 'Opening' }
  chatListError: string | undefined = undefined
  private readonly waiters: Array<() => void> = []

  constructor(
    private readonly sink: TdSink,
    readonly id: string,
  ) {}

  private generation = 0

  apply(value: unknown): void {
    if (typeName(value) !== 'updateAuthorizationState') {
      return
    }
    this.phase = phaseFromAuthorization(field(value, 'authorization_state'))
    this.generation += 1
    for (const waiter of this.waiters.splice(0)) {
      waiter()
    }
  }

  private async send(query: TdQuery): Promise<unknown> {
    const response = await this.sink.send(query)
    const error = publicError(response)
    if (error !== undefined) {
      throw new Error(error)
    }
    return response
  }

  private waitFor(
    predicate: (phase: Phase) => boolean,
    timeout = STEP_TIMEOUT,
  ): Promise<Phase> {
    if (predicate(this.phase)) {
      return Promise.resolve(this.phase)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Telegram did not answer in time'))
      }, timeout)
      const check = () => {
        if (!predicate(this.phase)) {
          return
        }
        clearTimeout(timer)
        resolve(this.phase)
      }
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
      return { _tag: 'Password', id: this.id }
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

  async readAccount(): Promise<Account> {
    this.chatListError = undefined
    const me = await this.send({ '@type': 'getMe' })
    await this.send({
      '@type': 'loadChats',
      chat_list: { '@type': 'chatListMain' },
      limit: 100,
    }).catch(() => undefined)
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
      return { id: this.id, title: accountTitle(me), chats: [] }
    }
    const ids = field(chats, 'chat_ids')
    const parsed: Array<Chat> = []
    if (Array.isArray(ids)) {
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
        parsed.push({
          id: `${this.id}:${raw}`,
          title: title === '' ? 'Unnamed chat' : title,
          kind,
        })
      }
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

  async discard(): Promise<void> {
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
