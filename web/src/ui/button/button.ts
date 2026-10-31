import './button.css'

import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { Update } from 'foldkit'
import type { Html, HtmlBuilder, KeyboardModifiers } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { view as spinnerView } from '../spinner/spinner'

export type ButtonVariant =
  | 'default'
  | 'secondary'
  | 'ghost'
  | 'destructive'
  | 'link'

export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon'

export type ButtonType = 'button' | 'submit' | 'reset'

export type ButtonConfig<Message> = {
  readonly label: string
  readonly onPress: Message
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly buttonType?: ButtonType
  readonly isDisabled?: boolean
  readonly isLoading?: boolean
  readonly icon?: (h: HtmlBuilder<Message>) => Html
}

const activationMessage = <Message>(
  onPress: Message,
  key: string,
  modifiers: KeyboardModifiers,
): Option.Option<Message> => {
  if (modifiers.ctrlKey || modifiers.altKey || modifiers.metaKey) {
    return Option.none()
  }
  if (key === 'Enter' || key === ' ') {
    return Option.some(onPress)
  }
  return Option.none()
}

const graphicChildren = <Message>(
  config: ButtonConfig<Message>,
  isLoading: boolean,
  size: ButtonSize,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> => {
  if (isLoading) {
    return [spinnerView({ isDecorative: true }, h)]
  }
  const drawn = config.icon?.(h)
  if (drawn !== undefined && drawn !== null) {
    return [
      h.span([h.Class('ui-button-graphic'), h.AriaHidden(true)], [drawn]),
    ]
  }
  if (size === 'icon') {
    const mark = Array.from(config.label)[0] ?? '•'
    return [h.span([h.Class('ui-button-graphic'), h.AriaHidden(true)], [mark])]
  }
  return []
}

export const view = <Message>(
  config: ButtonConfig<Message>,
  h: HtmlBuilder<Message>,
): Html => {
  const variant = config.variant ?? 'default'
  const size = config.size ?? 'default'
  const buttonType = config.buttonType ?? 'button'
  const isLoading = config.isLoading ?? false
  const isDisabled = config.isDisabled ?? false
  const isInactive = isDisabled || isLoading
  const nameAttributes = size === 'icon' ? [h.AriaLabel(config.label)] : []
  const labelChildren =
    size === 'icon'
      ? []
      : [h.span([h.Class('ui-button-label')], [config.label])]
  const activation =
    isInactive || buttonType !== 'button'
      ? []
      : [
          h.OnClick(config.onPress),
          h.OnKeyDownPreventDefault((key, modifiers) =>
            activationMessage(config.onPress, key, modifiers),
          ),
        ]
  const clickOnly =
    isInactive || buttonType === 'button' ? [] : [h.OnClick(config.onPress)]
  return h.button(
    [
      h.Class('ui-button'),
      h.Type(buttonType),
      h.DataAttribute('variant', variant),
      h.DataAttribute('size', size),
      h.DataAttribute('loading', isLoading ? 'true' : 'false'),
      ...nameAttributes,
      ...(isLoading ? [h.AriaBusy(true)] : []),
      ...(isInactive ? [h.AriaDisabled(true)] : []),
      ...(isDisabled ? [h.Disabled(true)] : []),
      ...activation,
      ...clickOnly,
    ],
    [...graphicChildren(config, isLoading, size, h), ...labelChildren],
  )
}

export const DemoModel = Schema.Struct({
  presses: Schema.Number,
  last: Schema.String,
  publish: Schema.Literals(['Idle', 'Loading']),
})
export type DemoModel = typeof DemoModel.Type

export const DemoMessage = defineMessageUnion({
  Pressed: { name: Schema.String },
})
export type DemoMessage = typeof DemoMessage.Type

export const initialDemoModel: DemoModel = {
  presses: 0,
  last: 'idle',
  publish: 'Idle',
}

export const demoInit = (): { readonly model: DemoModel } => ({
  model: initialDemoModel,
})

export const demoUpdate = (model: DemoModel, message: DemoMessage) =>
  DemoMessage.match<Update.Return<DemoModel, DemoMessage>>(message, {
    Pressed: ({ name }) => ({
      model: modifyFields(model, {
        presses: presses => presses + 1,
        last: () => name,
        publish: publish => (name === 'Publish' ? 'Loading' : publish),
      }),
    }),
  })

const closeIcon = (h: HtmlBuilder<DemoMessage>): Html =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Width('1.1em'),
      h.Height('1.1em'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('2'),
      h.StrokeLinecap('round'),
      h.AriaHidden(true),
    ],
    [
      h.path([h.D('M6 6 L18 18'), h.Stroke('currentColor')]),
      h.path([h.D('M18 6 L6 18'), h.Stroke('currentColor')]),
    ],
  )

const press = (name: string): DemoMessage => DemoMessage.Pressed({ name })

export const demo = (model: DemoModel, h: HtmlBuilder<DemoMessage>): Html =>
  h.div(
    [h.Class('ui-button-demo')],
    [
      view({ label: 'Save', onPress: press('Save') }, h),
      view(
        { label: 'Archive', onPress: press('Archive'), variant: 'secondary' },
        h,
      ),
      view({ label: 'More', onPress: press('More'), variant: 'ghost' }, h),
      view(
        {
          label: 'Delete',
          onPress: press('Delete'),
          variant: 'destructive',
        },
        h,
      ),
      view(
        { label: 'Learn more', onPress: press('Learn more'), variant: 'link' },
        h,
      ),
      view({ label: 'Pin', onPress: press('Pin'), size: 'sm' }, h),
      view({ label: 'Send', onPress: press('Send'), size: 'lg' }, h),
      view(
        {
          label: 'Close',
          onPress: press('Close'),
          size: 'icon',
          icon: closeIcon,
        },
        h,
      ),
      view({ label: 'Mute', onPress: press('Mute'), isDisabled: true }, h),
      view(
        { label: 'Publishing', onPress: press('Publishing'), isLoading: true },
        h,
      ),
      view(
        {
          label: 'Publish',
          onPress: press('Publish'),
          isLoading: model.publish === 'Loading',
        },
        h,
      ),
      view(
        {
          label: 'Post',
          onPress: press('Post'),
          buttonType: 'submit',
        },
        h,
      ),
      h.span(
        [h.Role('status'), h.AriaLive('polite')],
        [`${model.last}:${model.presses}`],
      ),
    ],
  )
