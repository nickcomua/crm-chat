import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ChatKind } from './generated/core'

export const ChatLine = Schema.Struct({
  text: Schema.String,
  mine: Schema.Boolean,
  time: Schema.String,
  caption: Schema.optional(Schema.String),
})
export type ChatLine = typeof ChatLine.Type

export const StoredFace = Schema.Struct({
  id: Schema.String,
  time: Schema.String,
  preview: Schema.String,
  unread: Schema.Number,
  receipt: Schema.Literals(['none', 'sent', 'read']),
  lines: Schema.Array(ChatLine),
})
export type StoredFace = typeof StoredFace.Type

export type ChatFace = {
  readonly time: string
  readonly preview: string
  readonly unread: number
  readonly receipt: 'none' | 'sent' | 'read'
  readonly lines: ReadonlyArray<ChatLine>
}

export const emptyFace: ChatFace = {
  time: '',
  preview: '',
  unread: 0,
  receipt: 'none',
  lines: [],
}

export const faceFor = (
  faces: ReadonlyArray<StoredFace>,
  id: string,
): ChatFace =>
  Option.match(
    Array.findFirst(faces, face => face.id === id),
    {
      onNone: () => emptyFace,
      onSome: face => face,
    },
  )

export const markFor = (title: string): string =>
  title.slice(0, 1).toUpperCase()

export const tintFor = (kind: ChatKind): string => {
  if (kind === 'Group') {
    return 'bg-[#3e9e6a]'
  }
  if (kind === 'Channel') {
    return 'bg-[#c47a2c]'
  }
  return 'bg-[#5288c1]'
}

export const kindStatus: Record<ChatKind, string> = {
  Dialog: 'personal chat',
  Group: 'group',
  Channel: 'channel',
}
