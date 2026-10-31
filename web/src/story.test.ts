import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import {
  BeginLogin,
  CloseChat,
  Disconnect,
  LoadHistory,
  LoadSponsored,
  Message,
  type Model,
  OpenChat,
  Refresh,
  Restore,
  initialModel,
  update,
} from './main'
import { AuthResult } from './telegram'

const first = {
  id: 'first',
  title: 'First',
  chats: [{ id: 'first:1', title: 'Private', kind: 'Dialog' }],
} satisfies typeof import('./telegram').Account.Type
const second = {
  id: 'second',
  title: 'Second',
  chats: [{ id: 'second:1', title: 'Broadcast', kind: 'Channel' }],
} satisfies typeof import('./telegram').Account.Type
const signedIn: Model = modifyFields(initialModel, {
  login: () => ({ _tag: 'Closed' }),
  accounts: () => [first],
  selectedAccountId: () => first.id,
  apiId: () => '12345',
  apiHash: () => Redacted.make('0123456789abcdef0123456789abcdef'),
})

test('attaching another account preserves the first account and switching selects it', () => {
  story(
    update,
    given(signedIn),
    message(Message.ClickedAddAccount()),
    message(Message.ClickedQrLogin()),
    Command.resolve(
      BeginLogin,
      Message.SucceededAuthenticate({
        result: AuthResult.Authorized({ account: second }),
        sourceId: '',
      }),
    ),
    Command.resolve(Refresh, Message.SucceededRefresh({ account: second })),
    model(current => {
      expect(current.accounts).toEqual([first, second])
      expect(current.selectedAccountId).toBe('second')
    }),
    message(Message.SelectedAccount({ id: 'first' })),
    model(current => {
      expect(current.selectedAccountId).toBe('first')
      expect(current.accounts[0]?.chats[0]?.kind).toBe('Dialog')
    }),
  )
})

test('cancelled QR authentication cannot reattach itself or overwrite a new login', () => {
  const scanning = modifyFields(signedIn, {
    login: () => ({ _tag: 'Qr', id: 'cancelled', image: 'image' }),
  })
  story(
    update,
    given(scanning),
    message(Message.ClickedCancel()),
    Command.resolve(Disconnect, Message.CompletedDisconnect()),
    message(Message.ClickedAddAccount()),
    message(
      Message.SucceededAuthenticate({
        sourceId: 'cancelled',
        result: AuthResult.Authorized({ account: second }),
      }),
    ),
    message(
      Message.FailedAuthenticate({ sourceId: 'cancelled', error: 'old error' }),
    ),
    model(current => {
      expect(current.login._tag).toBe('Editing')
      expect(current.accounts).toEqual([first])
      expect(current.error).toBe('')
    }),
  )
})

test('a chat-list failure keeps the authenticated account available for retry', () => {
  story(
    update,
    given(signedIn),
    message(Message.ClickedRefresh()),
    Command.resolve(Refresh, Message.FailedRefresh()),
    model(current => {
      expect(current.accounts).toEqual([first])
      expect(current.status).toBe('Ready')
      expect(current.error).toContain('Could not load chats')
    }),
    message(Message.ClickedRefresh()),
    Command.resolve(Refresh, Message.SucceededRefresh({ account: first })),
    model(current => {
      expect(current.error).toBe('')
      expect(current.accounts).toEqual([first])
    }),
  )
})

test('opening a group loads history and a failed sponsored response stays quiet', () => {
  const grouped = {
    id: 'first',
    title: 'First',
    chats: [
      { id: 'first:1', title: 'Private', kind: 'Dialog' as const },
      { id: 'first:2', title: 'Book club', kind: 'Group' as const },
      { id: 'first:3', title: 'News', kind: 'Channel' as const },
    ],
  }
  story(
    update,
    given(
      modifyFields(signedIn, {
        accounts: () => [grouped],
      }),
    ),
    message(Message.ClickedChat({ id: 'first:2' })),
    Command.resolve(OpenChat, Message.CompletedOpenChat()),
    Command.resolve(
      LoadHistory,
      Message.LoadedHistory({
        id: 'first:2',
        lines: [{ text: 'I can host.', mine: false, time: '12:05' }],
      }),
    ),
    model(current => {
      expect(current.faces.find(item => item.id === 'first:2')?.historyLoaded).toBe(
        true,
      )
    }),
    message(Message.ClickedBack()),
    Command.resolve(CloseChat, Message.CompletedCloseChat()),
    message(Message.ClickedChat({ id: 'first:3' })),
    Command.resolve(OpenChat, Message.CompletedOpenChat()),
    Command.resolve(
      LoadHistory,
      Message.LoadedHistory({ id: 'first:3', lines: [] }),
    ),
    Command.resolve(
      LoadSponsored,
      Message.FailedSponsored({ id: 'first:3' }),
    ),
    model(current => {
      const channel = current.faces.find(item => item.id === 'first:3')
      expect(channel?.historyLoaded).toBe(true)
      expect(channel?.sponsoredLoaded).toBeUndefined()
      expect(current.error).toBe('')
    }),
  )
})

test('opening another chat closes the one Telegram had open', () => {
  const two = {
    id: 'first',
    title: 'First',
    chats: [
      { id: 'first:1', title: 'Private', kind: 'Dialog' as const },
      { id: 'first:2', title: 'Book club', kind: 'Group' as const },
    ],
  }
  story(
    update,
    given(
      modifyFields(signedIn, {
        accounts: () => [two],
        maybeOpenChatId: () => Option.some('first:1'),
        faces: () => [
          {
            id: 'first:1',
            time: '09:00',
            preview: 'hello',
            unread: 0,
            receipt: 'none' as const,
            historyLoaded: true,
            lines: [{ id: '1', text: 'hello', mine: false, time: '09:00' }],
          },
        ],
      }),
    ),
    message(Message.ClickedChat({ id: 'first:2' })),
    Command.resolve(CloseChat, Message.CompletedCloseChat()),
    Command.resolve(OpenChat, Message.CompletedOpenChat()),
    Command.resolve(
      LoadHistory,
      Message.LoadedHistory({
        id: 'first:2',
        lines: [{ id: '2', text: 'I can host.', mine: false, time: '12:05' }],
      }),
    ),
    model(current => {
      expect(Option.isSome(current.maybeOpenChatId)).toBe(true)
      expect(current.faces.find(item => item.id === 'first:2')?.lines[0]?.text).toBe(
        'I can host.',
      )
    }),
  )
})

test('a message that arrives before history is kept when history loads', () => {
  story(
    update,
    given(
      modifyFields(signedIn, {
        maybeOpenChatId: () => Option.some('first:1'),
        faces: () => [
          {
            id: 'first:1',
            time: '',
            preview: '',
            unread: 0,
            receipt: 'none' as const,
            lines: [],
          },
        ],
      }),
    ),
    message(
      Message.ArrivedMessages({
        accountId: 'first',
        items: [
          {
            chatId: 'first:1',
            id: '8',
            text: 'before history',
            outgoing: false,
            date: 1_700_000_000,
          },
        ],
      }),
    ),
    model(current => {
      expect(current.faces[0]?.lines).toEqual([])
      expect(current.faces[0]?.pending?.[0]?.text).toBe('before history')
    }),
    message(
      Message.LoadedHistory({
        id: 'first:1',
        lines: [{ id: '1', text: 'older', mine: false, time: '09:00' }],
      }),
    ),
    model(current => {
      expect(current.faces[0]?.lines.map(item => item.text)).toEqual([
        'older',
        'before history',
      ])
      expect(current.faces[0]?.pending).toBeUndefined()
    }),
    message(
      Message.ArrivedMessages({
        accountId: 'other',
        items: [
          {
            chatId: 'first:1',
            id: '9',
            text: 'ignored',
            outgoing: false,
            date: 1_700_000_100,
          },
        ],
      }),
    ),
    message(
      Message.ArrivedMessages({
        accountId: 'first',
        items: [
          {
            chatId: 'first:1',
            id: '8',
            text: 'before history',
            outgoing: false,
            date: 1_700_000_000,
          },
          {
            chatId: 'first:1',
            id: '10',
            text: 'after history',
            outgoing: true,
            date: 1_700_000_200,
          },
        ],
      }),
    ),
    model(current => {
      expect(current.faces[0]?.lines.map(item => item.text)).toEqual([
        'older',
        'before history',
        'after history',
      ])
    }),
  )
})

test('switching accounts closes the chat that was loaded from Telegram', () => {
  story(
    update,
    given(
      modifyFields(signedIn, {
        accounts: () => [first, second],
        maybeOpenChatId: () => Option.some('first:1'),
        faces: () => [
          {
            id: 'first:1',
            time: '09:00',
            preview: 'hello',
            unread: 0,
            receipt: 'none' as const,
            historyLoaded: true,
            lines: [{ text: 'hello', mine: false, time: '09:00' }],
          },
        ],
      }),
    ),
    message(Message.SelectedAccount({ id: 'second' })),
    Command.resolve(CloseChat, Message.CompletedCloseChat()),
    model(current => {
      expect(current.selectedAccountId).toBe('second')
      expect(Option.isNone(current.maybeOpenChatId)).toBe(true)
    }),
  )
})

test('a failed login can be retried without losing application credentials', () => {
  story(
    update,
    given(modifyFields(signedIn, { login: () => ({ _tag: 'Editing' }) })),
    message(Message.ClickedPhoneLogin()),
    Command.resolve(
      BeginLogin,
      Message.FailedAuthenticate({ sourceId: '', error: 'Try again' }),
    ),
    model(current => {
      expect(current.status).toBe('Ready')
      expect(current.error).toBe('Try again')
      expect(current.apiId).toBe('12345')
    }),
    message(Message.ClickedPhoneLogin()),
    Command.resolve(
      BeginLogin,
      Message.SucceededAuthenticate({
        sourceId: '',
        result: AuthResult.Code({ id: 'retry' }),
      }),
    ),
    model(current => {
      expect(current.login).toEqual({ _tag: 'Code', id: 'retry' })
      expect(current.error).toBe('')
    }),
  )
})

test('a QR poll that reaches Ready opens the chat list', () => {
  story(
    update,
    given(
      modifyFields(signedIn, {
        login: () => ({ _tag: 'Qr', id: 'qr', image: 'old' }),
        accounts: () => [],
        selectedAccountId: () => '',
      }),
    ),
    message(
      Message.SucceededAuthenticate({
        sourceId: 'qr',
        result: AuthResult.Qr({ id: 'qr', image: 'refreshed' }),
      }),
    ),
    model(current => {
      expect(current.login).toEqual({
        _tag: 'Qr',
        id: 'qr',
        image: 'refreshed',
      })
    }),
    message(
      Message.SucceededAuthenticate({
        sourceId: 'qr',
        result: AuthResult.Authorized({ account: first }),
      }),
    ),
    Command.resolve(Refresh, Message.SucceededRefresh({ account: first })),
    model(current => {
      expect(current.login._tag).toBe('Closed')
      expect(current.accounts).toEqual([first])
      expect(current.selectedAccountId).toBe('first')
    }),
  )
})

test('a successful QR poll clears a transient authentication error', () => {
  story(
    update,
    given(
      modifyFields(signedIn, {
        login: () => ({ _tag: 'Qr', id: 'qr', image: 'old' }),
      }),
    ),
    message(
      Message.FailedAuthenticate({
        sourceId: 'qr',
        error: 'Temporary failure',
      }),
    ),
    message(
      Message.SucceededAuthenticate({
        sourceId: 'qr',
        result: AuthResult.Qr({ id: 'qr', image: 'new' }),
      }),
    ),
    model(current => {
      expect(current.error).toBe('')
      expect(current.login).toEqual({ _tag: 'Qr', id: 'qr', image: 'new' })
    }),
  )
})

test('startup restores a saved account after credentials load', () => {
  story(
    update,
    given(initialModel),
    message(
      Message.CompletedLoadAppCredentials({
        credentials: {
          _tag: 'Present',
          apiId: '12345',
          apiHash: Redacted.make('0123456789abcdef0123456789abcdef'),
        },
      }),
    ),
    model(current => {
      expect(current.appCredentials).toBe('Supplied')
      expect(current.status).toBe('Busy')
    }),
    Command.resolve(
      Restore,
      Message.CompletedRestore({
        accounts: [first],
        faces: [
          {
            id: 'first:1',
            time: '18:35',
            preview: 'joined Telegram',
            unread: 0,
            receipt: 'none',
            lines: [],
          },
        ],
      }),
    ),
    model(current => {
      expect(current.login._tag).toBe('Closed')
      expect(current.status).toBe('Ready')
      expect(current.accounts).toEqual([first])
      expect(current.selectedAccountId).toBe('first')
      expect(current.faces[0]?.preview).toBe('joined Telegram')
    }),
    message(
      Message.CompletedLoadAppCredentials({
        credentials: { _tag: 'Absent' },
      }),
    ),
    model(current => {
      expect(current.accounts).toEqual([first])
    }),
  )
})
