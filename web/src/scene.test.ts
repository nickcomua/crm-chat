import { expect, given, role, scene } from 'foldkit/scene'
import { describe, test } from 'vitest'

import { type Model, update, view } from './main'

const initialModel: Model = {}

describe('view', () => {
  test('renders an empty page', () => {
    scene(
      { update, view },
      given(initialModel),
      expect(role('button')).not.toExist(),
    )
  })
})
