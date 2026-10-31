import { expect, test } from 'vitest'

import {
  type ChatLine,
  type SponsoredLine,
  type StoredFace,
  appendLines,
  deliverLive,
  threadEntries,
} from './chatFace'

const line = (id: string, text: string): ChatLine => ({
  id,
  text,
  mine: false,
  time: '09:00',
})

const ad = (
  id: string,
  title: string,
  recommended = false,
): SponsoredLine => ({
  id,
  text: title,
  title,
  button: 'Open',
  recommended,
  info: '',
})

const face = (historyLoaded?: true): StoredFace => ({
  id: 'one:1',
  time: '',
  preview: '',
  unread: 0,
  receipt: 'none',
  lines: [line('1', 'older')],
  ...(historyLoaded === undefined ? {} : { historyLoaded }),
})

test('a zero gap shows one sponsored message after the history', () => {
  const entries = threadEntries(
    [line('1', 'older'), line('2', 'newer')],
    [],
    [ad('a', 'Harbor'), ad('b', 'Other')],
    0,
  )
  expect(entries.map(entry => entry.kind)).toEqual([
    'message',
    'message',
    'sponsored',
  ])
  expect(entries[2]).toMatchObject({ line: { id: 'a' } })
})

test('a positive gap inserts each ad after a full group and keeps a short history visible', () => {
  const grouped = threadEntries(
    [line('1', 'a'), line('2', 'b'), line('3', 'c'), line('4', 'd'), line('5', 'e')],
    [],
    [ad('a', 'First'), ad('b', 'Second')],
    2,
  )
  expect(grouped.map(entry => entry.kind)).toEqual([
    'message',
    'message',
    'sponsored',
    'message',
    'message',
    'sponsored',
    'message',
  ])
  const short = threadEntries([line('1', 'only')], [], [ad('a', 'Harbor')], 10)
  expect(short.map(entry => entry.kind)).toEqual(['message', 'sponsored'])
})

test('messages that arrive before history stay pending and then merge without duplicates', () => {
  const waiting = deliverLive(face(), [line('8', 'before')])
  expect(waiting.lines.map(item => item.id)).toEqual(['1'])
  expect(waiting.pending.map(item => item.text)).toEqual(['before'])
  const loaded = deliverLive({ ...face(true), pending: waiting.pending }, [
    line('8', 'before'),
    line('9', 'after'),
  ])
  expect(loaded.lines.map(item => item.text)).toEqual([
    'older',
    'before',
    'after',
  ])
  expect(loaded.pending).toEqual([])
  expect(
    appendLines(loaded.lines, [line('9', 'after'), line('10', 'later')]).map(
      item => item.id,
    ),
  ).toEqual(['1', '8', '9', '10'])
})
