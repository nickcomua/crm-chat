import { expect, test } from 'vitest'

import { parseAppCredentials } from './appCredentials'

const hash = '0123456789abcdef0123456789abcdef'

test('accepts a numeric API ID and 32 character hash', () => {
  expect(parseAppCredentials({ apiId: '12345', apiHash: hash })).toEqual({
    apiId: '12345',
    apiHash: hash,
  })
})

test('rejects missing, malformed, and empty credentials', () => {
  expect(parseAppCredentials(null)).toBeUndefined()
  expect(parseAppCredentials({})).toBeUndefined()
  expect(
    parseAppCredentials({ apiId: '0123', apiHash: hash }),
  ).toBeUndefined()
  expect(
    parseAppCredentials({ apiId: '12345', apiHash: 'not-a-hash' }),
  ).toBeUndefined()
})
