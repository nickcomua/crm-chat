import { expect, given, role, scene, selector, type } from 'foldkit/scene'
import { test } from 'vitest'

import { demo } from './textarea'

test('typing grows the mirror and keeps the accessible name', () => {
  const program = demo()
  scene(
    { update: program.update, view: program.view },
    given(program.init().model),
    expect(role('textbox', { name: 'Message' })).toHaveValue(''),
    expect(role('textbox', { name: 'Message' })).toHaveAttr('rows', '1'),
    expect(selector('.ui-textarea-grow')).toHaveAttr('data-value', '\n'),
    type(role('textbox', { name: 'Message' }), 'Hello\nthere'),
    expect(role('textbox', { name: 'Message' })).toHaveValue('Hello\nthere'),
    expect(selector('.ui-textarea-grow')).toHaveAttr('data-value', 'Hello\nthere\n'),
    expect(role('textbox', { name: 'Message' })).toHaveAttr(
      'placeholder',
      'Write a message',
    ),
  )
})
