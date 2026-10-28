import * as Schema from 'effect/Schema'
import { defineTaggedUnion } from 'foldkit/schema'
import QRCode from 'qrcode'
import { Api, TelegramClient } from 'telegram'
import { computeCheck } from 'telegram/Password'
import { LogLevel } from 'telegram/extensions/Logger'
import { PromisedWebSockets } from 'telegram/extensions/PromisedWebSockets'
import { ConnectionTCPObfuscated } from 'telegram/network/connection'
import { StringSession } from 'telegram/sessions'

import type { Chat } from './generated/core'

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

type Connection = {
  client: TelegramClient
  phone: string
  phoneCodeHash: string
}
const connections = new Map<string, Connection>()

export const connectionOptions = {
  useWSS: true,
  networkSocket: PromisedWebSockets,
  connection: ConnectionTCPObfuscated,
  connectionRetries: 3,
  requestRetries: 2,
  autoReconnect: true,
  deviceModel: 'CRM Chat Web',
}

export const classifyPeer = (entity: unknown): Chat['kind'] | undefined => {
  if (entity instanceof Api.User) {
    return 'Dialog'
  }
  if (entity instanceof Api.Chat || entity instanceof Api.ChatForbidden) {
    return 'Group'
  }
  if (entity instanceof Api.Channel || entity instanceof Api.ChannelForbidden) {
    return entity.broadcast ? 'Channel' : entity.megagroup ? 'Group' : undefined
  }
  return undefined
}

const connectionFor = (id: string): Connection => {
  const connection = connections.get(id)
  if (!connection) {
    throw new Error('Login expired. Add the account again.')
  }
  return connection
}

export const loadAccount = async (id: string): Promise<Account> => {
  const { client } = connectionFor(id)
  const user = await client.getMe()
  const dialogs = await client.getDialogs({ ignoreMigrated: true })
  const chats = dialogs.flatMap((dialog): Array<Chat> => {
    const kind = classifyPeer(dialog.entity)
    if (!kind || !dialog.id) {
      return []
    }
    return [
      {
        id: `${user.id}:${dialog.id}`,
        title: dialog.title || 'Unnamed chat',
        kind,
      },
    ]
  })
  return {
    id,
    title:
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      'Telegram account',
    chats,
  }
}

const authorized = async (id: string): Promise<AuthResult> => {
  const user = await connectionFor(id).client.getMe()
  return AuthResult.Authorized({
    account: {
      id,
      title:
        [user.firstName, user.lastName].filter(Boolean).join(' ') ||
        'Telegram account',
      chats: [],
    },
  })
}

export const beginLogin = async (
  id: string,
  apiId: number,
  apiHash: string,
  phone: string,
  qr: boolean,
): Promise<AuthResult> => {
  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    connectionOptions,
  )
  client.setLogLevel(LogLevel.NONE)
  connections.set(id, { client, phone, phoneCodeHash: '' })
  try {
    await client.connect()
    if (qr) {
      return await pollQr(id)
    }
    const sent = await client.sendCode({ apiId, apiHash }, phone)
    connectionFor(id).phoneCodeHash = sent.phoneCodeHash
    return { _tag: 'Code', id }
  } catch (error) {
    await removeConnection(id)
    throw error
  }
}

const passwordOrThrow = (id: string, error: unknown): AuthResult => {
  if (
    error instanceof Error &&
    error.message.includes('SESSION_PASSWORD_NEEDED')
  ) {
    return { _tag: 'Password', id }
  }
  throw error
}

export const submitCode = async (
  id: string,
  code: string,
): Promise<AuthResult> => {
  const { client, phone, phoneCodeHash } = connectionFor(id)
  try {
    const result = await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      }),
    )
    if (result instanceof Api.auth.AuthorizationSignUpRequired) {
      throw new Error('Create your Telegram account in an official app first.')
    }
    return await authorized(id)
  } catch (error) {
    return passwordOrThrow(id, error)
  }
}

export const submitPassword = async (
  id: string,
  password: string,
): Promise<AuthResult> => {
  const { client } = connectionFor(id)
  const parameters = await client.invoke(new Api.account.GetPassword())
  await client.invoke(
    new Api.auth.CheckPassword({
      password: await computeCheck(parameters, password),
    }),
  )
  return authorized(id)
}

export const pollQr = async (id: string): Promise<AuthResult> => {
  const { client } = connectionFor(id)
  try {
    const result = await client.invoke(
      new Api.auth.ExportLoginToken({
        apiId: client.apiId,
        apiHash: client.apiHash,
        exceptIds: [],
      }),
    )
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await client._switchDC(result.dcId)
      const imported = await client.invoke(
        new Api.auth.ImportLoginToken({ token: result.token }),
      )
      if (!(imported instanceof Api.auth.LoginTokenSuccess)) {
        throw new Error('QR login could not complete. Try again.')
      }
      return await authorized(id)
    }
    if (result instanceof Api.auth.LoginTokenSuccess) {
      return await authorized(id)
    }
    const image = await QRCode.toDataURL(
      `tg://login?token=${result.token.toString('base64url')}`,
    )
    return { _tag: 'Qr', id, image }
  } catch (error) {
    return passwordOrThrow(id, error)
  }
}

export const removeConnection = async (id: string): Promise<void> => {
  const connection = connections.get(id)
  connections.delete(id)
  if (connection) {
    await connection.client.destroy()
  }
}
