import type { Chat } from './generated/core'

export const fixtureChats: ReadonlyArray<Chat> = [
  { id: 'ada', title: 'Ada', kind: 'Dialog' },
  { id: 'book-club', title: 'Book club', kind: 'Group' },
  { id: 'announcements', title: 'Announcements', kind: 'Channel' },
]

export type ChatLine = {
  readonly text: string
  readonly mine: boolean
  readonly time: string
}

export type ChatFace = {
  readonly time: string
  readonly preview: string
  readonly lines: ReadonlyArray<ChatLine>
}

const faces: Record<string, ChatFace> = {
  ada: {
    time: '18:42',
    preview: 'Bring the notes.',
    lines: [
      { text: 'See you at the station.', mine: false, time: '18:40' },
      { text: 'Bring the notes.', mine: true, time: '18:42' },
    ],
  },
  'book-club': {
    time: '12:05',
    preview: 'I can host.',
    lines: [
      { text: 'Next week: chapter four.', mine: false, time: '12:01' },
      { text: 'I can host.', mine: false, time: '12:05' },
    ],
  },
  announcements: {
    time: '09:15',
    preview: 'Replies are off.',
    lines: [
      { text: 'Schedule posted.', mine: false, time: '09:14' },
      { text: 'Replies are off.', mine: false, time: '09:15' },
    ],
  },
}

const emptyFace: ChatFace = { time: '', preview: '', lines: [] }

export const faceFor = (id: string): ChatFace => faces[id] ?? emptyFace

export const markFor = (title: string): string => title.slice(0, 1).toUpperCase()
