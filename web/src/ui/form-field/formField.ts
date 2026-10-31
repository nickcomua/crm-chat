import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Update } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { view as inputView } from '../input/input'
import { view as labelView } from '../label/label'
import './formField.css'

export type FieldControl = Readonly<{
  id: string
  labelId: string
  descriptionId: string
  errorId: string
  isInvalid: boolean
  isDisabled: boolean
  describedBy: Option.Option<string>
}>

export type ViewConfig<_Message> = Readonly<{
  id: string
  label: string
  error: Option.Option<string>
  control: (field: FieldControl) => Html
  description?: string
  isDisabled?: boolean
}>

const labelElementId = (id: string): string => `${id}-label`
const descriptionElementId = (id: string): string => `${id}-description`
const errorElementId = (id: string): string => `${id}-error`

const describedByFor = (
  id: string,
  description: string | undefined,
  error: Option.Option<string>,
): Option.Option<string> => {
  const withDescription: ReadonlyArray<string> =
    description === undefined ? [] : [descriptionElementId(id)]
  const withError: ReadonlyArray<string> = Option.match(error, {
    onNone: () => [],
    onSome: () => [errorElementId(id)],
  })
  return Array.match(Array.appendAll(withDescription, withError), {
    onEmpty: () => Option.none(),
    onNonEmpty: ids => Option.some(Array.join(ids, ' ')),
  })
}

export const view = <Message>(
  config: ViewConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const isInvalid = Option.isSome(config.error)
  const field: FieldControl = {
    id: config.id,
    labelId: labelElementId(config.id),
    descriptionId: descriptionElementId(config.id),
    errorId: errorElementId(config.id),
    isInvalid,
    isDisabled: config.isDisabled === true,
    describedBy: describedByFor(config.id, config.description, config.error),
  }
  return h.div(
    [
      h.Class('ui-field'),
      ...(isInvalid ? [h.DataAttribute('invalid', '')] : []),
    ],
    [
      labelView(
        {
          htmlFor: config.id,
          id: field.labelId,
          text: config.label,
          isDisabled: field.isDisabled,
        },
        h,
      ),
      config.control(field),
      ...(config.description === undefined
        ? []
        : [
            h.p(
              [h.Id(field.descriptionId), h.Class('ui-field-description')],
              [config.description],
            ),
          ]),
      ...Option.match(config.error, {
        onNone: () => [],
        onSome: text => [
          h.p(
            [h.Id(field.errorId), h.Class('ui-field-error'), h.Role('alert')],
            [text],
          ),
        ],
      }),
    ],
  )
}

const Model = Schema.Struct({
  value: Schema.String,
  error: Schema.Option(Schema.String),
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  UpdatedName: { value: Schema.String },
  ClickedClear: {},
})
type Message = typeof Message.Type

const errorFor = (value: string): Option.Option<string> => {
  if (value === '') {
    return Option.some('Name is required')
  }
  return Option.none()
}

const init = (): Update.Return<Model, Message> => ({
  model: {
    value: '',
    error: Option.some('Name is required'),
  },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedName: ({ value }) => ({
      model: modifyFields(model, {
        value: () => value,
        error: () => errorFor(value),
      }),
    }),
    ClickedClear: () => ({
      model: modifyFields(model, {
        value: () => '',
        error: () => Option.some('Name is required'),
      }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-field-demo')],
    [
      view(
        {
          id: 'display-name',
          label: 'Display name',
          description: 'Shown on your profile',
          error: model.error,
          control: field =>
            inputView(
              {
                id: field.id,
                value: model.value,
                placeholder: 'Your name',
                isInvalid: field.isInvalid,
                isDisabled: field.isDisabled,
                onInput: value => Message.UpdatedName({ value }),
                ...(Option.isSome(field.describedBy)
                  ? { describedBy: field.describedBy.value }
                  : {}),
                ...(field.isInvalid ? { errorId: field.errorId } : {}),
              },
              h,
            ),
        },
        h,
      ),
      h.button(
        [h.Type('button'), h.OnClick(Message.ClickedClear())],
        ['Clear name'],
      ),
    ],
  )

export const demo = () => ({
  init,
  update,
  view: demoView,
})
