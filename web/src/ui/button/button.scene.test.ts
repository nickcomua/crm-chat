import {
  click,
  expect,
  expectIgnored,
  given,
  keydown,
  role,
  scene,
  selector,
  within,
} from 'foldkit/scene'
import { test } from 'vitest'

import { demo, demoUpdate, initialDemoModel } from './button'

const save = role('button', { name: 'Save' })
const status = role('status')

test('activates with click, Enter, and Space, and ignores other keys', () => {
  scene(
    { update: demoUpdate, view: demo },
    given(initialDemoModel),
    expect(save).toHaveClass('ui-button'),
    expect(save).toHaveAttr('type', 'button'),
    expect(save).toHaveAttr('data-variant', 'default'),
    expect(save).toHaveAttr('data-size', 'default'),
    expect(save).toHaveAttr('data-loading', 'false'),
    expect(save).toBeEnabled(),
    expect(role('button', { name: 'Archive' })).toHaveAttr(
      'data-variant',
      'secondary',
    ),
    expect(role('button', { name: 'More' })).toHaveAttr('data-variant', 'ghost'),
    expect(role('button', { name: 'Delete' })).toHaveAttr(
      'data-variant',
      'destructive',
    ),
    expect(role('button', { name: 'Learn more' })).toHaveAttr(
      'data-variant',
      'link',
    ),
    expect(role('link', { name: 'Learn more' })).not.toExist(),
    expect(role('button', { name: 'Pin' })).toHaveAttr('data-size', 'sm'),
    expect(role('button', { name: 'Send' })).toHaveAttr('data-size', 'lg'),
    expect(role('button', { name: 'Close' })).toHaveAttr('data-size', 'icon'),
    expect(
      within(role('button', { name: 'Close' }), selector('.ui-button-graphic')),
    ).toExist(),
    expect(role('button', { name: 'Mute' })).toBeDisabled(),
    expect(role('button', { name: 'Mute' })).toHaveAttr('aria-disabled', 'true'),
    expect(role('button', { name: 'Publishing' })).toHaveAttr('aria-busy', 'true'),
    expect(role('button', { name: 'Publishing' })).toHaveAttr(
      'aria-disabled',
      'true',
    ),
    expect(role('button', { name: 'Publishing' })).not.toHaveAttr('disabled'),
    expect(
      within(role('button', { name: 'Publishing' }), selector('.ui-spinner')),
    ).toExist(),
    expect(
      within(role('button', { name: 'Publishing' }), role('status')),
    ).not.toExist(),
    expect(role('button', { name: 'Publish' })).not.toHaveAttr('aria-busy'),
    expect(role('button', { name: 'Post' })).toHaveAttr('type', 'submit'),
    expect(status).toHaveText('idle:0'),
    keydown(save, 'Escape'),
    expectIgnored(),
    expect(status).toHaveText('idle:0'),
    keydown(save, 'Enter', { ctrlKey: true }),
    expectIgnored(),
    expect(status).toHaveText('idle:0'),
    click(save),
    expect(status).toHaveText('Save:1'),
    keydown(save, 'Enter'),
    expect(status).toHaveText('Save:2'),
    keydown(save, ' '),
    expect(status).toHaveText('Save:3'),
    click(role('button', { name: 'Delete' })),
    expect(status).toHaveText('Delete:4'),
    click(role('button', { name: 'Close' })),
    expect(status).toHaveText('Close:5'),
    keydown(role('button', { name: 'Learn more' }), 'Enter'),
    expect(status).toHaveText('Learn more:6'),
    click(role('button', { name: 'Post' })),
    expect(status).toHaveText('Post:7'),
    click(role('button', { name: 'Publish' })),
    expect(status).toHaveText('Publish:8'),
    expect(role('button', { name: 'Publish' })).toHaveAttr('aria-busy', 'true'),
    expect(role('button', { name: 'Publish' })).toHaveAttr(
      'aria-disabled',
      'true',
    ),
    expect(role('button', { name: 'Publish' })).not.toHaveAttr('disabled'),
  )
})
