import QRCode from 'qrcode'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  TdAccount,
  type TdQuery,
  type TdSink,
  chatKind,
  publicError,
} from './tdlibProtocol'
import { desktopFailure, toAuthResult } from './telegram'

type Plan = {
  response?: unknown
  update?: unknown
}

const authorization = (name: string, extra?: Record<string, unknown>) => ({
  '@type': 'updateAuthorizationState',
  authorization_state: { '@type': name, ...extra },
})

const scripted = (
  plans: Array<Plan>,
): { account: TdAccount; sent: Array<TdQuery> } => {
  const sent: Array<TdQuery> = []
  let account: TdAccount | undefined
  const sink: TdSink = {
    send: query => {
      sent.push(query)
      const plan = plans.shift()
      queueMicrotask(() => {
        if (plan?.update !== undefined && account !== undefined) {
          account.apply(plan.update)
        }
      })
      return Promise.resolve(plan?.response ?? { '@type': 'ok' })
    },
    close: () => Promise.resolve(),
  }
  account = new TdAccount(sink, 'one')
  return { account, sent }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TDLib browser protocol', () => {
  test('keeps two accounts on independent clients', async () => {
    const first = scripted([
      { update: authorization('authorizationStateWaitCode') },
    ])
    const second = scripted([
      { update: authorization('authorizationStateWaitCode') },
    ])
    first.account.apply(authorization('authorizationStateWaitPhoneNumber'))
    second.account.apply(authorization('authorizationStateWaitPhoneNumber'))
    await first.account.beginPhone('+100')
    await second.account.beginPhone('+200')
    expect(first.sent[0]).toMatchObject({ phone_number: '+100' })
    expect(second.sent[0]).toMatchObject({ phone_number: '+200' })
  })

  test('phone code transitions to 2FA and then an account', async () => {
    const phone = scripted([
      { update: authorization('authorizationStateWaitCode') },
    ])
    phone.account.apply(authorization('authorizationStateWaitPhoneNumber'))
    await expect(phone.account.beginPhone('+100')).resolves.toEqual({
      _tag: 'Code',
      id: 'one',
    })
    const coded = scripted([
      { update: authorization('authorizationStateWaitPassword') },
    ])
    coded.account.apply(authorization('authorizationStateWaitCode'))
    await expect(coded.account.submitCode('11111')).resolves.toEqual({
      _tag: 'Password',
      id: 'one',
    })
    const unlocked = scripted([
      { update: authorization('authorizationStateReady') },
      {
        response: {
          '@type': 'user',
          first_name: 'Ada',
          last_name: 'Lovelace',
        },
      },
      { response: { '@type': 'chats', chat_ids: [] } },
    ])
    unlocked.account.apply(authorization('authorizationStateWaitPassword'))
    await expect(unlocked.account.submitPassword('secret')).resolves.toMatchObject({
      _tag: 'Authorized',
      account: { title: 'Ada Lovelace' },
    })
    expect(coded.sent[0]).toMatchObject({
      '@type': 'checkAuthenticationCode',
      code: '11111',
    })
    expect(unlocked.sent[0]).toMatchObject({
      '@type': 'checkAuthenticationPassword',
      password: 'secret',
    })
  })

  test('QR link is rendered and a later poll can demand a password', async () => {
    const renderQr = vi.spyOn(QRCode, 'toDataURL')
    const { account } = scripted([
      {
        update: authorization('authorizationStateWaitOtherDeviceConfirmation', {
          link: 'tg://login?token=abc',
        }),
      },
    ])
    account.apply(authorization('authorizationStateWaitPhoneNumber'))
    const step = await account.beginQr()
    await expect(toAuthResult(step)).resolves.toMatchObject({
      _tag: 'Qr',
      id: 'one',
      image: expect.stringContaining('data:image/png;base64,'),
    })
    expect(renderQr).toHaveBeenCalledWith('tg://login?token=abc')
    account.apply(authorization('authorizationStateWaitPassword'))
    await expect(account.poll()).resolves.toEqual({
      _tag: 'Password',
      id: 'one',
    })
  })

  test('invalid phone is reported and an invalid code stays retryable', async () => {
    const { account } = scripted([
      { response: { '@type': 'error', message: 'PHONE_NUMBER_INVALID' } },
    ])
    account.apply(authorization('authorizationStateWaitPhoneNumber'))
    await expect(account.beginPhone('bad')).rejects.toThrow(
      'PHONE_NUMBER_INVALID',
    )
    const retry = scripted([
      { response: { '@type': 'error', message: 'PHONE_CODE_INVALID' } },
      { update: authorization('authorizationStateReady') },
      { response: { '@type': 'user', first_name: 'Ada' } },
      { response: { '@type': 'chats', chat_ids: [] } },
    ])
    retry.account.apply(authorization('authorizationStateWaitCode'))
    await expect(retry.account.submitCode('bad')).rejects.toThrow(
      'PHONE_CODE_INVALID',
    )
    await expect(retry.account.submitCode('good')).resolves.toMatchObject({
      _tag: 'Authorized',
    })
  })

  test('maps private chats, groups, and channels and skips unknown peers', async () => {
    expect(chatKind('chatTypePrivate', false)).toBe('Dialog')
    expect(chatKind('chatTypeSecret', false)).toBe('Dialog')
    expect(chatKind('chatTypeBasicGroup', false)).toBe('Group')
    expect(chatKind('chatTypeSupergroup', false)).toBe('Group')
    expect(chatKind('chatTypeSupergroup', true)).toBe('Channel')
    expect(chatKind('chatTypeUnknown', false)).toBeUndefined()
    const { account } = scripted([
      { response: { '@type': 'user', first_name: 'Ada' } },
      { response: { '@type': 'ok' } },
      { response: { '@type': 'chats', chat_ids: [7, 8, 9] } },
      {
        response: {
          '@type': 'chat',
          title: 'Ada',
          type: { '@type': 'chatTypePrivate' },
        },
      },
      {
        response: {
          '@type': 'chat',
          title: 'Team',
          type: { '@type': 'chatTypeSupergroup', is_channel: false },
        },
      },
      {
        response: {
          '@type': 'chat',
          title: 'News',
          type: { '@type': 'chatTypeSupergroup', is_channel: true },
        },
      },
    ])
    await expect(account.readAccount()).resolves.toEqual({
      id: 'one',
      title: 'Ada',
      chats: [
        { id: 'one:7', title: 'Ada', kind: 'Dialog' },
        { id: 'one:8', title: 'Team', kind: 'Group' },
        { id: 'one:9', title: 'News', kind: 'Channel' },
      ],
    })
  })

  test('desktop commands use Tauri camelCase argument names', async () => {
    const calls: Array<{
      command: string
      args: Record<string, unknown> | undefined
    }> = []
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args })
        if (command === 'telegram_begin_login' || command === 'telegram_poll') {
          return Promise.resolve({ _tag: 'Code', id: 'acct' })
        }
        return Promise.resolve([])
      },
    })
    const { beginLogin, loadMessages, pollAccount, restoreAccounts } =
      await import('./telegram')
    await beginLogin('acct', 123, 'hash', '+100', false)
    await restoreAccounts(123, 'hash')
    await loadMessages('acct', '7')
    await pollAccount('acct')
    Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
    expect(calls).toEqual([
      {
        command: 'telegram_begin_login',
        args: {
          id: 'acct',
          phone: '+100',
          qr: false,
          apiId: '123',
          apiHash: 'hash',
        },
      },
      {
        command: 'telegram_restore',
        args: { apiId: '123', apiHash: 'hash' },
      },
      {
        command: 'telegram_messages',
        args: { id: 'acct', chatId: '7' },
      },
      {
        command: 'telegram_poll',
        args: { id: 'acct' },
      },
    ])
  })

  test('desktop Authorized matches the Rust account shape and has no top-level id', async () => {
    const rustStep = {
      _tag: 'Authorized',
      account: {
        id: 'acct',
        title: 'Ada',
        chats: [{ id: 'acct:7', title: 'Ada', kind: 'Dialog' as const }],
      },
    }
    Reflect.set(globalThis, '__TAURI_INTERNALS__', {
      invoke: () => Promise.resolve(rustStep),
    })
    try {
      const { pollAccount } = await import('./telegram')
      await expect(pollAccount('acct')).resolves.toEqual({
        _tag: 'Authorized',
        account: rustStep.account,
      })
    } finally {
      Reflect.deleteProperty(globalThis, '__TAURI_INTERNALS__')
    }
  })

  test('shows the desktop error string instead of a generic failure', () => {
    expect(desktopFailure('TDLib: database is locked')).toBe(
      'TDLib: database is locked',
    )
    expect(desktopFailure(new Error('PHONE_CODE_INVALID'))).toBe(
      'The code is incorrect. Try again.',
    )
    expect(desktopFailure({})).toBe(
      'Telegram could not complete the request. Retry or cancel and start again.',
    )
  })

  test('reads message text and drops free-text errors', async () => {
    expect(
      publicError({ '@type': 'error', message: 'PHONE_CODE_INVALID' }),
    ).toBe('PHONE_CODE_INVALID')
    expect(publicError({ '@type': 'error', message: 'phone +1 secret' })).toBe(
      'REQUEST_FAILED',
    )
    const { account } = scripted([
      {
        response: {
          '@type': 'messages',
          messages: [
            {
              '@type': 'message',
              id: 2,
              is_outgoing: false,
              date: 20,
              content: { '@type': 'messageText', text: { text: 'later' } },
            },
            {
              '@type': 'message',
              id: 1,
              is_outgoing: true,
              date: 10,
              content: { '@type': 'messageText', text: { text: 'earlier' } },
            },
          ],
        },
      },
    ])
    await expect(account.messages('one:7')).resolves.toEqual([
      { id: '1', text: 'earlier', outgoing: true, date: 10 },
      { id: '2', text: 'later', outgoing: false, date: 20 },
    ])
  })
})
