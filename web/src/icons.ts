import { HtmlBuilder } from 'foldkit/html'

const strokeIcon = <Message>(h: HtmlBuilder<Message>, d: string) =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Fill('none'),
      h.Stroke('currentColor'),
      h.StrokeWidth('1.8'),
      h.StrokeLinecap('round'),
      h.StrokeLinejoin('round'),
      h.AriaHidden(true),
      h.Class('size-5'),
    ],
    [h.path([h.D(d)])],
  )

export const searchIcon = <Message>(h: HtmlBuilder<Message>) =>
  strokeIcon(
    h,
    'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16.2 16.2 21 21',
  )

export const phoneIcon = <Message>(h: HtmlBuilder<Message>) =>
  strokeIcon(
    h,
    'M7.5 3.8h2.2l1.1 2.8-1.5 1a11 11 0 0 0 5.1 5.1l1-1.5 2.8 1.1v2.2a1.7 1.7 0 0 1-1.8 1.7A14.2 14.2 0 0 1 5.8 5.6a1.7 1.7 0 0 1 1.7-1.8z',
  )

export const emojiIcon = <Message>(h: HtmlBuilder<Message>) =>
  strokeIcon(
    h,
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 10.2h.01M15.5 10.2h.01M8.2 14.2a4.2 4.2 0 0 0 7.6 0',
  )

export const attachIcon = <Message>(h: HtmlBuilder<Message>) =>
  strokeIcon(
    h,
    'M15.5 7.2 9.2 13.5a2.6 2.6 0 0 1-3.7-3.7l6.4-6.4a4 4 0 0 1 5.7 5.7l-6.6 6.6a5.4 5.4 0 0 1-7.6-7.6L10 1.5',
  )

export const voiceIcon = <Message>(h: HtmlBuilder<Message>) =>
  strokeIcon(
    h,
    'M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5v3',
  )

export const sendIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Fill('currentColor'),
      h.AriaHidden(true),
      h.Class('size-5'),
    ],
    [
      h.path([
        h.D('M3.2 11.2 20.4 3.6c.8-.4 1.6.5 1.2 1.3l-3.2 14.2c-.3 1.1-1.6 1.5-2.5.8l-4.4-3.2-2.4 2.3c-.5.5-1.4.2-1.5-.5l-.4-3.4 8.6-7.8-10.6 6.6-3.6-1.2c-1-.4-1-1.8.1-2.1z'),
      ]),
    ],
  )

export const moreIcon = <Message>(h: HtmlBuilder<Message>) =>
  h.svg(
    [
      h.ViewBox('0 0 24 24'),
      h.Fill('currentColor'),
      h.AriaHidden(true),
      h.Class('size-5'),
    ],
    [
      h.circle([h.Cx('12'), h.Cy('5.5'), h.R('1.4')]),
      h.circle([h.Cx('12'), h.Cy('12'), h.R('1.4')]),
      h.circle([h.Cx('12'), h.Cy('18.5'), h.R('1.4')]),
    ],
  )
