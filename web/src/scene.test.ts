import * as Redacted from 'effect/Redacted'
import {
  Command,
  all,
  click,
  expect,
  expectAll,
  given,
  nth,
  role,
  scene,
  type,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { test } from 'vitest'

import {
  BeginLogin,
  LoadHistory,
  Message,
  Refresh,
  SubmitAnswer,
  initialModel,
  update,
  view,
} from './main'
import { AuthResult } from './telegram'

const account = {
  id: 'one',
  title: 'Ada',
  chats: [
    { id: 'one:1', title: 'Saved Messages', kind: 'Dialog' },
    { id: 'one:2', title: 'Book club', kind: 'Group' },
    { id: 'one:3', title: 'News', kind: 'Channel' },
  ],
} satisfies typeof import('./telegram').Account.Type

test('phone login requests 2FA then loads distinct chat types', () => {
  scene(
    { update, view },
    given(initialModel),
    click(role('button', { name: 'Log in by phone number' })),
    type(role('textbox', { name: 'API ID' }), '12345'),
    type(
      role('textbox', { name: 'API hash' }),
      '0123456789abcdef0123456789abcdef',
    ),
    type(role('textbox', { name: 'Phone number' }), '+31000000000'),
    click(role('button', { name: 'Next' })),
    Command.resolve(
      BeginLogin,
      Message.SucceededAuthenticate({
        result: AuthResult.Code({ id: 'one' }),
        sourceId: '',
      }),
    ),
    type(role('textbox', { name: 'Login code' }), '12345'),
    click(role('button', { name: 'Continue' })),
    Command.resolve(
      SubmitAnswer,
      Message.SucceededAuthenticate({
        result: AuthResult.Password({ id: 'one' }),
        sourceId: 'one',
      }),
    ),
    type(role('textbox', { name: '2FA password' }), 'test password'),
    click(role('button', { name: 'Continue' })),
    Command.resolve(
      SubmitAnswer,
      Message.SucceededAuthenticate({
        result: AuthResult.Authorized({ account }),
        sourceId: 'one',
      }),
    ),
    Command.resolve(Refresh, Message.SucceededRefresh({ account })),
    expect(role('region', { name: 'Telegram login' })).not.toExist(),
    expectAll(all.role('listitem')).toHaveCount(3),
    expect(role('region', { name: 'Telegram chats' })).toContainText(
      'personal chat',
    ),
    expect(role('region', { name: 'Telegram chats' })).toContainText('group'),
    expect(role('region', { name: 'Telegram chats' })).toContainText('channel'),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Select a chat to start messaging',
    ),
  )
})

test('opening a chat loads its message history', () => {
  scene(
    { update, view },
    given(
      modifyFields(initialModel, {
        login: () => ({ _tag: 'Closed' }),
        accounts: () => [account],
        selectedAccountId: () => 'one',
        faces: () => [
          {
            id: 'one:1',
            time: '12:00',
            preview: 'Bring the notes.',
            unread: 0,
            receipt: 'none',
            lines: [],
          },
        ],
      }),
    ),
    expect(role('region', { name: 'Telegram chats' })).toContainText(
      'Bring the notes.',
    ),
    click(nth(all.role('listitem'), 0)),
    Command.resolve(
      LoadHistory,
      Message.LoadedHistory({
        id: 'one:1',
        lines: [
          { text: 'See you at the station.', mine: false, time: '12:04' },
        ],
      }),
    ),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'See you at the station.',
    ),
    expect(role('region', { name: 'Open chat' })).not.toContainText(
      'No messages yet',
    ),
  )
})

test('QR login displays a scannable image', () => {
  scene(
    { update, view },
    given(
      modifyFields(initialModel, {
        apiId: () => '12345',
        apiHash: () => Redacted.make('0123456789abcdef0123456789abcdef'),
      }),
    ),
    click(role('button', { name: 'Log in by QR code' })),
    Command.resolve(
      BeginLogin,
      Message.SucceededAuthenticate({
        result: AuthResult.Qr({
          id: 'one',
          image: 'data:image/png;base64,AAAA',
        }),
        sourceId: '',
      }),
    ),
    expect(role('img', { name: 'Telegram login QR code' })).toExist(),
    expect(role('button', { name: 'Cancel' })).toExist(),
  )
})

test('invalid 2FA answers announce the error and allow another attempt', () => {
  scene(
    { update, view },
    given(
      modifyFields(initialModel, {
        login: () => ({ _tag: 'Password', id: 'one' }),
      }),
    ),
    type(role('textbox', { name: '2FA password' }), 'incorrect'),
    click(role('button', { name: 'Continue' })),
    Command.resolve(
      SubmitAnswer,
      Message.FailedAuthenticate({
        sourceId: 'one',
        error: 'The password is incorrect. Try again.',
      }),
    ),
    expect(role('alert')).toContainText('The password is incorrect'),
    type(role('textbox', { name: '2FA password' }), 'correct'),
    click(role('button', { name: 'Continue' })),
    Command.resolve(
      SubmitAnswer,
      Message.SucceededAuthenticate({
        sourceId: 'one',
        result: AuthResult.Authorized({ account }),
      }),
    ),
    Command.resolve(Refresh, Message.SucceededRefresh({ account })),
    expect(role('alert')).not.toExist(),
    expect(role('region', { name: 'Telegram chats' })).toExist(),
  )
})

test('supplied application credentials are not rendered as inputs', () => {
  scene(
    { update, view },
    given(
      modifyFields(initialModel, {
        appCredentials: () => 'Supplied',
        apiId: () => '12345',
        apiHash: () => Redacted.make('0123456789abcdef0123456789abcdef'),
      }),
    ),
    expect(role('textbox', { name: 'API ID' })).not.toExist(),
    expect(role('textbox', { name: 'API hash' })).not.toExist(),
    expect(role('textbox', { name: 'Phone number' })).not.toExist(),
    expect(role('checkbox', { name: 'Keep me signed in' })).not.toExist(),
    expect(role('button', { name: 'Log in by QR code' })).toExist(),
    expect(role('button', { name: 'Log in by phone number' })).toExist(),
    click(role('button', { name: 'Log in by phone number' })),
    expect(role('button', { name: 'Country' })).toExist(),
    expect(role('textbox', { name: 'Phone number' })).toExist(),
    expect(role('region', { name: 'Telegram login' })).toContainText('+31'),
    expect(role('checkbox', { name: 'Keep me signed in' })).not.toExist(),
  )
})
