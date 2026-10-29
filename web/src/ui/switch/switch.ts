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
import './switch.css'

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
  isRequired?: boolean
}>

const labelElementId = (id: string): string => `${id}-label`

export const view = <Message>(
  config: ViewConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const isDisabled = config.isDisabled === true
  const isReadOnly = config.isReadOnly === true
  const isInteractive = isDisabled === false && isReadOnly === false
  const toggled = config.isChecked === false
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
  return h.div(
    [h.Class('ui-switch')],
    [
      h.button(
        [
          h.Id(config.id),
          h.Class('ui-switch-control'),
          h.Type('button'),
          h.Role('switch'),
          h.AriaChecked(config.isChecked),
          h.AriaRequired(config.isRequired === true),
          h.DataAttribute('state', config.isChecked ? 'checked' : 'unchecked'),
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
            ? [
                h.OnClick(config.onToggle(toggled)),
                h.OnKeyDownPreventDefault(onKeyDown),
              ]
            : [h.OnKeyDownPreventDefault(onKeyDown)]),
        ],
        [h.span([h.Class('ui-switch-thumb'), h.AriaHidden(true)])],
      ),
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
  notifications: Schema.Boolean,
  locked: Schema.Boolean,
})
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ToggledNotifications: { isChecked: Schema.Boolean },
})
type Message = typeof Message.Type

const init = (): Update.Return<Model, Message> => ({
  model: { notifications: false, locked: true },
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ToggledNotifications: ({ isChecked }) => ({
      model: modifyFields(model, { notifications: () => isChecked }),
    }),
  })

const demoView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-switch-demo')],
    [
      view(
        {
          id: 'notifications',
          label: 'Notifications',
          isChecked: model.notifications,
          name: 'notifications',
          onToggle: isChecked => Message.ToggledNotifications({ isChecked }),
        },
        h,
      ),
      view(
        {
          id: 'locked-notifications',
          label: 'Locked notifications',
          isChecked: model.locked,
          isReadOnly: true,
          onToggle: isChecked => Message.ToggledNotifications({ isChecked }),
        },
        h,
      ),
      view(
        {
          id: 'disabled-notifications',
          label: 'Disabled notifications',
          isChecked: false,
          isDisabled: true,
          onToggle: isChecked => Message.ToggledNotifications({ isChecked }),
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
