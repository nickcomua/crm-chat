import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { ChatKind } from './generated/core'

export const ChatLine = Schema.Struct({
  id: Schema.optional(Schema.String),
  text: Schema.String,
  mine: Schema.Boolean,
  time: Schema.String,
  caption: Schema.optional(Schema.String),
})
export type ChatLine = typeof ChatLine.Type

export const SponsoredLine = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  title: Schema.String,
  button: Schema.String,
  recommended: Schema.Boolean,
  info: Schema.String,
})
export type SponsoredLine = typeof SponsoredLine.Type

export const StoredFace = Schema.Struct({
  id: Schema.String,
  time: Schema.String,
  preview: Schema.String,
  unread: Schema.Number,
  receipt: Schema.Literals(['none', 'sent', 'read']),
  lines: Schema.Array(ChatLine),
  pending: Schema.optional(Schema.Array(ChatLine)),
  sponsored: Schema.optional(Schema.Array(SponsoredLine)),
  sponsoredBetween: Schema.optional(Schema.Number),
  historyLoaded: Schema.optional(Schema.Boolean),
  sponsoredLoaded: Schema.optional(Schema.Boolean),
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

export type ThreadEntry =
  | { readonly kind: 'message'; readonly key: string; readonly line: ChatLine }
  | {
      readonly kind: 'sponsored'
      readonly key: string
      readonly line: SponsoredLine
    }

const messageEntry = (line: ChatLine, index: number): ThreadEntry => ({
  kind: 'message',
  key: line.id === undefined ? `line-${index}` : `line-${line.id}`,
  line,
})

// messages_between of 0 means one ad after the ordinary messages.
// A positive gap inserts the next ad after each full group, and still
// shows one ad when the history is shorter than that gap.
export const threadEntries = (
  lines: ReadonlyArray<ChatLine>,
  pending: ReadonlyArray<ChatLine>,
  sponsored: ReadonlyArray<SponsoredLine>,
  between: number,
): ReadonlyArray<ThreadEntry> => {
  const messages = [...lines, ...pending].map(messageEntry)
  const ads = sponsored.filter(ad => ad.title !== '' || ad.text !== '')
  const first = ads[0]
  if (first === undefined) {
    return messages
  }
  if (between <= 0) {
    return [
      ...messages,
      { kind: 'sponsored', key: `ad-${first.id}`, line: first },
    ]
  }
  const entries: Array<ThreadEntry> = []
  let adIndex = 0
  messages.forEach((entry, index) => {
    entries.push(entry)
    if ((index + 1) % between !== 0) {
      return
    }
    const ad = ads[adIndex]
    if (ad === undefined) {
      return
    }
    entries.push({
      kind: 'sponsored',
      key: `ad-${ad.id}-${index}`,
      line: ad,
    })
    adIndex += 1
  })
  if (adIndex === 0) {
    entries.push({ kind: 'sponsored', key: `ad-${first.id}`, line: first })
  }
  return entries
}

export const appendLines = (
  current: ReadonlyArray<ChatLine>,
  incoming: ReadonlyArray<ChatLine>,
): Array<ChatLine> => {
  const seen = new Set(
    current.flatMap(line => (line.id === undefined ? [] : [line.id])),
  )
  const next = [...current]
  for (const line of incoming) {
    if (line.id !== undefined && seen.has(line.id)) {
      continue
    }
    if (line.id !== undefined) {
      seen.add(line.id)
    }
    next.push(line)
  }
  return next
}

// Lines that arrive before the first history response stay in `pending`,
// so an open click still fetches history. After that, they append.
export const deliverLive = (
  face: StoredFace | undefined,
  incoming: ReadonlyArray<ChatLine>,
): { lines: Array<ChatLine>; pending: Array<ChatLine> } => {
  const lines = face?.lines ?? []
  const pending = face?.pending ?? []
  if (face?.historyLoaded === true) {
    return {
      lines: appendLines(appendLines(lines, pending), incoming),
      pending: [],
    }
  }
  return { lines: [...lines], pending: appendLines(pending, incoming) }
}
