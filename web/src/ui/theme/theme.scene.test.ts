import {
  Command,
  all,
  click,
  expect,
  expectAll,
  given,
  keydown,
  role,
  scene,
  text,
} from 'foldkit/scene'
import { test } from 'vitest'

import {
  ApplyTheme,
  FocusThemeOption,
  Message,
  initialModel,
  update,
  view,
} from './theme'

const applied = () => Command.resolve(ApplyTheme, Message.CompletedApplyTheme())

const moved = () => [
  Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
  Command.resolve(FocusThemeOption, Message.CompletedFocusThemeOption()),
]

test('theme switcher is a radiogroup and arrow keys wrap the selection', () => {
  scene(
    { update, view },
    given(initialModel),
    expect(role('radiogroup', { name: 'Theme' })).toHaveAttr(
      'aria-orientation',
      'horizontal',
    ),
    expectAll(all.role('radio')).toHaveCount(3),
    expect(role('radio', { name: 'System' })).toBeChecked(),
    expect(role('radio', { name: 'System' })).toHaveAttr('tabIndex', '0'),
    expect(role('radio', { name: 'Light' })).toHaveAttr('tabIndex', '-1'),
    expect(role('radio', { name: 'Dark' })).toHaveAttr('tabIndex', '-1'),
    expect(role('radio', { name: 'Light' })).not.toBeChecked(),
    click(role('radio', { name: 'Light' })),
    applied(),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
    expect(role('radio', { name: 'System' })).not.toBeChecked(),
    expect(role('radio', { name: 'Light' })).toHaveAttr('tabIndex', '0'),
    expect(text('Preference light, resolved light.')).toExist(),
    keydown(role('radio', { name: 'Light' }), 'ArrowRight'),
    ...moved(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    expect(role('radio', { name: 'Dark' })).toHaveAttr('tabIndex', '0'),
    expect(role('radio', { name: 'Light' })).toHaveAttr('tabIndex', '-1'),
    expect(text('Preference dark, resolved dark.')).toExist(),
    keydown(role('radio', { name: 'Dark' }), 'ArrowRight'),
    ...moved(),
    expect(role('radio', { name: 'System' })).toBeChecked(),
    keydown(role('radio', { name: 'System' }), 'End'),
    ...moved(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), 'Home'),
    ...moved(),
    expect(role('radio', { name: 'System' })).toBeChecked(),
    keydown(role('radio', { name: 'System' }), 'ArrowUp'),
    ...moved(),
    expect(role('radio', { name: 'Dark' })).toBeChecked(),
    keydown(role('radio', { name: 'Dark' }), 'ArrowLeft'),
    ...moved(),
    expect(role('radio', { name: 'Light' })).toBeChecked(),
  )
})
