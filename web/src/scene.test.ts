import * as Option from 'effect/Option'
import { all, click, expect, expectAll, given, nth, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { type Model, update, view } from './main'

const initialModel: Model = {
  maybeOpenChatId: Option.none(),
  query: '',
  draft: '',
  menuOpen: false,
  moreOpen: false,
  headerMenuOpen: false,
  autoDeleteOpen: false,
  autoDelete: 'Never',
  hiddenChatIds: [],
  mutedChatIds: [],
}

describe('view', () => {
  test('opens a chat from the list and returns with back', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('heading')).not.toExist(),
      expect(role('button', { name: 'Menu' })).toExist(),
      expect(role('button', { name: 'Back' })).not.toExist(),
      expectAll(all.role('listitem')).toHaveCount(12),
      expect(nth(all.role('listitem'), 0)).toContainText('Ada'),
      expect(nth(all.role('listitem'), 0)).toContainText('Bring the notes.'),
      expect(role('region', { name: 'Open chat' })).toContainText('Select a chat'),
      click(nth(all.role('listitem'), 0)),
      expect(role('region', { name: 'Open chat' })).toContainText('See you at the station.'),
      expect(role('button', { name: 'Back' })).toExist(),
      click(role('button', { name: 'Back' })),
      expect(role('button', { name: 'Back' })).not.toExist(),
      expect(role('region', { name: 'Open chat' })).toContainText('Select a chat'),
    )
  })

  test('opens the menu and the more flyout', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('menu', { name: 'Menu' })).not.toExist(),
      click(role('button', { name: 'Menu' })),
      expect(role('menu', { name: 'Menu' })).toContainText('Saved messages'),
      click(role('button', { name: 'More' })),
      expect(role('menu', { name: 'More menu' })).toContainText('About this build'),
    )
  })

  test('delete removes the open chat and auto-delete keeps the choice', () => {
    scene(
      { update, view },
      given(initialModel),
      click(nth(all.role('listitem'), 0)),
      click(role('button', { name: 'Chat menu' })),
      click(role('button', { name: 'Auto-delete' })),
      click(role('button', { name: '1 week' })),
      click(role('button', { name: 'Chat menu' })),
      expect(role('menu', { name: 'Chat menu' })).toContainText('1 week'),
      click(role('button', { name: 'Delete chat' })),
      expectAll(all.role('listitem')).toHaveCount(11),
      expect(role('region', { name: 'Open chat' })).toContainText('Select a chat'),
    )
  })
})
