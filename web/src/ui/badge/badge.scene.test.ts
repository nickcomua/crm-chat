import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { Update } from 'foldkit'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import {
  expect,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
  testId,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { test } from 'vitest'

import { demo } from './badge'

const Model = Schema.Struct({
  last: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  PressedAfter: {},
})
type Message = typeof Message.Type

const initialModel: Model = { last: 'idle' }

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    PressedAfter: () => ({
      model: modifyFields(model, { last: () => 'after' }),
    }),
  })

const view = (model: Model, h: HtmlBuilder<Message>) =>
  h.div(
    [],
    [
      demo(h),
      h.button(
        [
          h.Type('button'),
          h.OnClick(Message.PressedAfter()),
          h.OnKeyDownPreventDefault((key, modifiers) => {
            if (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) {
              return Option.none()
            }
            if (key === 'Enter' || key === ' ') {
              return Option.some(Message.PressedAfter())
            }
            return Option.none()
          }),
        ],
        ['After'],
      ),
      h.span([h.DataAttribute('testid', 'last')], [model.last]),
    ],
  )

test('badges expose variant and live name without taking a tab stop', () => {
  scene(
    { update, view },
    given(initialModel),
    expect(selector('.ui-badge[data-variant="default"]')).toHaveText('Online'),
    expect(selector('.ui-badge[data-variant="secondary"]')).toHaveText('Muted'),
    expect(selector('.ui-badge[data-variant="destructive"]')).toHaveText(
      'Failed',
    ),
    expect(selector('.ui-badge[data-variant="outline"]')).toHaveText('Draft'),
    expect(role('status', { name: '3 unread' })).toHaveText('3'),
    expect(role('status', { name: '3 unread' })).toHaveAttr(
      'aria-live',
      'polite',
    ),
    expect(selector('.ui-badge[data-variant="secondary"]')).not.toHaveAttr(
      'tabindex',
    ),
    expect(role('button', { name: 'Online' })).not.toExist(),
    keydown(role('button', { name: 'After' }), 'Enter'),
    expect(testId('last')).toHaveText('after'),
    keydown(role('button', { name: 'After' }), 'Escape'),
    expectIgnored(),
    expect(testId('last')).toHaveText('after'),
  )
})
