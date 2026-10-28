import type { Chat } from './generated/core'

export const fixtureChats: ReadonlyArray<Chat> = [
  { id: 'ada', title: 'Ada', kind: 'Dialog' },
  { id: 'book-club', title: 'Book club', kind: 'Group' },
  { id: 'announcements', title: 'Announcements', kind: 'Channel' },
]

export const fixtureLines: Record<string, ReadonlyArray<string>> = {
  ada: ['See you at the station.', 'Bring the notes.'],
  'book-club': ['Next week: chapter four.', 'I can host.'],
  announcements: ['Schedule posted.', 'Replies are off.'],
}

export const linesFor = (id: string): ReadonlyArray<string> => fixtureLines[id] ?? []

export const markFor = (title: string): string => title.slice(0, 1).toUpperCase()
