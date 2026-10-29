import { expect, given, role, scene, type } from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './label'

test('label names its control and typing updates the value', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('textbox', { name: 'Display name' })).toHaveValue(''),
    type(role('textbox', { name: 'Display name' }), 'Ada'),
    expect(role('textbox', { name: 'Display name' })).toHaveValue('Ada'),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'placeholder',
      'Your name',
    ),
  )
})
