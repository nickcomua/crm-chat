import * as Schema from 'effect/Schema'
import { type Update } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import './input.css'

export type InputType =
  | 'text'
  | 'password'
  | 'email'
  | 'tel'
  | 'url'
  | 'search'
  | 'number'

export type ViewConfig<Message> = Readonly<{
  id: string
  value: string
  onInput: (value: string) => Message
  type?: InputType
  placeholder?: string
  name?: string
  autoComplete?: string
  describedBy?: string
  errorId?: string
  ariaLabel?: string
  isDisabled?: boolean
  isReadOnly?: boolean
  isInvalid?: boolean
  isRequired?: boolean
  isAutofocus?: boolean
}>

export const view = <Message>(
  config: ViewConfig<Message>,
  h: HtmlBuilder<Message>,
): Html =>
  h.input([
    h.Id(config.id),
    h.Class('ui-input'),
    h.Type(config.type === undefined ? 'text' : config.type),
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
    ...(config.autoComplete === undefined
      ? []
      : [h.Autocomplete(config.autoComplete)]),
    ...(config.describedBy === undefined
      ? []
      : [h.AriaDescribedBy(config.describedBy)]),
    ...(config.isInvalid === true && config.errorId !== undefined
      ? [h.AriaErrorMessage(config.errorId)]
      : []),
    ...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
    ...(config.isAutofocus === true ? [h.Autofocus(true)] : []),
  ])

const Model = Schema.Struct({
  name: Schema.String,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
})
type Message = typeof Message.Type

const init = (): Update.Return<Model, Message> => ({
  model: { name: '' },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedName: ({ value }) => ({
      model: modifyFields(model, { name: () => value }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-input-demo')],
    [
      view(
        {
          id: 'ui-input-name',
          ariaLabel: 'Display name',
          value: model.name,
          placeholder: 'Your name',
          autoComplete: 'name',
          onInput: value => Message.UpdatedName({ value }),
        },
        h,
      ),
      view(
        {
          id: 'ui-input-locked',
          ariaLabel: 'User id',
          value: '42',
          isDisabled: true,
          onInput: value => Message.UpdatedName({ value }),
        },
        h,
      ),
      view(
        {
          id: 'ui-input-email',
          ariaLabel: 'Email',
          type: 'email',
          value: 'not-an-email',
          isInvalid: true,
          errorId: 'ui-input-email-error',
          describedBy: 'ui-input-email-error',
          onInput: value => Message.UpdatedName({ value }),
        },
        h,
      ),
      h.p([h.Id('ui-input-email-error')], ['Enter a valid email']),
    ],
  )

export const demo = () => ({
  init,
  update,
  view: demoView,
})
