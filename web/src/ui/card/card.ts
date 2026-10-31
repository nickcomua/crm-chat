import * as Schema from 'effect/Schema'
import * as Button from '@foldkit/ui/button'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import './card.css'

// MODEL
const DemoModel = Schema.Struct({
  noted: Schema.Boolean,
})
type DemoModel = typeof DemoModel.Type

// MESSAGE
const DemoMessage = defineMessageUnion({
  ClickedNote: {},
})
type DemoMessage = typeof DemoMessage.Type

export type ViewConfig = Readonly<{
  className?: string
  label?: string
}>

type ChildNode = Html | string

const classes = (base: string, extra: string | undefined): string => {
  if (extra === undefined || extra === '') {
    return base
  }
  return `${base} ${extra}`
}

const shellAttributes = <Message>(
  config: ViewConfig,
  className: string,
  h: HtmlBuilder<Message>,
) => {
  const named =
    config.label === undefined ? [] : [h.AriaLabel(config.label)]
  return [h.Class(classes(className, config.className)), ...named]
}

/** shadcn Card root. Stateless. Compose header, content, and footer inside. */
export const view = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.article(
    [...shellAttributes(config, 'ui-card', h), h.DataAttribute('slot', 'card')],
    children,
  )

export const header = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.header(
    [
      ...shellAttributes(config, 'ui-card-header', h),
      h.DataAttribute('slot', 'card-header'),
    ],
    children,
  )

export const title = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.h3(
    [
      ...shellAttributes(config, 'ui-card-title', h),
      h.DataAttribute('slot', 'card-title'),
    ],
    children,
  )

export const description = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.p(
    [
      ...shellAttributes(config, 'ui-card-description', h),
      h.DataAttribute('slot', 'card-description'),
    ],
    children,
  )

export const action = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      ...shellAttributes(config, 'ui-card-action', h),
      h.DataAttribute('slot', 'card-action'),
    ],
    children,
  )

export const content = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      ...shellAttributes(config, 'ui-card-content', h),
      h.DataAttribute('slot', 'card-content'),
    ],
    children,
  )

export const footer = <Message>(
  config: ViewConfig,
  children: ReadonlyArray<ChildNode>,
  h: HtmlBuilder<Message>,
): Html =>
  h.footer(
    [
      ...shellAttributes(config, 'ui-card-footer', h),
      h.DataAttribute('slot', 'card-footer'),
    ],
    children,
  )

// INIT
export const demoInit = (): { model: DemoModel } => ({
  model: { noted: false },
})

// UPDATE
export const demoUpdate = (model: DemoModel, message: DemoMessage) =>
  DemoMessage.match(message, {
    ClickedNote: () => ({
      model: modifyFields(model, { noted: () => true }),
    }),
  })

const demoBody = (model: DemoModel, h: HtmlBuilder<DemoMessage>): Html =>
  view(
    { label: 'Billing question' },
    [
      header(
        {},
        [
          title({}, ['Billing question'], h),
          description({}, ['Ada asked about invoice 1042.'], h),
          action(
            {},
            [
              Button.view(
                {
                  isDisabled: model.noted,
                  onClick: DemoMessage.ClickedNote(),
                  toView: attributes =>
                    h.button(
                      [...attributes.button, h.Class('ui-card-button')],
                      [model.noted ? 'Noted' : 'Note'],
                    ),
                },
                h,
              ),
            ],
            h,
          ),
        ],
        h,
      ),
      content({}, ['Opened from the saved chat.'], h),
      footer({}, [model.noted ? 'Noted' : 'New'], h),
    ],
    h,
  )

/** Static gallery snapshot of the card demo. Mount demoInit/demoUpdate/demoView to click it. */
export const demo = (h: HtmlBuilder<DemoMessage>): Html =>
  demoBody(demoInit().model, h)

export const demoView = demoBody
