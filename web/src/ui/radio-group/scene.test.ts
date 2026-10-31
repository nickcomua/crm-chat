import {
  click,
  expect,
  expectHandled,
  expectIgnored,
  expectNoOutMessage,
  expectOutMessage,
  given,
  keydown,
  role,
  scene,
  selector,
} from 'foldkit/scene'
import { test } from 'vitest'

import { OutMessage, demo } from './radioGroup'

test('arrows skip disabled options, wrap, and select', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('radiogroup', { name: 'Theme' })).toHaveAttr(
      'aria-orientation',
      'vertical',
    ),
    expect(role('radio', { name: 'Light' })).toHaveAttr('tabIndex', '0'),
    expect(role('radio', { name: 'Light' })).toHaveAccessibleDescription(
      'Bright background',
    ),
    expect(role('radio', { name: 'System' })).toBeDisabled(),
    expect(role('radio', { name: 'Dark' })).toHaveAttr('tabIndex', '-1'),
    expect(selector('input[name="theme"]')).not.toExist(),
    keydown(role('radio', { name: 'Light' }), 'ArrowDown'),
    expectHandled(),
    expectOutMessage(OutMessage.Selected({ value: 'dark', index: 2 })),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    expect(role('radio', { name: 'Light' })).not.toBeChecked(),
    expect(role('radio', { name: 'Dark' })).toHaveAttr('tabIndex', '0'),
    expect(selector('input[name="theme"]')).toHaveValue('dark'),
    keydown(role('radio', { name: 'Dark' }), 'ArrowDown'),
    expectHandled(),
    expectOutMessage(OutMessage.Selected({ value: 'light', index: 0 })),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
    keydown(role('radio', { name: 'Light' }), 'End'),
    expectHandled(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), 'Home'),
    expectHandled(),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
    keydown(role('radio', { name: 'Light' }), 'ArrowUp'),
    expectHandled(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), 'Enter'),
    expectIgnored(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), ' '),
    expectHandled(),
    expectOutMessage(OutMessage.Selected({ value: 'dark', index: 2 })),
    click(role('radio', { name: 'Light' })),
    expectHandled(),
    expectOutMessage(OutMessage.Selected({ value: 'light', index: 0 })),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
  )
})

test('read-only arrows move focus without selecting', () => {
  const program = demo({
    orientation: 'Vertical',
    isDisabled: false,
    isReadOnly: true,
  })
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('radiogroup', { name: 'Theme' })).toHaveAttr(
      'aria-readonly',
      'true',
    ),
    keydown(role('radio', { name: 'Light' }), 'ArrowDown'),
    expectHandled(),
    expectNoOutMessage(),
    expect(role('radio', { name: 'Dark' })).toHaveAttr('tabIndex', '0'),
    expect(role('radio', { name: 'Light' })).toHaveAttr('tabIndex', '-1'),
    expect(role('radio', { name: 'Dark' })).not.toBeChecked(),
    expect(role('radio', { name: 'Light' })).not.toBeChecked(),
    expect(selector('input[name="theme"]')).not.toExist(),
    keydown(role('radio', { name: 'Dark' }), ' '),
    expectIgnored(),
    expect(role('radio', { name: 'Dark' })).not.toBeChecked(),
  )
})

test('a disabled group exposes disabled radios', () => {
  const program = demo({
    orientation: 'Vertical',
    isDisabled: true,
    isReadOnly: false,
  })
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('radiogroup', { name: 'Theme' })).toHaveAttr(
      'aria-disabled',
      'true',
    ),
    expect(role('radio', { name: 'Light' })).toBeDisabled(),
    expect(role('radio', { name: 'Dark' })).toBeDisabled(),
  )
})

test('horizontal groups use left and right arrows', () => {
  const program = demo({
    orientation: 'Horizontal',
    isDisabled: false,
    isReadOnly: false,
  })
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('radiogroup', { name: 'Theme' })).toHaveAttr(
      'data-orientation',
      'horizontal',
    ),
    keydown(role('radio', { name: 'Light' }), 'ArrowRight'),
    expectHandled(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), 'ArrowLeft'),
    expectHandled(),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
  )
})
