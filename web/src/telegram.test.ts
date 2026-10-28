import bigInt from 'big-integer'
import { Api, TelegramClient } from 'telegram'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  beginLogin,
  classifyPeer,
  connectionOptions,
  loadAccount,
  pollQr,
  removeConnection,
  submitCode,
  submitPassword,
} from './telegram'

vi.mock('telegram/Password', () => ({
  computeCheck: vi.fn(async () => new Api.InputCheckPasswordEmpty()),
}))

const user = new Api.User({ id: bigInt(1), firstName: 'Ada' })
const codeSent = { phoneCodeHash: 'hash', isCodeViaApp: true }
const me = vi.spyOn(TelegramClient.prototype, 'getMe').mockResolvedValue(user)
const connect = vi
  .spyOn(TelegramClient.prototype, 'connect')
  .mockResolvedValue(true)
const destroy = vi
  .spyOn(TelegramClient.prototype, 'destroy')
  .mockResolvedValue()
const sendCode = vi
  .spyOn(TelegramClient.prototype, 'sendCode')
  .mockResolvedValue(codeSent)
const invoke = vi.spyOn(TelegramClient.prototype, 'invoke')
const getDialogs = vi.spyOn(TelegramClient.prototype, 'getDialogs')
const switchDc = vi
  .spyOn(TelegramClient.prototype, '_switchDC')
  .mockResolvedValue(true)

afterEach(async () => {
  await Promise.all(['one', 'two', 'qr', 'failed'].map(removeConnection))
  vi.clearAllMocks()
})

describe('browser adapter', () => {
  test('forces secure WebSockets and retains independent account connections', async () => {
    expect(connectionOptions.useWSS).toBe(true)
    expect(connectionOptions.networkSocket.name).toBe('PromisedWebSockets')
    await beginLogin('one', 123, 'hash', '+310001', false)
    await beginLogin('two', 123, 'hash', '+310002', false)
    expect(connect.mock.instances[0]).not.toBe(connect.mock.instances[1])
    invoke.mockResolvedValue(new Api.auth.Authorization({ user }))
    await submitCode('one', '11111')
    await submitCode('two', '22222')
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      phoneNumber: '+310001',
      phoneCode: '11111',
    })
    expect(invoke.mock.calls[1]?.[0]).toMatchObject({
      phoneNumber: '+310002',
      phoneCode: '22222',
    })
    expect(me).toHaveBeenCalledTimes(2)
  })

  test('phone code transitions to 2FA and uses Telegram SRP check', async () => {
    await beginLogin('one', 123, 'hash', '+310001', false)
    invoke.mockRejectedValueOnce(new Error('SESSION_PASSWORD_NEEDED'))
    await expect(submitCode('one', '11111')).resolves.toEqual({
      _tag: 'Password',
      id: 'one',
    })
    invoke.mockResolvedValueOnce(
      new Api.account.Password({
        newAlgo: new Api.PasswordKdfAlgoUnknown(),
        newSecureAlgo: new Api.SecurePasswordKdfAlgoUnknown(),
        secureRandom: Buffer.alloc(32),
      }),
    )
    invoke.mockResolvedValueOnce(new Api.auth.Authorization({ user }))
    await expect(submitPassword('one', 'password')).resolves.toMatchObject({
      _tag: 'Authorized',
    })
    expect(invoke.mock.calls.at(-1)?.[0]).toBeInstanceOf(Api.auth.CheckPassword)
  })

  test('QR refresh, migration, and password challenge', async () => {
    invoke.mockResolvedValueOnce(
      new Api.auth.LoginToken({ token: Buffer.from('token'), expires: 123 }),
    )
    await expect(
      beginLogin('qr', 123, 'hash', '', true),
    ).resolves.toMatchObject({
      _tag: 'Qr',
      image: expect.stringContaining('data:image/png;base64,'),
    })
    invoke.mockResolvedValueOnce(
      new Api.auth.LoginTokenMigrateTo({
        dcId: 4,
        token: Buffer.from('migrated'),
      }),
    )
    invoke.mockRejectedValueOnce(new Error('SESSION_PASSWORD_NEEDED'))
    await expect(pollQr('qr')).resolves.toEqual({ _tag: 'Password', id: 'qr' })
    expect(switchDc).toHaveBeenCalledWith(4)
    invoke.mockResolvedValueOnce(
      new Api.auth.LoginTokenSuccess({
        authorization: new Api.auth.Authorization({ user }),
      }),
    )
    await expect(pollQr('qr')).resolves.toMatchObject({ _tag: 'Authorized' })
  })

  test('failed connection is destroyed and invalid codes remain retryable', async () => {
    sendCode.mockRejectedValueOnce(new Error('PHONE_NUMBER_INVALID'))
    await expect(
      beginLogin('failed', 123, 'hash', 'bad', false),
    ).rejects.toThrow('PHONE_NUMBER_INVALID')
    expect(destroy).toHaveBeenCalledOnce()
    await beginLogin('one', 123, 'hash', '+310001', false)
    invoke.mockRejectedValueOnce(new Error('PHONE_CODE_INVALID'))
    await expect(submitCode('one', 'bad')).rejects.toThrow('PHONE_CODE_INVALID')
    invoke.mockResolvedValueOnce(new Api.auth.Authorization({ user }))
    await expect(submitCode('one', 'good')).resolves.toMatchObject({
      _tag: 'Authorized',
    })
  })

  test('loads all dialogs with no artificial limit and namespaces peer IDs', async () => {
    await beginLogin('one', 123, 'hash', '+310001', false)
    getDialogs.mockResolvedValueOnce(Object.assign([], { total: 0 }))
    await expect(loadAccount('one')).resolves.toMatchObject({ chats: [] })
    expect(getDialogs).toHaveBeenCalledWith({ ignoreMigrated: true })
  })
})

test('users, basic groups, supergroups and broadcasts have distinct core kinds', () => {
  expect(classifyPeer(user)).toBe('Dialog')
  expect(
    classifyPeer(new Api.ChatForbidden({ id: bigInt(2), title: 'Group' })),
  ).toBe('Group')
  expect(
    classifyPeer(
      new Api.ChannelForbidden({
        id: bigInt(3),
        accessHash: bigInt(4),
        title: 'Supergroup',
        megagroup: true,
      }),
    ),
  ).toBe('Group')
  expect(
    classifyPeer(
      new Api.ChannelForbidden({
        id: bigInt(5),
        accessHash: bigInt(6),
        title: 'News',
        broadcast: true,
      }),
    ),
  ).toBe('Channel')
  expect(classifyPeer(new Api.ChatEmpty({ id: bigInt(7) }))).toBeUndefined()
})
