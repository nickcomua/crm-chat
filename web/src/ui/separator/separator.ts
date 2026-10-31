import './separator.css'

import type { Html, HtmlBuilder } from 'foldkit/html'

export type SeparatorOrientation = 'horizontal' | 'vertical'

export type SeparatorConfig = {
  readonly orientation?: SeparatorOrientation
  readonly isDecorative?: boolean
}

export const view = <Message>(
  config: SeparatorConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const orientation = config.orientation ?? 'horizontal'
  const isDecorative = config.isDecorative ?? true
  const semantics = isDecorative
    ? [h.Role('none'), h.AriaHidden(true)]
    : [h.Role('separator'), h.AriaOrientation(orientation)]
  return h.div([
    h.Class('ui-separator'),
    h.DataAttribute('orientation', orientation),
    ...semantics,
  ])
}

export const demo = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-separator-demo')],
    [
      h.span([], ['Chats']),
      view({ orientation: 'horizontal', isDecorative: true }, h),
      h.div(
        [h.Class('ui-separator-row')],
        [
          h.span([], ['All']),
          view({ orientation: 'vertical', isDecorative: false }, h),
          h.span([], ['Unread']),
        ],
      ),
    ],
  )
