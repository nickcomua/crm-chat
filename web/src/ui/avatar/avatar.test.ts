import * as Option from 'effect/Option'

import { Scene, Story } from 'foldkit'
import type { HtmlBuilder } from 'foldkit/html'
import { expect, test } from 'vitest'

import {
  type AvatarConfig,
  Message,
  type Model,
  avatarColor,
  demo,
  demoInit,
  demoUpdate,
  init,
  initials,
  update,
  view,
} from './avatar'

test('initials use the first letters of the first two words', () => {
  expect(initials('Nick Korniichuk')).toBe('NK')
  expect(initials('ada')).toBe('A')
  expect(initials('')).toBe('?')
  expect(initials('   ')).toBe('?')
  expect(initials('іван петренко')).toBe('ІП')
})

test('numeric peer ids use Telegram abs(id) % 7 colors', () => {
  expect(avatarColor('0')).toBe('#e17076')
  expect(avatarColor('1')).toBe('#faa774')
  expect(avatarColor('7')).toBe('#e17076')
  expect(avatarColor('8')).toBe('#faa774')
  expect(avatarColor('-1')).toBe('#faa774')
  expect(avatarColor('Ada Lovelace')).toBe(avatarColor('Ada Lovelace'))
})

test('a failed image records the source that failed', () => {
  const source = 'https://cdn.example/ada.png'
  Story.story(
    update,
    Story.given(init(source).model),
    Story.message(Message.FailedLoadImage({ source })),
    Story.model(current => {
      expect(current.image._tag).toBe('Failed')
      if (current.image._tag === 'Failed') {
        expect(current.image.source).toBe(source)
      }
    }),
    Story.message(Message.FailedLoadImage({ source: 'https://cdn.example/next.png' })),
    Story.model(current => {
      expect(current.image._tag).toBe('Failed')
      if (current.image._tag === 'Failed') {
        expect(current.image.source).toBe('https://cdn.example/next.png')
      }
    }),
  )
})

const render =
  (config: AvatarConfig) => (model: Model, h: HtmlBuilder<Message>) =>
    view(model, config, h)

test('a pending photo keeps its accessible name and is not a tab stop', () => {
  const source = 'https://cdn.example/ada.png'
  Scene.scene(
    {
      update,
      view: render({
        name: 'Ada Lovelace',
        peerId: '0',
        source: Option.some(source),
      }),
    },
    Scene.given(init(source).model),
    Scene.expect(Scene.altText('Ada Lovelace')).toHaveAttr('src', source),
    Scene.expect(Scene.altText('Ada Lovelace')).not.toHaveAttr('tabindex'),
    Scene.expect(Scene.selector('.ui-avatar-fallback')).not.toExist(),
  )
})

test('a failed photo falls back to colored initials', () => {
  const source = 'https://cdn.example/ada.png'
  const failed = update(
    init(source).model,
    Message.FailedLoadImage({ source }),
  ).model
  Scene.scene(
    {
      update,
      view: render({
        name: 'Ada Lovelace',
        peerId: '0',
        source: Option.some(source),
      }),
    },
    Scene.given(failed),
    Scene.expect(Scene.altText('Ada Lovelace')).not.toExist(),
    Scene.expect(Scene.role('img', { name: 'Ada Lovelace' })).toHaveText('AL'),
    Scene.expect(Scene.role('img', { name: 'Ada Lovelace' })).toHaveStyle(
      'backgroundColor',
      '#e17076',
    ),
    Scene.expect(Scene.role('img', { name: 'Ada Lovelace' })).not.toHaveAttr(
      'tabindex',
    ),
  )
})

test('an image-less peer renders initials immediately', () => {
  Scene.scene(
    {
      update,
      view: render({
        name: 'Book club',
        peerId: '3',
        source: Option.none(),
      }),
    },
    Scene.given(init('').model),
    Scene.expect(Scene.role('img', { name: 'Book club' })).toHaveText('BC'),
    Scene.expect(Scene.role('img', { name: 'Book club' })).toHaveStyle(
      'backgroundColor',
      '#7bc862',
    ),
  )
})

test('a stale failure does not hide a newer photo', () => {
  const stale = update(
    init('https://cdn.example/old.png').model,
    Message.FailedLoadImage({ source: 'https://cdn.example/old.png' }),
  ).model
  Scene.scene(
    {
      update,
      view: render({
        name: 'Ada Lovelace',
        peerId: '1',
        source: Option.some('https://cdn.example/new.png'),
      }),
    },
    Scene.given(stale),
    Scene.expect(Scene.altText('Ada Lovelace')).toHaveAttr(
      'src',
      'https://cdn.example/new.png',
    ),
  )
})

test('the demo shows a photo and two initial avatars', () => {
  Scene.scene(
    { update: demoUpdate, view: demo },
    Scene.given(demoInit().model),
    Scene.expect(Scene.altText('Nick Korniichuk')).toExist(),
    Scene.expect(Scene.role('img', { name: 'Ada Lovelace' })).toHaveText('AL'),
    Scene.expect(Scene.role('img', { name: 'Book club' })).toHaveText('BC'),
  )
})
