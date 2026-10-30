import * as Option from 'effect/Option'
import {
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

import { fixtureChats, fixtureFaces } from './fixture'
import { initialModel, update, view } from './main'

const signedIn = modifyFields(initialModel, {
  login: () => ({ _tag: 'Closed' }),
  accounts: () => [{ id: 'preview', title: 'You', chats: [...fixtureChats] }],
  selectedAccountId: () => 'preview',
  faces: () => fixtureFaces(),
})

test('opens a fixture chat, shows a caption, and returns with back', () => {
  scene(
    { update, view },
    given(signedIn),
    expect(role('button', { name: 'Menu' })).toExist(),
    expect(role('button', { name: 'Back' })).not.toExist(),
    expectAll(all.role('listitem')).toHaveCount(12),
    expect(nth(all.role('listitem'), 0)).toContainText('Ada'),
    expect(nth(all.role('listitem'), 0)).toContainText('Bring the notes.'),
    expect(nth(all.role('listitem'), 0)).toContainText('✓✓'),
    expect(nth(all.role('listitem'), 1)).toContainText('3'),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Select a chat',
    ),
    click(nth(all.role('listitem'), 0)),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'See you at the station.',
    ),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Station sketch',
    ),
    expect(role('textbox', { name: 'Message' })).toExist(),
    expect(role('button', { name: 'Emoji' })).toExist(),
    expect(role('button', { name: 'Attach' })).toExist(),
    expect(role('button', { name: 'Voice message' })).toExist(),
    expect(role('button', { name: 'Search' })).toExist(),
    expect(role('button', { name: 'Call' })).toExist(),
    expect(role('region', { name: 'Open chat' })).not.toContainText('☎'),
    expect(role('button', { name: 'Back' })).toExist(),
    click(role('button', { name: 'Back' })),
    expect(role('button', { name: 'Back' })).not.toExist(),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Select a chat',
    ),
  )
})

test('opens the menu and the more flyout', () => {
  scene(
    { update, view },
    given(signedIn),
    expect(role('menu', { name: 'Menu' })).not.toExist(),
    click(role('button', { name: 'Menu' })),
    expect(role('menu', { name: 'Menu' })).toContainText('Saved messages'),
    expect(role('button', { name: 'Add account' })).toExist(),
    click(role('button', { name: 'More' })),
    expect(role('menu', { name: 'More menu' })).toContainText(
      'About this build',
    ),
  )
})

test('mute, auto-delete, and delete stay in the open chat menu', () => {
  scene(
    { update, view },
    given(signedIn),
    click(nth(all.role('listitem'), 0)),
    click(role('button', { name: 'Chat menu' })),
    click(role('button', { name: 'Auto-delete' })),
    click(role('button', { name: '1 week' })),
    click(role('button', { name: 'Chat menu' })),
    expect(role('menu', { name: 'Chat menu' })).toContainText('1 week'),
    click(role('button', { name: 'Mute' })),
    expect(nth(all.role('listitem'), 0)).toContainText('Muted'),
    click(role('button', { name: 'Chat menu' })),
    expect(role('button', { name: 'Unmute' })).toExist(),
    click(role('button', { name: 'Delete chat' })),
    expectAll(all.role('listitem')).toHaveCount(11),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Select a chat',
    ),
  )
})

test('a channel thread has no composer', () => {
  scene(
    { update, view },
    given(
      modifyFields(signedIn, {
        maybeOpenChatId: () => Option.some('announcements'),
      }),
    ),
    expect(role('region', { name: 'Open chat' })).toContainText(
      'Replies are off',
    ),
    expect(role('textbox', { name: 'Message' })).not.toExist(),
  )
})

test('search hides chats that do not match', () => {
  scene(
    { update, view },
    given(signedIn),
    type(role('searchbox', { name: 'Search chats' }), 'Ada'),
    expectAll(all.role('listitem')).toHaveCount(1),
    expect(nth(all.role('listitem'), 0)).toContainText('Ada'),
  )
})
