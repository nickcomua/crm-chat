import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { Update } from 'foldkit'
import type { HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import {
  expect,
  given,
  keydown,
  role,
  scene,
  selector,
  testId,
} from 'foldkit/scene'
import { modifyFields } from 'foldkit/struct'
import { test } from 'vitest'

import { demo, view as separatorView } from './separator'

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

const after = (h: HtmlBuilder<Message>, model: Model) => [
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
]

test('decorative separators are hidden and semantic ones expose orientation', () => {
  scene(
    {
      update,
      view: (model: Model, h: HtmlBuilder<Message>) =>
        h.div([], [demo(h), ...after(h, model)]),
    },
    given(initialModel),
    expect(selector('.ui-separator[aria-hidden="true"]')).toHaveAttr(
      'data-orientation',
      'horizontal',
    ),
    expect(role('separator')).toHaveAttr('aria-orientation', 'vertical'),
    expect(role('separator')).not.toHaveAttr('tabindex'),
    expect(role('separator')).not.toHaveAttr('aria-hidden'),
    keydown(role('button', { name: 'After' }), ' '),
    expect(testId('last')).toHaveText('after'),
  )
})

test('a semantic horizontal separator is exposed to assistive tech and skipped by Tab', () => {
  scene(
    {
      update,
      view: (model: Model, h: HtmlBuilder<Message>) =>
        h.div(
          [],
          [separatorView({ isDecorative: false }, h), ...after(h, model)],
        ),
    },
    given(initialModel),
    expect(role('separator')).toHaveAttr('aria-orientation', 'horizontal'),
    expect(role('separator')).not.toHaveAttr('tabindex'),
    keydown(role('button', { name: 'After' }), 'Enter'),
    expect(testId('last')).toHaveText('after'),
  )
})
