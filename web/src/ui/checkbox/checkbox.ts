import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Update } from 'foldkit'
import {
  type Html,
  type HtmlBuilder,
  type KeyboardModifiers,
} from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { view as labelView } from '../label/label'
import './checkbox.css'

export type CheckedState = 'checked' | 'unchecked' | 'indeterminate'

export const checkedState = (
  isChecked: boolean,
  isIndeterminate: boolean,
): CheckedState => {
  if (isIndeterminate) {
    return 'indeterminate'
  }
  if (isChecked) {
    return 'checked'
  }
  return 'unchecked'
}

export const nextChecked = (
  isChecked: boolean,
  isIndeterminate: boolean,
): boolean => isIndeterminate || isChecked === false

export type ViewConfig<Message> = Readonly<{
  id: string
  isChecked: boolean
  onToggle: (isChecked: boolean) => Message
  label?: string
  ariaLabel?: string
  describedBy?: string
  name?: string
  value?: string
  isDisabled?: boolean
  isReadOnly?: boolean
  isIndeterminate?: boolean
  isRequired?: boolean
}>

const labelElementId = (id: string): string => `${id}-label`

export const view = <Message>(
  config: ViewConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const isDisabled = config.isDisabled === true
  const isReadOnly = config.isReadOnly === true
  const isIndeterminate = config.isIndeterminate === true
  const isInteractive = isDisabled === false && isReadOnly === false
  const state = checkedState(config.isChecked, isIndeterminate)
  const toggled = nextChecked(config.isChecked, isIndeterminate)
  const onKeyDown = (
    key: string,
    _modifiers: KeyboardModifiers,
  ): Option.Option<Message> => {
    if (isInteractive === false) {
      return Option.none()
    }
    if (key === ' ' || key === 'Enter') {
      return Option.some(config.onToggle(toggled))
    }
    return Option.none()
  }
  const control = h.button(
    [
      h.Id(config.id),
      h.Class('ui-checkbox-control'),
      h.Type('button'),
      h.Role('checkbox'),
      h.AriaChecked(isIndeterminate ? 'mixed' : config.isChecked),
      h.AriaRequired(config.isRequired === true),
      h.DataAttribute('state', state),
      h.Disabled(isDisabled),
      ...(isReadOnly
        ? [h.AriaReadonly(true), h.DataAttribute('readonly', '')]
        : []),
      ...(config.label === undefined
        ? []
        : [h.AriaLabelledBy(labelElementId(config.id))]),
      ...(config.ariaLabel === undefined || config.label !== undefined
        ? []
        : [h.AriaLabel(config.ariaLabel)]),
      ...(config.describedBy === undefined
        ? []
        : [h.AriaDescribedBy(config.describedBy)]),
      ...(isInteractive
        ? [h.OnClick(config.onToggle(toggled)), h.OnKeyDownPreventDefault(onKeyDown)]
        : [h.OnKeyDownPreventDefault(onKeyDown)]),
    ],
    [h.span([h.Class('ui-checkbox-indicator'), h.AriaHidden(true)])],
  )
  return h.div(
    [h.Class('ui-checkbox')],
    [
      control,
      ...(config.label === undefined
        ? []
        : [
            labelView(
              {
                htmlFor: config.id,
                id: labelElementId(config.id),
                text: config.label,
                isDisabled,
              },
              h,
            ),
          ]),
      ...(config.name === undefined || config.isChecked === false
        ? []
        : [
            h.input([
              h.Type('hidden'),
              h.Name(config.name),
              h.Value(config.value === undefined ? 'on' : config.value),
            ]),
          ]),
    ],
  )
}

const Model = Schema.Struct({
  accepted: Schema.Boolean,
  partial: Schema.Boolean,
  partialIndeterminate: Schema.Boolean,
  locked: Schema.Boolean,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ToggledAccepted: { isChecked: Schema.Boolean },
  ToggledPartial: { isChecked: Schema.Boolean },
})
type Message = typeof Message.Type

const init = (): Update.Return<Model, Message> => ({
  model: {
    accepted: false,
    partial: false,
    partialIndeterminate: true,
    locked: true,
  },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ToggledAccepted: ({ isChecked }) => ({
      model: modifyFields(model, { accepted: () => isChecked }),
    }),
    ToggledPartial: ({ isChecked }) => ({
      model: modifyFields(model, {
        partial: () => isChecked,
        partialIndeterminate: () => false,
      }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-checkbox-demo')],
    [
      view(
        {
          id: 'accept-terms',
          label: 'Accept terms',
          isChecked: model.accepted,
          name: 'terms',
          onToggle: isChecked => Message.ToggledAccepted({ isChecked }),
        },
        h,
      ),
      view(
        {
          id: 'partial-mail',
          label: 'Some mail',
          isChecked: model.partial,
          isIndeterminate: model.partialIndeterminate,
          onToggle: isChecked => Message.ToggledPartial({ isChecked }),
        },
        h,
      ),
      view(
        {
          id: 'locked-mail',
          label: 'Locked mail',
          isChecked: model.locked,
          isReadOnly: true,
          onToggle: isChecked => Message.ToggledAccepted({ isChecked }),
        },
        h,
      ),
      view(
        {
          id: 'disabled-mail',
          label: 'Disabled mail',
          isChecked: false,
          isDisabled: true,
          onToggle: isChecked => Message.ToggledAccepted({ isChecked }),
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
