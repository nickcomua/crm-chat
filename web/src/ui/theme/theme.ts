import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Command, Runtime, Subscription, type Update } from 'foldkit'
import * as Dom from 'foldkit/dom'
import { Document, type Html, type HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

// MODEL

const Preference = Schema.Literals(['System', 'Light', 'Dark'])
type Preference = typeof Preference.Type

const Scheme = Schema.Literals(['Light', 'Dark'])
type Scheme = typeof Scheme.Type

const ThemeKey = Schema.Literals([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
])
type ThemeKey = typeof ThemeKey.Type

export const Model = Schema.Struct({
  preference: Preference,
  maybeSystemScheme: Schema.Option(Scheme),
})
export type Model = typeof Model.Type

const preferences: ReadonlyArray<Preference> = ['System', 'Light', 'Dark']

export const themeStorageKey = 'crm-chat.theme'
const themeLabelId = 'crm-theme-label'

export const initialModel: Model = {
  preference: 'System',
  maybeSystemScheme: Option.none(),
}

export const resolvedScheme = (model: Model): Scheme => {
  if (model.preference !== 'System') {
    return model.preference
  }
  return Option.match(model.maybeSystemScheme, {
    onNone: () => 'Light',
    onSome: scheme => scheme,
  })
}

const preferenceAt = (index: number, fallback: Preference): Preference => {
  const preference = preferences[index]
  if (preference === undefined) {
    return fallback
  }
  return preference
}

const movePreference = (current: Preference, key: ThemeKey): Preference => {
  if (key === 'Home') {
    return preferenceAt(0, current)
  }
  if (key === 'End') {
    return preferenceAt(preferences.length - 1, current)
  }
  const index = preferences.indexOf(current)
  const delta = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1
  const next = (index + delta + preferences.length) % preferences.length
  return preferenceAt(next, current)
}

const themeAttribute = (
  preference: Preference,
): 'system' | 'light' | 'dark' => {
  if (preference === 'Light') {
    return 'light'
  }
  if (preference === 'Dark') {
    return 'dark'
  }
  return 'system'
}

export type ThemeDomPlan = {
  readonly dataTheme: 'system' | 'light' | 'dark'
  readonly dataPreference: 'system' | 'light' | 'dark'
  readonly inlineColorScheme: Option.Option<'light' | 'dark'>
  readonly darkClass: boolean
}

// System with an unknown OS scheme leaves color-scheme and `.dark` to CSS,
// so a default of Light cannot paint over `prefers-color-scheme: dark`.
export const themeDomPlan = (
  preference: Preference,
  maybeSystemScheme: Option.Option<Scheme>,
): ThemeDomPlan => {
  const dataPreference = themeAttribute(preference)
  if (preference === 'Light' || preference === 'Dark') {
    return {
      dataTheme: dataPreference,
      dataPreference,
      inlineColorScheme: Option.some(preference === 'Dark' ? 'dark' : 'light'),
      darkClass: preference === 'Dark',
    }
  }
  return Option.match(maybeSystemScheme, {
    onNone: () => ({
      dataTheme: 'system',
      dataPreference,
      inlineColorScheme: Option.none(),
      darkClass: false,
    }),
    onSome: scheme => ({
      dataTheme: 'system',
      dataPreference,
      inlineColorScheme: Option.some(scheme === 'Dark' ? 'dark' : 'light'),
      darkClass: scheme === 'Dark',
    }),
  })
}

const optionDomId = (preference: Preference): string => {
  if (preference === 'Light') {
    return 'crm-theme-option-light'
  }
  if (preference === 'Dark') {
    return 'crm-theme-option-dark'
  }
  return 'crm-theme-option-system'
}

const storedPreference = (value: string | null): Preference => {
  if (value === 'Light' || value === 'Dark' || value === 'System') {
    return value
  }
  return 'System'
}

const readStoredPreference = (): Preference => {
  try {
    return storedPreference(localStorage.getItem(themeStorageKey))
  } catch {
    return 'System'
  }
}

const writeTheme = (preference: Preference, plan: ThemeDomPlan): void => {
  const root = document.documentElement
  root.setAttribute('data-theme', plan.dataTheme)
  root.setAttribute('data-preference', plan.dataPreference)
  Option.match(plan.inlineColorScheme, {
    onNone: () => {
      root.style.removeProperty('color-scheme')
    },
    onSome: colorScheme => {
      root.style.colorScheme = colorScheme
    },
  })
  root.classList.toggle('dark', plan.darkClass)
  localStorage.setItem(themeStorageKey, preference)
}

const applyThemeBestEffort = (
  preference: Preference,
  maybeSystemScheme: Option.Option<Scheme>,
): void => {
  try {
    writeTheme(preference, themeDomPlan(preference, maybeSystemScheme))
  } catch {
    return
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  SelectedPreference: { preference: Preference },
  PressedThemeKey: { key: ThemeKey },
  CompletedReadPreference: { preference: Preference },
  UpdatedSystemScheme: { scheme: Scheme },
  CompletedApplyTheme: {},
  CompletedFocusThemeOption: {},
})
export type Message = typeof Message.Type

// COMMAND

export const ReadStoredPreference = Command.define('ReadStoredPreference', {
  messages: [Message.CompletedReadPreference],
  execute: Effect.sync(() =>
    Message.CompletedReadPreference({ preference: readStoredPreference() }),
  ),
})

export const ApplyTheme = Command.define('ApplyTheme', {
  args: {
    preference: Preference,
    maybeSystemScheme: Schema.Option(Scheme),
  },
  messages: [Message.CompletedApplyTheme],
  execute: ({ preference, maybeSystemScheme }) =>
    Effect.sync(() => {
      applyThemeBestEffort(preference, maybeSystemScheme)
      return Message.CompletedApplyTheme()
    }),
})

export const FocusThemeOption = Command.define('FocusThemeOption', {
  args: { preference: Preference },
  messages: [Message.CompletedFocusThemeOption],
  execute: ({ preference }) =>
    Dom.focus(`#${optionDomId(preference)}`, { preventScroll: true }).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedFocusThemeOption(),
        onFailure: () => Message.CompletedFocusThemeOption(),
      }),
    ),
})

const applyCurrent = (model: Model): Update.Return<Model, Message> => ({
  model,
  commands: [
    ApplyTheme({
      preference: model.preference,
      maybeSystemScheme: model.maybeSystemScheme,
    }),
  ],
})

const selectPreference = (
  model: Model,
  preference: Preference,
  focus: boolean,
): Update.Return<Model, Message> => {
  if (preference === model.preference) {
    if (!focus) {
      return { model }
    }
    return {
      model,
      commands: [FocusThemeOption({ preference })],
    }
  }
  const next = modifyFields(model, { preference: () => preference })
  return {
    model: next,
    commands: focus
      ? [
          ApplyTheme({
            preference,
            maybeSystemScheme: next.maybeSystemScheme,
          }),
          FocusThemeOption({ preference }),
        ]
      : [
          ApplyTheme({
            preference,
            maybeSystemScheme: next.maybeSystemScheme,
          }),
        ],
  }
}

// INIT

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
  commands: [ReadStoredPreference()],
})

// UPDATE

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    SelectedPreference: ({ preference }) =>
      selectPreference(model, preference, false),
    PressedThemeKey: ({ key }) =>
      selectPreference(model, movePreference(model.preference, key), true),
    CompletedReadPreference: ({ preference }) =>
      applyCurrent(modifyFields(model, { preference: () => preference })),
    UpdatedSystemScheme: ({ scheme }) => {
      const next = modifyFields(model, {
        maybeSystemScheme: () => Option.some(scheme),
      })
      if (model.preference !== 'System') {
        return { model: next }
      }
      return applyCurrent(next)
    },
    CompletedApplyTheme: () => ({ model }),
    CompletedFocusThemeOption: () => ({ model }),
  })

// VIEW

const optionView = (
  model: Model,
  preference: Preference,
  h: HtmlBuilder<Message>,
): Html => {
  const selected = model.preference === preference
  return h.keyed('button')(
    preference,
    [
      h.Id(optionDomId(preference)),
      h.Type('button'),
      h.Role('radio'),
      h.AriaChecked(selected),
      h.Tabindex(selected ? 0 : -1),
      h.Class('ui-theme-option'),
      h.OnClick(Message.SelectedPreference({ preference })),
      h.OnKeyDownPreventDefault(key => {
        if (
          key === 'ArrowLeft' ||
          key === 'ArrowRight' ||
          key === 'ArrowUp' ||
          key === 'ArrowDown' ||
          key === 'Home' ||
          key === 'End'
        ) {
          return Option.some(Message.PressedThemeKey({ key }))
        }
        return Option.none()
      }),
    ],
    [preference],
  )
}

export const switcherView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('ui-theme')],
    [
      h.span([h.Id(themeLabelId), h.Class('ui-theme-label')], ['Theme']),
      h.div(
        [
          h.Role('radiogroup'),
          h.AriaLabelledBy(themeLabelId),
          h.AriaOrientation('horizontal'),
          h.Class('ui-theme-switcher'),
        ],
        preferences.map(preference => optionView(model, preference, h)),
      ),
    ],
  )

type Swatch = {
  readonly id: string
  readonly label: string
  readonly background: string
  readonly foreground: string
}

const swatches: ReadonlyArray<Swatch> = [
  {
    id: 'background',
    label: 'Background',
    background: 'var(--background)',
    foreground: 'var(--foreground)',
  },
  {
    id: 'primary',
    label: 'Primary',
    background: 'var(--primary)',
    foreground: 'var(--primary-foreground)',
  },
  {
    id: 'muted',
    label: 'Muted',
    background: 'var(--muted)',
    foreground: 'var(--muted-foreground)',
  },
  {
    id: 'outgoing',
    label: 'Outgoing',
    background: 'var(--telegram-message-out)',
    foreground: 'var(--telegram-message-out-foreground)',
  },
  {
    id: 'incoming',
    label: 'Incoming',
    background: 'var(--telegram-message-in)',
    foreground: 'var(--telegram-message-in-foreground)',
  },
]

const swatchView = (swatch: Swatch, h: HtmlBuilder<Message>): Html =>
  h.keyed('div')(
    swatch.id,
    [h.Class('ui-theme-swatch')],
    [
      h.span(
        [
          h.Class('ui-theme-swatch-chip'),
          h.Style({
            backgroundColor: swatch.background,
            color: swatch.foreground,
          }),
          h.AriaHidden(true),
        ],
        ['Aa'],
      ),
      h.span([], [swatch.label]),
    ],
  )

const resolvedLabel = (model: Model): string => {
  const preference =
    model.preference === 'System'
      ? 'system'
      : model.preference === 'Light'
        ? 'light'
        : 'dark'
  const scheme = resolvedScheme(model) === 'Dark' ? 'dark' : 'light'
  return `Preference ${preference}, resolved ${scheme}.`
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Theme',
  body: h.section(
    [h.Class('ui-theme-demo'), h.AriaLabel('Theme demo')],
    [
      switcherView(model, h),
      h.p([h.Class('ui-theme-resolved')], [resolvedLabel(model)]),
      h.div(
        [h.Class('ui-theme-swatches')],
        swatches.map(swatch => swatchView(swatch, h)),
      ),
    ],
  ),
})

// SUBSCRIPTIONS

export const subscriptions = Subscription.make<Model, Message>()(_entry => ({
  systemScheme: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({
      query: '(prefers-color-scheme: dark)',
      mapMatches: isDark =>
        Message.UpdatedSystemScheme({ scheme: isDark ? 'Dark' : 'Light' }),
    }),
  ),
}))

export const demo = () => ({
  Model,
  init,
  update,
  view,
  subscriptions,
})
