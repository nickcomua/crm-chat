import * as Array from 'effect/Array'
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
import './radioGroup.css'

export const Orientation = Schema.Literals(['Horizontal', 'Vertical'])
export type Orientation = typeof Orientation.Type

export type RadioOption = Readonly<{
  value: string
  label: string
  description: Option.Option<string>
  isDisabled: boolean
}>

export const Model = Schema.Struct({
  id: Schema.String,
  selectedValue: Schema.Option(Schema.String),
  maybeFocusedIndex: Schema.Option(Schema.Number),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SelectedOption: { index: Schema.Number, value: Schema.String },
  FocusedOption: { index: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Selected: { value: Schema.String, index: Schema.Number },
})
export type OutMessage = typeof OutMessage.Type

export type ViewInputs = Readonly<{
  options: ReadonlyArray<RadioOption>
  ariaLabel: string
  orientation: Orientation
  isDisabled: boolean
  isReadOnly: boolean
  name: Option.Option<string>
}>

export const init = (config: Readonly<{ id: string }>): Model => ({
  id: config.id,
  selectedValue: Option.none(),
  maybeFocusedIndex: Option.none(),
})

const optionElementId = (id: string, index: number): string =>
  `${id}-option-${index}`

const optionLabelId = (id: string, index: number): string =>
  `${id}-option-${index}-label`

const optionDescriptionId = (id: string, index: number): string =>
  `${id}-option-${index}-description`

const wrapIndex = (index: number, length: number): number =>
  ((index % length) + length) % length

export const update = (model: Model, message: Message) =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage>>(
    message,
    {
      SelectedOption: ({ index, value }) => ({
        model: modifyFields(model, {
          selectedValue: () => Option.some(value),
          maybeFocusedIndex: () => Option.none(),
        }),
        outMessage: OutMessage.Selected({ value, index }),
      }),
      FocusedOption: ({ index }) => ({
        model: modifyFields(model, {
          maybeFocusedIndex: () => Option.some(index),
        }),
      }),
    },
  )

const orientationName = (orientation: Orientation): string => {
  if (orientation === 'Horizontal') {
    return 'horizontal'
  }
  return 'vertical'
}

export const view = (
  model: Model,
  inputs: ViewInputs,
  h: HtmlBuilder<Message>,
): Html => {
  const isEnabledIndex = (index: number): boolean =>
    inputs.isDisabled === false &&
    Option.match(Array.get(inputs.options, index), {
      onNone: () => false,
      onSome: option => option.isDisabled === false,
    })
  const selectedIndex = model.selectedValue.pipe(
    Option.flatMap(value =>
      Array.findFirstIndex(inputs.options, option => option.value === value),
    ),
  )
  const selectionTabStop = selectedIndex.pipe(
    Option.filter(isEnabledIndex),
    Option.orElse(() =>
      Array.findFirstIndex(inputs.options, (_option, index) =>
        isEnabledIndex(index),
      ),
    ),
    Option.getOrElse(() => 0),
  )
  const focusedIndex = model.maybeFocusedIndex.pipe(
    Option.filter(isEnabledIndex),
    Option.getOrElse(() => selectionTabStop),
  )
  const findEnabled = (
    start: number,
    direction: 1 | -1,
  ): Option.Option<number> => {
    if (Array.isArrayEmpty(inputs.options)) {
      return Option.none()
    }
    const candidates = Array.makeBy(inputs.options.length, step =>
      wrapIndex(start + step * direction, inputs.options.length),
    )
    return Array.findFirst(candidates, isEnabledIndex)
  }
  const navigationTarget = (
    index: number,
    key: string,
  ): Option.Option<number> => {
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      return findEnabled(index + 1, 1)
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      return findEnabled(index - 1, -1)
    }
    if (key === 'Home' || key === 'PageUp') {
      return findEnabled(0, 1)
    }
    if (key === 'End' || key === 'PageDown') {
      return findEnabled(inputs.options.length - 1, -1)
    }
    return Option.none()
  }
  const activation = (index: number) =>
    Array.get(inputs.options, index).pipe(
      Option.filter(
        option => option.isDisabled === false && inputs.isDisabled === false,
      ),
      Option.map(option => ({
        focusSelector: `#${optionElementId(model.id, index)}`,
        message: Message.SelectedOption({ index, value: option.value }),
      })),
    )
  const handleKeyDown =
    (index: number) =>
    (key: string, _modifiers: KeyboardModifiers) => {
      if (key === ' ') {
        if (inputs.isReadOnly) {
          return Option.none()
        }
        return activation(index)
      }
      const maybeNext = navigationTarget(index, key)
      if (Option.isNone(maybeNext)) {
        return Option.none()
      }
      if (inputs.isReadOnly) {
        return Option.some({
          focusSelector: `#${optionElementId(model.id, maybeNext.value)}`,
          message: Message.FocusedOption({ index: maybeNext.value }),
        })
      }
      return activation(maybeNext.value)
    }
  const direction = orientationName(inputs.orientation)
  const options = Array.map(inputs.options, (option, index) => {
    const isEnabled = isEnabledIndex(index)
    const isSelected = Option.match(model.selectedValue, {
      onNone: () => false,
      onSome: value => value === option.value,
    })
    return h.keyed('div')(
      option.value,
      [h.Class('ui-radio')],
      [
        h.button(
          [
            h.Id(optionElementId(model.id, index)),
            h.Class('ui-radio-control'),
            h.Type('button'),
            h.Role('radio'),
            h.AriaChecked(isSelected),
            h.AriaLabelledBy(optionLabelId(model.id, index)),
            h.Tabindex(isEnabled && index === focusedIndex ? 0 : -1),
            h.DataAttribute('state', isSelected ? 'checked' : 'unchecked'),
            h.Disabled(isEnabled === false),
            ...(index === focusedIndex
              ? [h.DataAttribute('active', '')]
              : []),
            ...(inputs.isReadOnly
              ? [h.DataAttribute('readonly', '')]
              : []),
            ...(Option.isSome(option.description)
              ? [h.AriaDescribedBy(optionDescriptionId(model.id, index))]
              : []),
            ...(isEnabled && inputs.isReadOnly === false
              ? [h.OnClick(Message.SelectedOption({ index, value: option.value }))]
              : []),
            ...(isEnabled
              ? [h.OnKeyDownFocus(handleKeyDown(index))]
              : []),
          ],
          [h.span([h.Class('ui-radio-indicator'), h.AriaHidden(true)])],
        ),
        h.div(
          [h.Class('ui-radio-copy')],
          [
            labelView(
              {
                htmlFor: optionElementId(model.id, index),
                id: optionLabelId(model.id, index),
                text: option.label,
                isDisabled: isEnabled === false,
              },
              h,
            ),
            Option.match(option.description, {
              onNone: () => h.empty,
              onSome: text =>
                h.p(
                  [
                    h.Id(optionDescriptionId(model.id, index)),
                    h.Class('ui-radio-description'),
                  ],
                  [text],
                ),
            }),
          ],
        ),
      ],
    )
  })
  const hidden = model.selectedValue.pipe(
    Option.flatMap(value =>
      inputs.name.pipe(
        Option.map(name =>
          h.input([h.Type('hidden'), h.Name(name), h.Value(value)]),
        ),
      ),
    ),
    Option.getOrElse(() => h.empty),
  )
  return h.div(
    [
      h.Id(model.id),
      h.Class('ui-radio-group'),
      h.Role('radiogroup'),
      h.AriaLabel(inputs.ariaLabel),
      h.AriaOrientation(direction),
      h.DataAttribute('orientation', direction),
      ...(inputs.isDisabled
        ? [h.AriaDisabled(true), h.DataAttribute('disabled', '')]
        : []),
      ...(inputs.isReadOnly
        ? [h.AriaReadonly(true), h.DataAttribute('readonly', '')]
        : []),
    ],
    Array.append(options, hidden),
  )
}

const demoOptions: ReadonlyArray<RadioOption> = [
  {
    value: 'light',
    label: 'Light',
    description: Option.some('Bright background'),
    isDisabled: false,
  },
  {
    value: 'system',
    label: 'System',
    description: Option.some('Follows the device'),
    isDisabled: true,
  },
  {
    value: 'dark',
    label: 'Dark',
    description: Option.none(),
    isDisabled: false,
  },
]

export type DemoConfig = Readonly<{
  orientation: Orientation
  isDisabled: boolean
  isReadOnly: boolean
}>

const defaultDemoConfig: DemoConfig = {
  orientation: 'Vertical',
  isDisabled: false,
  isReadOnly: false,
}

const inputsFor = (config: DemoConfig): ViewInputs => ({
  options: demoOptions,
  ariaLabel: 'Theme',
  orientation: config.orientation,
  isDisabled: config.isDisabled,
  isReadOnly: config.isReadOnly,
  name: Option.some('theme'),
})

export const demo = (config: DemoConfig = defaultDemoConfig) => ({
  init: () => ({ model: init({ id: 'ui-radio-demo' }) }),
  update,
  view: (model: Model, h: HtmlBuilder<Message>) =>
    h.div([h.Class('ui-radio-demo')], [view(model, inputsFor(config), h)]),
})
