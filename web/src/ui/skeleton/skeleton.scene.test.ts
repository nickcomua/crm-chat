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

import { demo } from './skeleton'

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

test('skeletons are busy placeholders and stay out of the tab order', () => {
  scene(
    { update, view },
    given(initialModel),
    expect(role('region', { name: 'Loading chats' })).toHaveAttr(
      'aria-busy',
      'true',
    ),
    expect(selector('.ui-skeleton[data-shape="circle"]')).toHaveAttr(
      'aria-hidden',
      'true',
    ),
    expect(selector('.ui-skeleton[data-shape="circle"]')).toHaveStyle(
      'width',
      '2.5rem',
    ),
    expect(selector('.ui-skeleton[data-shape="circle"]')).not.toHaveAttr(
      'tabindex',
    ),
    expect(role('status', { name: 'Loading messages' })).toHaveAttr(
      'aria-busy',
      'true',
    ),
    expect(role('status', { name: 'Loading messages' })).not.toHaveAttr(
      'tabindex',
    ),
    keydown(role('button', { name: 'After' }), 'Enter'),
    expect(testId('last')).toHaveText('after'),
    keydown(role('button', { name: 'After' }), 'Escape'),
    expectIgnored(),
    expect(testId('last')).toHaveText('after'),
  )
})
