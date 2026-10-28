import type { Chat } from './generated/core'

export const fixtureChats: ReadonlyArray<Chat> = [
  { id: 'ada', title: 'Ada', kind: 'Dialog' },
  { id: 'book-club', title: 'Book club', kind: 'Group' },
  { id: 'announcements', title: 'Announcements', kind: 'Channel' },
]
