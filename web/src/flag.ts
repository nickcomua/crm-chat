import { HtmlBuilder } from 'foldkit/html'

import { type Country, type FlagMark } from './countries'

const band = <Message>(
  h: HtmlBuilder<Message>,
  axis: 'x' | 'y',
  index: number,
  count: number,
  color: string,
) => {
  if (axis === 'x') {
    const width = 20 / count
    return h.rect([
      h.X(String(index * width)),
      h.Y('0'),
      h.Width(String(width)),
      h.Height('14'),
      h.Fill(color),
    ])
  }
  const height = 14 / count
  return h.rect([
    h.X('0'),
    h.Y(String(index * height)),
    h.Width('20'),
    h.Height(String(height)),
    h.Fill(color),
  ])
}

const nordic = <Message>(
  h: HtmlBuilder<Message>,
  mark: Extract<FlagMark, { kind: 'nordic' }>,
) => {
  const cross = [
    h.rect([
      h.X('6'),
      h.Y('0'),
      h.Width('3'),
      h.Height('14'),
      h.Fill(mark.cross),
    ]),
    h.rect([
      h.X('0'),
      h.Y('5.5'),
      h.Width('20'),
      h.Height('3'),
      h.Fill(mark.cross),
    ]),
  ]
  if (mark.outline === undefined) {
    return [
      h.rect([h.Width('20'), h.Height('14'), h.Fill(mark.field)]),
      ...cross,
    ]
  }
  return [
    h.rect([h.Width('20'), h.Height('14'), h.Fill(mark.field)]),
    h.rect([
      h.X('5'),
      h.Y('0'),
      h.Width('5'),
      h.Height('14'),
      h.Fill(mark.outline),
    ]),
    h.rect([
      h.X('0'),
      h.Y('4.5'),
      h.Width('20'),
      h.Height('5'),
      h.Fill(mark.outline),
    ]),
    ...cross,
  ]
}

const stripes = <Message>(
  h: HtmlBuilder<Message>,
  mark: Extract<FlagMark, { kind: 'canton' }>,
) => [
  ...[0, 1, 2, 3, 4, 5, 6].map(index =>
    h.rect([
      h.X('0'),
      h.Y(String(index * 2)),
      h.Width('20'),
      h.Height('2'),
      h.Fill(index % 2 === 0 ? mark.stripe : mark.gap),
    ]),
  ),
  h.rect([
    h.X('0'),
    h.Y('0'),
    h.Width('8'),
    h.Height('7'),
    h.Fill(mark.canton),
  ]),
]

const draw = <Message>(h: HtmlBuilder<Message>, mark: FlagMark) => {
  if (mark.kind === 'bands') {
    return mark.colors.map((color, index) =>
      band(h, mark.axis, index, mark.colors.length, color),
    )
  }
  if (mark.kind === 'cross') {
    return [
      h.rect([h.Width('20'), h.Height('14'), h.Fill(mark.field)]),
      h.rect([
        h.X('8'),
        h.Y('0'),
        h.Width('4'),
        h.Height('14'),
        h.Fill(mark.cross),
      ]),
      h.rect([
        h.X('0'),
        h.Y('5'),
        h.Width('20'),
        h.Height('4'),
        h.Fill(mark.cross),
      ]),
    ]
  }
  if (mark.kind === 'nordic') {
    return nordic(h, mark)
  }
  if (mark.kind === 'disc') {
    return [
      h.rect([h.Width('20'), h.Height('14'), h.Fill(mark.field)]),
      h.circle([h.Cx('10'), h.Cy('7'), h.R('3.4'), h.Fill(mark.disc)]),
    ]
  }
  if (mark.kind === 'canton') {
    return stripes(h, mark)
  }
  return [
    h.rect([h.Width('20'), h.Height('14'), h.Fill('#012169')]),
    h.path([
      h.D('M0 0 L20 14 M20 0 L0 14'),
      h.Stroke('#FFFFFF'),
      h.StrokeWidth('2.4'),
    ]),
    h.path([
      h.D('M0 0 L20 14 M20 0 L0 14'),
      h.Stroke('#C8102E'),
      h.StrokeWidth('1.2'),
    ]),
    h.rect([
      h.X('8.4'),
      h.Y('0'),
      h.Width('3.2'),
      h.Height('14'),
      h.Fill('#FFFFFF'),
    ]),
    h.rect([
      h.X('0'),
      h.Y('5.4'),
      h.Width('20'),
      h.Height('3.2'),
      h.Fill('#FFFFFF'),
    ]),
    h.rect([
      h.X('9.1'),
      h.Y('0'),
      h.Width('1.8'),
      h.Height('14'),
      h.Fill('#C8102E'),
    ]),
    h.rect([
      h.X('0'),
      h.Y('6.1'),
      h.Width('20'),
      h.Height('1.8'),
      h.Fill('#C8102E'),
    ]),
  ]
}

export const countryFlag = <Message>(
  h: HtmlBuilder<Message>,
  country: Country,
) =>
  h.svg(
    [
      h.ViewBox('0 0 20 14'),
      h.Class('h-3.5 w-5 shrink-0 overflow-hidden rounded-[2px]'),
      h.AriaHidden(true),
    ],
    draw(h, country.flag),
  )
