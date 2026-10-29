import './skeleton.css'

import type { Html, HtmlBuilder } from 'foldkit/html'

export type SkeletonShape = 'text' | 'circle'

export type SkeletonConfig = {
  readonly label?: string
  readonly width?: string
  readonly height?: string
  readonly shape?: SkeletonShape
}

export const view = <Message>(
  config: SkeletonConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const width = config.width ?? '100%'
  const height = config.height ?? '1rem'
  const shape = config.shape ?? 'text'
  const label = config.label
  const semantics =
    label === undefined
      ? [h.AriaHidden(true)]
      : [h.Role('status'), h.AriaBusy(true), h.AriaLabel(label)]
  return h.div([
    h.Class('ui-skeleton'),
    h.DataAttribute('shape', shape),
    h.Style({ width, height }),
    ...semantics,
  ])
}

export const demo = <Message>(h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class('ui-skeleton-demo'),
      h.Role('region'),
      h.AriaLabel('Loading chats'),
      h.AriaBusy(true),
    ],
    [
      view({ shape: 'circle', width: '2.5rem', height: '2.5rem' }, h),
      view({ width: '60%', height: '0.875rem' }, h),
      view({ label: 'Loading messages', width: '100%', height: '3rem' }, h),
    ],
  )
