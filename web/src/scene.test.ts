import { all, expect, expectAll, given, nth, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { type Model, update, view } from './main'

const initialModel: Model = {}

describe('view', () => {
  test('renders the fixture chat list', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('button')).not.toExist(),
      expect(role('heading')).not.toExist(),
      expectAll(all.role('listitem')).toHaveCount(3),
      expect(nth(all.role('listitem'), 0)).toContainText('Ada'),
      expect(nth(all.role('listitem'), 0)).toContainText('Dialog'),
      expect(nth(all.role('listitem'), 1)).toContainText('Book club'),
      expect(nth(all.role('listitem'), 1)).toContainText('Group'),
      expect(nth(all.role('listitem'), 2)).toContainText('Announcements'),
      expect(nth(all.role('listitem'), 2)).toContainText('Channel'),
    )
  })
})
