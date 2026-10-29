import './avatar.css'

import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { Update } from 'foldkit'
import type { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

// NOTE: Order is Telegram Web K's seven peer colors. Numeric ids use abs(id) % 7.
const avatarPalette: ReadonlyArray<string> = [
  '#e17076',
  '#faa774',
  '#a695e7',
  '#7bc862',
  '#6ec9cb',
  '#65aadd',
  '#ee7aae',
]

const fallbackColor = '#e17076'

const colorIndex = (seed: string): number => {
  if (/^-?\d+$/u.test(seed)) {
    const digits = seed.startsWith('-') ? seed.slice(1) : seed
    return Number(BigInt(digits) % BigInt(avatarPalette.length))
  }
  const sum = Array.from(seed).reduce(
    (total, character) => total + (character.codePointAt(0) ?? 0),
    0,
  )
  return sum % avatarPalette.length
}

export const avatarColor = (seed: string): string => {
  const color = avatarPalette[colorIndex(seed)]
  if (color === undefined) {
    return fallbackColor
  }
  return color
}

export const initials = (name: string): string => {
  const trimmed = name.trim()
  if (trimmed === '') {
    return '?'
  }
  const words = trimmed.split(/\s+/u)
  const first = words[0]
  if (first === undefined) {
    return '?'
  }
  const firstChar = Array.from(first)[0]
  if (firstChar === undefined) {
    return '?'
  }
  const second = words[1]
  if (second === undefined) {
    return firstChar.toUpperCase()
  }
  const secondChar = Array.from(second)[0]
  if (secondChar === undefined) {
    return firstChar.toUpperCase()
  }
  return `${firstChar}${secondChar}`.toUpperCase()
}

const Image = defineTaggedUnion({
  Pending: { source: Schema.String },
  Failed: { source: Schema.String },
})

export const Model = Schema.Struct({
  image: Image,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  FailedLoadImage: { source: Schema.String },
})
export type Message = typeof Message.Type

export const init = (source: string): { readonly model: Model } => ({
  model: { image: Image.Pending({ source }) },
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    FailedLoadImage: ({ source }) => ({
      model: modifyFields(model, {
        image: () => Image.Failed({ source }),
      }),
    }),
  })

export type AvatarSize = 'sm' | 'default' | 'lg'

export type AvatarConfig = {
  readonly name: string
  readonly peerId: string
  readonly source: Option.Option<string>
  readonly size?: AvatarSize
}

const fallbackView = (
  config: AvatarConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const size = config.size ?? 'default'
  return h.span(
    [h.Class('ui-avatar'), h.DataAttribute('size', size)],
    [
      h.span(
        [
          h.Class('ui-avatar-fallback'),
          h.Role('img'),
          h.AriaLabel(config.name),
          h.Style({ backgroundColor: avatarColor(config.peerId) }),
        ],
        [h.span([h.AriaHidden(true)], [initials(config.name)])],
      ),
    ],
  )
}

const photoView = (
  config: AvatarConfig,
  source: string,
  h: HtmlBuilder<Message>,
): Html => {
  const size = config.size ?? 'default'
  return h.span(
    [h.Class('ui-avatar'), h.DataAttribute('size', size)],
    [
      h.img([
        h.Class('ui-avatar-image'),
        h.Src(source),
        h.Alt(config.name),
        h.OnError(Message.FailedLoadImage({ source })),
      ]),
    ],
  )
}

export const view = (
  model: Model,
  config: AvatarConfig,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(config.source, {
    onNone: () => fallbackView(config, h),
    onSome: source =>
      Image.match(model.image, {
        Pending: () => photoView(config, source, h),
        Failed: failed =>
          failed.source === source
            ? fallbackView(config, h)
            : photoView(config, source, h),
      }),
  })

const demoSource = 'https://example.invalid/nick.png'

export const demoInit = (): { readonly model: Model } => init(demoSource)

export const demoUpdate = update

export const demo = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-avatar-demo')],
    [
      view(
        model,
        {
          name: 'Nick Korniichuk',
          peerId: '42',
          source: Option.some(demoSource),
          size: 'lg',
        },
        h,
      ),
      view(
        model,
        {
          name: 'Ada Lovelace',
          peerId: 'Ada Lovelace',
          source: Option.none(),
          size: 'default',
        },
        h,
      ),
      view(
        model,
        {
          name: 'Book club',
          peerId: '3',
          source: Option.none(),
          size: 'sm',
        },
        h,
      ),
    ],
  )
