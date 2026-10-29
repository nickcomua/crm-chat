import './badge.css'

import type { Html, HtmlBuilder } from 'foldkit/html'

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

export type BadgeConfig = {
  readonly label: string
  readonly variant?: BadgeVariant
  readonly name?: string
  readonly isLive?: boolean
}

export const view = <Message>(
  config: BadgeConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const variant = config.variant ?? 'default'
  const isLive = config.isLive ?? false
  const liveAttributes = isLive
    ? [h.Role('status'), h.AriaLive('polite')]
    : []
  const nameAttributes =
    config.name === undefined ? [] : [h.AriaLabel(config.name)]
  return h.span(
    [
      h.Class('ui-badge'),
      h.DataAttribute('variant', variant),
      ...liveAttributes,
      ...nameAttributes,
    ],
    [config.label],
  )
}

export const demo = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-badge-demo')],
    [
      view({ label: 'Online', variant: 'default' }, h),
      view({ label: 'Muted', variant: 'secondary' }, h),
      view({ label: 'Failed', variant: 'destructive' }, h),
      view({ label: 'Draft', variant: 'outline' }, h),
      view(
        { label: '3', name: '3 unread', variant: 'default', isLive: true },
        h,
      ),
    ],
  )
