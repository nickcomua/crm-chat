import type { StoredFace } from './chatFace'
import type { Chat, ChatKind } from './generated/core'

export const fixtureChats: ReadonlyArray<Chat> = [
  { id: 'ada', title: 'Ada', kind: 'Dialog' },
  { id: 'book-club', title: 'Book club', kind: 'Group' },
  { id: 'announcements', title: 'Announcements', kind: 'Channel' },
  { id: 'mira', title: 'Mira', kind: 'Dialog' },
  { id: 'ops', title: 'Ops', kind: 'Group' },
  { id: 'release-notes', title: 'Release notes', kind: 'Channel' },
  { id: 'leo', title: 'Leo', kind: 'Dialog' },
  { id: 'design', title: 'Design', kind: 'Group' },
  { id: 'field-notes', title: 'Field notes', kind: 'Channel' },
  { id: 'noah', title: 'Noah', kind: 'Dialog' },
  { id: 'stand-up', title: 'Stand-up', kind: 'Group' },
  { id: 'hq', title: 'HQ', kind: 'Channel' },
]

export type ChatLine = {
  readonly text: string
  readonly mine: boolean
  readonly time: string
  readonly caption?: string
}

export type ChatFace = {
  readonly time: string
  readonly preview: string
  readonly unread: number
  readonly receipt: 'none' | 'sent' | 'read'
  readonly lines: ReadonlyArray<ChatLine>
}

const line = (
  text: string,
  time: string,
  mine = false,
  caption?: string,
): ChatLine => ({
  text,
  mine,
  time,
  ...(caption === undefined ? {} : { caption }),
})

const faces: Record<string, ChatFace> = {
  ada: {
    time: '18:42',
    preview: 'Bring the notes.',
    unread: 0,
    receipt: 'read',
    lines: [
      line('Platform 2, by the clock.', '18:31'),
      line('I saved a seat.', '18:33'),
      line('On the tram now.', '18:36', true),
      line('See you at the station.', '18:40'),
      line(
        'The sketch from this morning. Print is fine.',
        '18:41',
        false,
        'Station sketch',
      ),
      line('Bring the notes.', '18:42', true),
    ],
  },
  'book-club': {
    time: '12:05',
    preview: 'I can host.',
    unread: 3,
    receipt: 'none',
    lines: [
      line('Next week: chapter four.', '12:01'),
      line('I can host.', '12:05'),
    ],
  },
  announcements: {
    time: '09:15',
    preview: 'Replies are off.',
    unread: 1,
    receipt: 'none',
    lines: [
      line('Schedule posted for the week.', '09:14'),
      line('Replies are off.', '09:15'),
    ],
  },
  mira: {
    time: '17:48',
    preview: 'Send the draft when you can.',
    unread: 0,
    receipt: 'sent',
    lines: [line('Send the draft when you can.', '17:48')],
  },
  ops: {
    time: '16:20',
    preview: 'Deploy is green.',
    unread: 0,
    receipt: 'sent',
    lines: [line('Deploy is green.', '16:20')],
  },
  'release-notes': {
    time: '15:02',
    preview: '0.4 is out.',
    unread: 12,
    receipt: 'none',
    lines: [line('0.4 is out.', '15:02')],
  },
  leo: {
    time: '14:11',
    preview: 'Photo from the quay.',
    unread: 0,
    receipt: 'read',
    lines: [line('Photo from the quay.', '14:11', false, 'Quay')],
  },
  design: {
    time: '11:40',
    preview: 'Spacing on the list is still tight.',
    unread: 2,
    receipt: 'none',
    lines: [line('Spacing on the list is still tight.', '11:40')],
  },
  'field-notes': {
    time: '10:05',
    preview: 'Wind on the ridge.',
    unread: 0,
    receipt: 'read',
    lines: [line('Wind on the ridge.', '10:05')],
  },
  noah: {
    time: 'Yesterday',
    preview: 'I left the key.',
    unread: 0,
    receipt: 'read',
    lines: [line('I left the key.', 'Yesterday')],
  },
  'stand-up': {
    time: 'Yesterday',
    preview: 'Same time tomorrow.',
    unread: 0,
    receipt: 'read',
    lines: [line('Same time tomorrow.', 'Yesterday')],
  },
  hq: {
    time: 'Mon',
    preview: 'Office is closed Friday.',
    unread: 0,
    receipt: 'read',
    lines: [line('Office is closed Friday.', 'Mon')],
  },
}

const emptyFace: ChatFace = {
  time: '',
  preview: '',
  unread: 0,
  receipt: 'none',
  lines: [],
}

export const faceFor = (id: string): ChatFace => faces[id] ?? emptyFace

export const fixtureFaces = (): ReadonlyArray<StoredFace> =>
  fixtureChats.flatMap(chat => {
    const face = faces[chat.id]
    if (face === undefined) {
      return []
    }
    return [{ id: chat.id, ...face }]
  })

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
