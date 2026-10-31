import * as Option from 'effect/Option'
import { Command, given, message, model, story } from 'foldkit/story'
import { modifyFields } from 'foldkit/struct'
import { expect, test } from 'vitest'

import {
  ApplyTheme,
  FocusThemeOption,
  Message,
  initialModel,
  resolvedScheme,
  themeDomPlan,
  update,
} from './theme'

test('system preference follows the operating system once it is known', () => {
  story(
    update,
    given(initialModel),
    message(Message.UpdatedSystemScheme({ scheme: 'Dark' })),
    model(current => {
      expect(current.preference).toBe('System')
      expect(current.maybeSystemScheme).toEqual(Option.some('Dark'))
      expect(resolvedScheme(current)).toBe('Dark')
    }),
    Command.expectExact(
      ApplyTheme({
        preference: 'System',
        maybeSystemScheme: Option.some('Dark'),
      }),
    ),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
  )
})

test('an explicit scheme ignores a later operating-system change', () => {
  story(
    update,
    given(initialModel),
    message(Message.SelectedPreference({ preference: 'Light' })),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    message(Message.UpdatedSystemScheme({ scheme: 'Dark' })),
    model(current => {
      expect(current.preference).toBe('Light')
      expect(resolvedScheme(current)).toBe('Light')
      expect(current.maybeSystemScheme).toEqual(Option.some('Dark'))
    }),
    Command.expectNone(),
  )
})

test('arrow keys wrap and home returns to system', () => {
  const dark = modifyFields(initialModel, { preference: () => 'Dark' })
  story(
    update,
    given(dark),
    message(Message.PressedThemeKey({ key: 'ArrowRight' })),
    model(current => {
      expect(current.preference).toBe('System')
    }),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    Command.resolve(FocusThemeOption, Message.CompletedFocusThemeOption()),
    message(Message.PressedThemeKey({ key: 'End' })),
    model(current => {
      expect(current.preference).toBe('Dark')
    }),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    Command.resolve(FocusThemeOption, Message.CompletedFocusThemeOption()),
    message(Message.PressedThemeKey({ key: 'Home' })),
    model(current => {
      expect(current.preference).toBe('System')
    }),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
    Command.resolve(FocusThemeOption, Message.CompletedFocusThemeOption()),
  )
})

test('reading a stored dark preference applies dark without waiting for the OS', () => {
  story(
    update,
    given(initialModel),
    message(Message.CompletedReadPreference({ preference: 'Dark' })),
    model(current => {
      expect(current.preference).toBe('Dark')
      expect(resolvedScheme(current)).toBe('Dark')
    }),
    Command.expectExact(
      ApplyTheme({
        preference: 'Dark',
        maybeSystemScheme: Option.none(),
      }),
    ),
    Command.resolve(ApplyTheme, Message.CompletedApplyTheme()),
  )
})

test('clicking the current preference does not apply again', () => {
  story(
    update,
    given(initialModel),
    message(Message.SelectedPreference({ preference: 'System' })),
    model(current => {
      expect(current.preference).toBe('System')
    }),
    Command.expectNone(),
  )
})

test('system theme leaves the OS media query in charge until the scheme is known', () => {
  expect(themeDomPlan('System', Option.none())).toEqual({
    dataTheme: 'system',
    dataPreference: 'system',
    inlineColorScheme: Option.none(),
    darkClass: false,
  })
  expect(themeDomPlan('System', Option.some('Dark'))).toEqual({
    dataTheme: 'system',
    dataPreference: 'system',
    inlineColorScheme: Option.some('dark'),
    darkClass: true,
  })
  expect(themeDomPlan('Light', Option.some('Dark'))).toEqual({
    dataTheme: 'light',
    dataPreference: 'light',
    inlineColorScheme: Option.some('light'),
    darkClass: false,
  })
  expect(themeDomPlan('Dark', Option.none())).toEqual({
    dataTheme: 'dark',
    dataPreference: 'dark',
    inlineColorScheme: Option.some('dark'),
    darkClass: true,
  })
})
