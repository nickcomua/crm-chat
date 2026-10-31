import * as Schema from 'effect/Schema'
import { type Update } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { view as labelView } from '../label/label'
import './textarea.css'

export type ViewConfig<Message> = Readonly<{
  id: string
  value: string
  onInput: (value: string) => Message
  placeholder?: string
  name?: string
  describedBy?: string
  errorId?: string
  ariaLabel?: string
  rows?: number
  isDisabled?: boolean
  isReadOnly?: boolean
  isInvalid?: boolean
  isRequired?: boolean
}>

const mirrorValue = (value: string): string => `${value}\n`

export const view = <Message>(
  config: ViewConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('ui-textarea-grow'), h.DataAttribute('value', mirrorValue(config.value))],
    [
      h.textarea([
        h.Id(config.id),
        h.Class('ui-textarea'),
        h.Rows(config.rows === undefined ? 1 : config.rows),
        h.Value(config.value),
        h.OnInput(config.onInput),
        h.Disabled(config.isDisabled === true),
        h.Readonly(config.isReadOnly === true),
        h.Required(config.isRequired === true),
        h.AriaInvalid(config.isInvalid === true),
        h.AriaRequired(config.isRequired === true),
        ...(config.placeholder === undefined
          ? []
          : [h.Placeholder(config.placeholder)]),
        ...(config.name === undefined ? [] : [h.Name(config.name)]),
        ...(config.describedBy === undefined
          ? []
          : [h.AriaDescribedBy(config.describedBy)]),
        ...(config.isInvalid === true && config.errorId !== undefined
          ? [h.AriaErrorMessage(config.errorId)]
          : []),
        ...(config.ariaLabel === undefined
          ? []
          : [h.AriaLabel(config.ariaLabel)]),
      ]),
    ],
  )

const Model = Schema.Struct({
  message: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  UpdatedMessage: { value: Schema.String },
})
type Message = typeof Message.Type

const init = (): Update.Return<Model, Message> => ({
  model: { message: '' },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedMessage: ({ value }) => ({
      model: modifyFields(model, { message: () => value }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-textarea-demo')],
    [
      labelView({ htmlFor: 'ui-textarea-demo', text: 'Message' }, h),
      view(
        {
          id: 'ui-textarea-demo',
          value: model.message,
          placeholder: 'Write a message',
          onInput: value => Message.UpdatedMessage({ value }),
        },
        h,
      ),
    ],
  )

export const demo = () => ({
  init,
  update,
  view: demoView,
})
