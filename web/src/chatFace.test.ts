import { expect, test } from 'vitest'

import {
  type ChatLine,
  type StoredFace,
  appendLines,
  deliverLive,
} from './chatFace'

const line = (id: string, text: string): ChatLine => ({
  id,
  text,
  mine: false,
  time: '09:00',
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
