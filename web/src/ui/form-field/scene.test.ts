import { click, expect, given, role, scene, type } from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './formField'

test('error text is described, then clears when the value is present', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-invalid',
      'true',
    ),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-describedby',
      'display-name-description display-name-error',
    ),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-errormessage',
      'display-name-error',
    ),
    expect(role('alert')).toHaveText('Name is required'),
    expect(role('textbox', { name: 'Display name' })).toHaveAccessibleDescription(
      /Shown on your profile/,
    ),
    type(role('textbox', { name: 'Display name' }), 'Ada'),
    expect(role('textbox', { name: 'Display name' })).toHaveValue('Ada'),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-invalid',
      'false',
    ),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-describedby',
      'display-name-description',
    ),
    expect(role('alert')).not.toExist(),
    click(role('button', { name: 'Clear name' })),
    expect(role('textbox', { name: 'Display name' })).toHaveValue(''),
    expect(role('alert')).toHaveText('Name is required'),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'aria-invalid',
      'true',
    ),
  )
})
