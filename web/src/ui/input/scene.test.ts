import { expect, given, role, scene, type } from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './input'

test('typing, disabled, and invalid state', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('textbox', { name: 'Display name' })).toHaveValue(''),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'placeholder',
      'Your name',
    ),
    expect(role('textbox', { name: 'Display name' })).toHaveAttr(
      'autocomplete',
      'name',
    ),
    type(role('textbox', { name: 'Display name' }), 'Ada'),
    expect(role('textbox', { name: 'Display name' })).toHaveValue('Ada'),
    expect(role('textbox', { name: 'User id' })).toBeDisabled(),
    expect(role('textbox', { name: 'User id' })).toHaveValue('42'),
    expect(role('textbox', { name: 'Email' })).toHaveAttr('aria-invalid', 'true'),
    expect(role('textbox', { name: 'Email' })).toHaveAttr(
      'aria-errormessage',
      'ui-input-email-error',
    ),
    expect(role('textbox', { name: 'Email' })).toHaveAccessibleDescription(
      'Enter a valid email',
    ),
  )
})
