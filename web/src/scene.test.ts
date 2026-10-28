import * as Option from 'effect/Option'
import { all, click, expect, expectAll, given, nth, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { type Model, update, view } from './main'

const initialModel: Model = { maybeOpenChatId: Option.none() }

describe('view', () => {
  test('opens a chat from the list and returns with back', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('heading')).not.toExist(),
      expect(role('button')).not.toExist(),
      expectAll(all.role('listitem')).toHaveCount(3),
      expect(nth(all.role('listitem'), 0)).toContainText('Ada'),
      expect(nth(all.role('listitem'), 0)).toContainText('Dialog'),
      expect(role('region', { name: 'Open chat' })).toContainText('Select a chat'),
      click(nth(all.role('listitem'), 0)),
      expect(role('region', { name: 'Open chat' })).toContainText('See you at the station.'),
      expect(role('button', { name: 'Back' })).toExist(),
      click(role('button', { name: 'Back' })),
      expect(role('button')).not.toExist(),
      expect(role('region', { name: 'Open chat' })).toContainText('Select a chat'),
    )
  })
})
