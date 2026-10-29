import * as Schema from 'effect/Schema'
import { defineTaggedUnion } from 'foldkit/schema'
import QRCode from 'qrcode'

import type { Chat } from './generated/core'
import { type AuthStep, TdAccount } from './tdlibProtocol'
import { browserRuntime } from './tdlibWasm'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const tauriInvoke = ():
  | ((command: string, args?: Record<string, unknown>) => Promise<unknown>)
  | undefined => {
  const internals: unknown = Reflect.get(globalThis, '__TAURI_INTERNALS__')
  if (!isRecord(internals)) {
    return undefined
  }
  const invoke: unknown = Reflect.get(internals, 'invoke')
  if (typeof invoke !== 'function') {
    return undefined
  }
  return (command, args) => Promise.resolve(invoke(command, args))
}

const stringField = (value: Record<string, unknown>, key: string): string => {
  const field = value[key]
  if (typeof field !== 'string') {
    throw new Error('Telegram could not complete the request.')
  }
  return field
}

const decodeAccount = (value: unknown): Account => {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['title'] !== 'string' ||
    !Array.isArray(value['chats'])
  ) {
    throw new Error('Telegram could not complete the request.')
  }
  const chats = value['chats'].flatMap((chat): Array<Chat> => {
    if (
      !isRecord(chat) ||
      typeof chat['id'] !== 'string' ||
      typeof chat['title'] !== 'string'
    ) {
      return []
    }
    const kind = chat['kind']
    if (kind !== 'Dialog' && kind !== 'Group' && kind !== 'Channel') {
      return []
    }
    return [{ id: chat['id'], title: chat['title'], kind }]
  })
  return { id: value['id'], title: value['title'], chats }
}

const nativeAuth = async (value: unknown): Promise<AuthResult> => {
  if (!isRecord(value) || typeof value['_tag'] !== 'string') {
    throw new Error('Telegram could not complete the request.')
  }
  if (value['_tag'] === 'Code') {
    return { _tag: 'Code', id: stringField(value, 'id') }
  }
  if (value['_tag'] === 'Password') {
    return { _tag: 'Password', id: stringField(value, 'id') }
  }
  if (value['_tag'] === 'Qr') {
    return {
      _tag: 'Qr',
      id: stringField(value, 'id'),
      image: await QRCode.toDataURL(stringField(value, 'link')),
    }
  }
  if (value['_tag'] === 'Authorized') {
    return { _tag: 'Authorized', account: decodeAccount(value['account']) }
  }
  throw new Error('Telegram could not complete the request.')
}

export const desktopFailure = (error: unknown): string => {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : isRecord(error) && typeof error['message'] === 'string'
          ? error['message']
          : ''
  if (message.includes('PHONE_CODE_INVALID')) {
    return 'The code is incorrect. Try again.'
  }
  if (message.includes('PHONE_CODE_EXPIRED')) {
    return 'The code expired. Cancel and start again.'
  }
  if (message.includes('PASSWORD_HASH_INVALID')) {
    return 'The password is incorrect. Try again.'
  }
  if (message.includes('FLOOD_WAIT')) {
    return 'Telegram requires a wait before trying again.'
  }
  if (message.includes('API_ID_INVALID')) {
    return 'Check your Telegram API ID and hash.'
  }
  if (message.includes('PHONE_NUMBER_INVALID')) {
    return 'Enter your phone number with its country code.'
  }
  if (message !== '') {
    return message
  }
  return 'Telegram could not complete the request. Retry or cancel and start again.'
}

export const toAuthResult = async (step: AuthStep): Promise<AuthResult> => {
  if (step._tag === 'Code') {
    return { _tag: 'Code', id: step.id }
  }
  if (step._tag === 'Password') {
    return { _tag: 'Password', id: step.id }
  }
  if (step._tag === 'Qr') {
    return {
      _tag: 'Qr',
      id: step.id,
      image: await QRCode.toDataURL(step.link),
    }
  }
  return { _tag: 'Authorized', account: step.account }
}

export const loadMessages = async (
  id: string,
  chatId: string,
): Promise<
  Array<{ id: string; text: string; outgoing: boolean; date: number }>
> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    const value = await invoke('telegram_messages', { id, chatId })
    return Array.isArray(value) ? value : []
  }
  return sessionFor(id).messages(chatId)
}

export const restoreAccounts = async (
  apiId: number,
  apiHash: string,
): Promise<Array<Account>> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    const value = await invoke('telegram_restore', {
      apiId: String(apiId),
      apiHash,
    })
    return Array.isArray(value) ? value.map(decodeAccount) : []
  }
  const accounts = await browserRuntime.restore(apiId, apiHash)
  const loaded = []
  for (const account of accounts) {
    sessions.set(account.id, account)
    loaded.push(await account.readAccount())
  }
  return loaded
}

export const ChatSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(['Dialog', 'Group', 'Channel']),
})
export const Account = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  chats: Schema.Array(ChatSchema),
})
export type Account = typeof Account.Type

export const AuthResult = defineTaggedUnion({
  Code: { id: Schema.String },
  Password: { id: Schema.String },
  Qr: { id: Schema.String, image: Schema.String },
  Authorized: { account: Account },
})
export type AuthResult = typeof AuthResult.Type

const sessions = new Map<string, TdAccount>()

const sessionFor = (id: string): TdAccount => {
  const session = sessions.get(id)
  if (!session) {
    throw new Error('Login expired. Add the account again.')
  }
  return session
}

export const loadAccount = async (id: string): Promise<Account> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    return decodeAccount(await invoke('telegram_load_account', { id }))
  }
  const session = sessionFor(id)
  const account = await session.readAccount()
  if (session.chatListError !== undefined) {
    throw new Error(session.chatListError)
  }
  return account
}

export const beginLogin = async (
  id: string,
  apiId: number,
  apiHash: string,
  phone: string,
  qr: boolean,
): Promise<AuthResult> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    return nativeAuth(
      await invoke('telegram_begin_login', {
        id,
        phone,
        qr,
        apiId: String(apiId),
        apiHash,
      }),
    )
  }
  const account = await browserRuntime.open(id, apiId, apiHash)
  sessions.set(id, account)
  try {
    const step = qr ? await account.beginQr() : await account.beginPhone(phone)
    return await toAuthResult(step)
  } catch (error) {
    if (account.phase._tag !== 'Ready') {
      sessions.delete(id)
      await account.logout()
    }
    throw error
  }
}

export const submitCode = async (
  id: string,
  code: string,
): Promise<AuthResult> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    return nativeAuth(await invoke('telegram_submit_code', { id, code }))
  }
  return toAuthResult(await sessionFor(id).submitCode(code))
}

export const submitPassword = async (
  id: string,
  password: string,
): Promise<AuthResult> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    return nativeAuth(
      await invoke('telegram_submit_password', { id, password }),
    )
  }
  return toAuthResult(await sessionFor(id).submitPassword(password))
}

export const pollAccount = async (id: string): Promise<AuthResult> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    return nativeAuth(await invoke('telegram_poll', { id }))
  }
  return toAuthResult(await sessionFor(id).poll())
}

export const pollQr = pollAccount

export const removeConnection = async (id: string): Promise<void> => {
  const invoke = tauriInvoke()
  if (invoke !== undefined) {
    await invoke('telegram_logout', { id })
    return
  }
  const session = sessions.get(id)
  sessions.delete(id)
  if (session) {
    await session.logout()
  }
}
