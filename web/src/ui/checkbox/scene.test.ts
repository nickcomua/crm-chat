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
  text,
} from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './checkbox'

test('click and Space toggle, indeterminate commits checked, read-only ignores keys', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('checkbox', { name: 'Accept terms' })).not.toBeChecked(),
    click(role('checkbox', { name: 'Accept terms' })),
    expectHandled(),
    expect(role('checkbox', { name: 'Accept terms' })).toBeChecked(),
    expect(role('checkbox', { name: 'Accept terms' })).toHaveAttr(
      'data-state',
      'checked',
    ),
    expect(selector('input[name="terms"]')).toHaveValue('on'),
    keydown(role('checkbox', { name: 'Accept terms' }), ' '),
    expectHandled(),
    expect(role('checkbox', { name: 'Accept terms' })).not.toBeChecked(),
    expect(selector('input[name="terms"]')).not.toExist(),
    keydown(role('checkbox', { name: 'Accept terms' }), 'a'),
    expectIgnored(),
    expect(role('checkbox', { name: 'Some mail' })).toHaveAttr(
      'aria-checked',
      'mixed',
    ),
    click(role('checkbox', { name: 'Some mail' })),
    expectHandled(),
    expect(role('checkbox', { name: 'Some mail' })).toBeChecked(),
    expect(role('checkbox', { name: 'Some mail' })).toHaveAttr(
      'aria-checked',
      'true',
    ),
    expect(role('checkbox', { name: 'Locked mail' })).toHaveAttr(
      'aria-readonly',
      'true',
    ),
    keydown(role('checkbox', { name: 'Locked mail' }), ' '),
    expectIgnored(),
    expect(role('checkbox', { name: 'Locked mail' })).toBeChecked(),
    expect(role('checkbox', { name: 'Disabled mail' })).toBeDisabled(),
    expect(text('Accept terms')).toHaveAttr('htmlFor', 'accept-terms'),
  )
})
