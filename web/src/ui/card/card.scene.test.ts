import {
  click,
  expect,
  given,
  role,
  scene,
} from 'foldkit/scene'
import { test } from 'vitest'

import { demoInit, demoUpdate, demoView } from './card'

test('card exposes title, description, and content', () => {
  scene(
    { update: demoUpdate, view: demoView },
    given(demoInit().model),
    expect(role('article', { name: 'Billing question' })).toExist(),
    expect(role('heading', { name: 'Billing question' })).toExist(),
    expect(role('article', { name: 'Billing question' })).toContainText(
      'Ada asked about invoice 1042.',
    ),
    expect(role('article', { name: 'Billing question' })).toContainText(
      'Opened from the saved chat.',
    ),
    expect(role('article', { name: 'Billing question' })).toContainText('New'),
    expect(role('button', { name: 'Note' })).toHaveClass('ui-card-button'),
  )
})

test('noting a card announces the noted state and disables the action', () => {
  scene(
    { update: demoUpdate, view: demoView },
    given(demoInit().model),
    click(role('button', { name: 'Note' })),
    expect(role('button', { name: 'Noted' })).toBeDisabled(),
    expect(role('article', { name: 'Billing question' })).toContainText('Noted'),
  )
})
