import './spinner.css'

import type { Html, HtmlBuilder } from 'foldkit/html'

export type SpinnerConfig = {
  readonly label?: string
  readonly isDecorative?: boolean
}

const graphic = <Message>(h: HtmlBuilder<Message>): Html =>
  h.svg(
    [
      h.Class('ui-spinner-graphic'),
      h.ViewBox('0 0 24 24'),
      h.Width('1em'),
      h.Height('1em'),
      h.Fill('none'),
      h.AriaHidden(true),
    ],
    [
      h.circle([
        h.Cx('12'),
        h.Cy('12'),
        h.R('9'),
        h.Stroke('currentColor'),
        h.StrokeWidth('3'),
        h.StrokeLinecap('round'),
        h.StrokeDasharray('40 16'),
      ]),
    ],
  )

export const view = <Message>(
  config: SpinnerConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const isDecorative = config.isDecorative ?? false
  if (isDecorative) {
    return h.span([h.Class('ui-spinner'), h.AriaHidden(true)], [graphic(h)])
  }
  const label = config.label ?? 'Loading'
  return h.span(
    [
      h.Class('ui-spinner'),
      h.Role('status'),
      h.AriaLive('polite'),
      h.AriaLabel(label),
    ],
    [graphic(h)],
  )
}

export const demo = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-spinner-demo')],
    [
      view({}, h),
      view({ label: 'Sending' }, h),
      view({ isDecorative: true }, h),
    ],
  )
