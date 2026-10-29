import * as Redacted from 'effect/Redacted'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import {
  BeginLogin,
  Disconnect,
  Message,
  type Model,
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
    Command.resolve(Restore, Message.CompletedRestore({ accounts: [first] })),
    Command.resolve(Refresh, Message.SucceededRefresh({ account: first })),
    model(current => {
      expect(current.login._tag).toBe('Closed')
      expect(current.accounts).toEqual([first])
      expect(current.selectedAccountId).toBe('first')
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
