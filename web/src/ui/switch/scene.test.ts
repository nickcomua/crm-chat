import {
  click,
  expect,
  expectHandled,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
} from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './switch'

test('Space and click toggle the switch; read-only and disabled do not', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('switch', { name: 'Notifications' })).not.toBeChecked(),
    expect(role('switch', { name: 'Notifications' })).toHaveAttr(
      'data-state',
      'unchecked',
    ),
    keydown(role('switch', { name: 'Notifications' }), ' '),
    expectHandled(),
    expect(role('switch', { name: 'Notifications' })).toBeChecked(),
    expect(selector('input[name="notifications"]')).toHaveValue('on'),
    click(role('switch', { name: 'Notifications' })),
    expectHandled(),
    expect(role('switch', { name: 'Notifications' })).not.toBeChecked(),
    keydown(role('switch', { name: 'Notifications' }), 'Enter'),
    expectHandled(),
    expect(role('switch', { name: 'Notifications' })).toBeChecked(),
    keydown(role('switch', { name: 'Notifications' }), 'a'),
    expectIgnored(),
    expect(role('switch', { name: 'Locked notifications' })).toHaveAttr(
      'aria-readonly',
      'true',
    ),
    keydown(role('switch', { name: 'Locked notifications' }), ' '),
    expectIgnored(),
    expect(role('switch', { name: 'Locked notifications' })).toBeChecked(),
    expect(role('switch', { name: 'Disabled notifications' })).toBeDisabled(),
  )
})
