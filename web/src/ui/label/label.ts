import * as Schema from 'effect/Schema'
import { type Update } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import './label.css'

export type ViewConfig = Readonly<{
  htmlFor: string
  text: string
  id?: string
  isDisabled?: boolean
}>

export const view = <Message>(
  config: ViewConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.label(
    [
      h.Class('ui-label'),
      h.For(config.htmlFor),
      ...(config.id === undefined ? [] : [h.Id(config.id)]),
      ...(config.isDisabled === true
        ? [h.DataAttribute('disabled', '')]
        : []),
    ],
    [config.text],
  )

const Model = Schema.Struct({
  value: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  UpdatedValue: { value: Schema.String },
})
type Message = typeof Message.Type

const init = (): Update.Return<Model, Message> => ({
  model: { value: '' },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedValue: ({ value }) => ({
      model: modifyFields(model, { value: () => value }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-label-demo')],
    [
      view({ htmlFor: 'ui-label-demo', text: 'Display name' }, h),
      h.input([
        h.Id('ui-label-demo'),
        h.Class('ui-label-demo-input'),
        h.Type('text'),
        h.Value(model.value),
        h.Placeholder('Your name'),
        h.OnInput(value => Message.UpdatedValue({ value })),
      ]),
    ],
  )

export const demo = () => ({
  init,
  update,
  view: demoView,
})
