import * as Array from 'effect/Array'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { Command, Runtime, Subscription, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'

import { readAppCredentials } from './appCredentials'
import { StoredFace } from './chatFace'
import { countryByIso, defaultCountryIso, dialFor } from './countries'
import { Login } from './login'
import { loginScreen } from './loginView'
import { Message, RuntimeCredentials, Secret } from './message'
import { chatShell } from './shellView'
import {
  Account,
  beginLogin,
  desktopFailure,
  loadAccount,
  pollAccount,
  removeConnection,
  restoreAccounts,
  submitCode,
  submitPassword,
} from './telegram'

export { Message }

export const Model = Schema.Struct({
  login: Login,
  appCredentials: Schema.Literals(['Manual', 'Supplied']),
  apiId: Schema.String,
  apiHash: Secret,
  phone: Secret,
  countryIso: Schema.String,
  countryOpen: Schema.Boolean,
  keepSignedIn: Schema.Boolean,
  answer: Secret,
  status: Schema.Literals(['Ready', 'Busy']),
  error: Schema.String,
  accounts: Schema.Array(Account),
  selectedAccountId: Schema.String,
  query: Schema.String,
  draft: Schema.String,
  maybeOpenChatId: Schema.Option(Schema.String),
  menuOpen: Schema.Boolean,
  moreOpen: Schema.Boolean,
  headerMenuOpen: Schema.Boolean,
  composerTool: Schema.Literals(['Closed', 'Emoji', 'Attach', 'Voice', 'Send']),
  headerTool: Schema.Literals(['Closed', 'Search', 'Call']),
  autoDeleteOpen: Schema.Boolean,
  autoDelete: Schema.String,
  hiddenChatIds: Schema.Array(Schema.String),
  mutedChatIds: Schema.Array(Schema.String),
  faces: Schema.Array(StoredFace),
  fixturePreview: Schema.Boolean,
})
export type Model = typeof Model.Type

const loginError = desktopFailure
export const LoadAppCredentials = Command.define('LoadAppCredentials', {
  messages: [Message.CompletedLoadAppCredentials],
  execute: Effect.tryPromise(() => readAppCredentials()).pipe(
    Effect.map(credentials =>
      Message.CompletedLoadAppCredentials({
        credentials:
          credentials === undefined
            ? RuntimeCredentials.Absent()
            : RuntimeCredentials.Present({
                apiId: credentials.apiId,
                apiHash: Redacted.make(credentials.apiHash),
              }),
      }),
    ),
    Effect.catch(() =>
      Effect.succeed(
        Message.CompletedLoadAppCredentials({
          credentials: RuntimeCredentials.Absent(),
        }),
      ),
    ),
  ),
})
export const BeginLogin = Command.define('BeginLogin', {
  args: {
    apiId: Schema.String,
    apiHash: Secret,
    phone: Secret,
    qr: Schema.Boolean,
  },
  messages: [Message.SucceededAuthenticate, Message.FailedAuthenticate],
  execute: ({ apiId, apiHash, phone, qr }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto
      const id = yield* crypto.randomUUIDv4
      return yield* Effect.tryPromise(() =>
        beginLogin(
          id,
          Number(apiId),
          Redacted.value(apiHash),
          Redacted.value(phone),
          qr,
        ),
      )
    }).pipe(
      Effect.provide(BrowserCrypto.layer),
      Effect.map(result =>
        Message.SucceededAuthenticate({ result, sourceId: '' }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAuthenticate({
            error: loginError(error.cause),
            sourceId: '',
          }),
        ),
      ),
    ),
})
export const SubmitAnswer = Command.define('SubmitAnswer', {
  args: { id: Schema.String, answer: Secret, password: Schema.Boolean },
  messages: [Message.SucceededAuthenticate, Message.FailedAuthenticate],
  execute: ({ id, answer, password }) =>
    Effect.tryPromise(() =>
      password
        ? submitPassword(id, Redacted.value(answer))
        : submitCode(id, Redacted.value(answer)),
    ).pipe(
      Effect.map(result =>
        Message.SucceededAuthenticate({ result, sourceId: id }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedAuthenticate({
            error: loginError(error.cause),
            sourceId: id,
          }),
        ),
      ),
    ),
})
export const Restore = Command.define('Restore', {
  args: { apiId: Schema.String, apiHash: Secret },
  messages: [Message.CompletedRestore],
  execute: ({ apiId, apiHash }) =>
    Effect.tryPromise(() =>
      restoreAccounts(Number(apiId), Redacted.value(apiHash)),
    ).pipe(
      Effect.map(accounts => Message.CompletedRestore({ accounts })),
      Effect.catch(() =>
        Effect.succeed(Message.CompletedRestore({ accounts: [] })),
      ),
    ),
})
export const Refresh = Command.define('Refresh', {
  args: { id: Schema.String },
  messages: [Message.SucceededRefresh, Message.FailedRefresh],
  execute: ({ id }) =>
    Effect.tryPromise(() => loadAccount(id)).pipe(
      Effect.map(account => Message.SucceededRefresh({ account })),
      Effect.catch(() => Effect.succeed(Message.FailedRefresh())),
    ),
})
export const Disconnect = Command.define('Disconnect', {
  args: { id: Schema.String },
  messages: [Message.CompletedDisconnect],
  execute: ({ id }) =>
    Effect.tryPromise(() => removeConnection(id)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedDisconnect(),
        onFailure: () => Message.CompletedDisconnect(),
      }),
    ),
})
const closedMenus = {
  menuOpen: () => false,
  moreOpen: () => false,
  headerMenuOpen: () => false,
  autoDeleteOpen: () => false,
}
const phoneForLogin = (model: Model) => {
  const typed = Redacted.value(model.phone).trim()
  if (typed === '' || typed.startsWith('+')) {
    return model.phone
  }
  return Redacted.make(`${dialFor(model.countryIso)}${typed}`)
}
const startLogin = (
  model: Model,
  qr: boolean,
): Update.Return<Model, Message> => {
  if (
    model.fixturePreview ||
    model.status === 'Busy' ||
    model.login._tag !== 'Editing'
  ) {
    return { model }
  }
  if (
    !/^[1-9]\d*$/.test(model.apiId) ||
    !/^[a-f\d]{32}$/i.test(Redacted.value(model.apiHash))
  ) {
    return {
      model: modifyFields(model, {
        error: () => 'Enter a valid Telegram API ID and 32 character API hash.',
      }),
    }
  }
  return {
    model: modifyFields(model, { status: () => 'Busy', error: () => '' }),
    commands: [
      BeginLogin({
        apiId: model.apiId,
        apiHash: model.apiHash,
        phone: phoneForLogin(model),
        qr,
      }),
    ],
  }
}
export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    UpdatedApiId: ({ value }) => ({
      model: modifyFields(model, { apiId: () => value }),
    }),
    UpdatedApiHash: ({ value }) => ({
      model: modifyFields(model, { apiHash: () => value }),
    }),
    UpdatedPhone: ({ value }) => ({
      model: modifyFields(model, { phone: () => value }),
    }),
    ClickedCountry: () => ({
      model: modifyFields(model, { countryOpen: () => !model.countryOpen }),
    }),
    SelectedCountry: ({ iso }) =>
      Option.isNone(countryByIso(iso))
        ? { model }
        : {
            model: modifyFields(model, {
              countryIso: () => iso,
              countryOpen: () => false,
            }),
          },
    // NOTE: The checkbox is the phone-step control. Sessions stay in this tab; reload still signs out.
    ToggledKeepSignedIn: () => ({
      model: modifyFields(model, {
        keepSignedIn: () => !model.keepSignedIn,
      }),
    }),
    UpdatedAnswer: ({ value }) => ({
      model: modifyFields(model, { answer: () => value }),
    }),
    UpdatedQuery: ({ value }) => ({
      model: modifyFields(model, { query: () => value }),
    }),
    UpdatedDraft: ({ value }) => ({
      model: modifyFields(model, { draft: () => value }),
    }),
    ClickedPhoneLogin: () => startLogin(model, false),
    ClickedQrLogin: () => startLogin(model, true),
    SubmittedAnswer: () => {
      if (
        model.fixturePreview ||
        model.status === 'Busy' ||
        (model.login._tag !== 'Code' && model.login._tag !== 'Password')
      ) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          status: () => 'Busy',
          error: () => '',
          answer: () => Redacted.make(''),
        }),
        commands: [
          SubmitAnswer({
            id: model.login.id,
            answer: model.answer,
            password: model.login._tag === 'Password',
          }),
        ],
      }
    },
    ClickedAddAccount: () =>
      model.status === 'Busy'
        ? { model }
        : {
            model: modifyFields(model, {
              login: () => Login.Editing(),
              error: () => '',
              ...closedMenus,
            }),
          },
    ClickedCancel: () => {
      if (model.status === 'Busy') {
        return { model }
      }
      const next = modifyFields(model, {
        login: () =>
          Array.isReadonlyArrayEmpty(model.accounts)
            ? Login.Editing()
            : Login.Closed(),
        answer: () => Redacted.make(''),
        error: () => '',
        ...closedMenus,
      })
      if (
        !model.fixturePreview &&
        (model.login._tag === 'Code' ||
          model.login._tag === 'Password' ||
          model.login._tag === 'Qr')
      ) {
        return { model: next, commands: [Disconnect({ id: model.login.id })] }
      }
      return { model: next }
    },
    SelectedAccount: ({ id }) => ({
      model: modifyFields(model, {
        selectedAccountId: () => id,
        query: () => '',
        draft: () => '',
        maybeOpenChatId: () => Option.none(),
        ...closedMenus,
      }),
    }),
    ClickedRefresh: () =>
      model.fixturePreview ||
      model.status === 'Busy' ||
      model.selectedAccountId === ''
        ? { model }
        : {
            model: modifyFields(model, {
              status: () => 'Busy',
              error: () => '',
            }),
            commands: [Refresh({ id: model.selectedAccountId })],
          },
    ClickedChat: ({ id }) => ({
      model: modifyFields(model, {
        maybeOpenChatId: () => Option.some(id),
        draft: () => '',
        ...closedMenus,
      }),
    }),
    ClickedBack: () => ({
      model: modifyFields(model, {
        maybeOpenChatId: () => Option.none(),
        ...closedMenus,
      }),
    }),
    ClickedMenu: () => ({
      model: modifyFields(model, {
        menuOpen: () => !model.menuOpen,
        moreOpen: () => false,
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
      }),
    }),
    ClickedMore: () => ({
      model: modifyFields(model, { moreOpen: () => !model.moreOpen }),
    }),
    ClickedHeaderMenu: () => ({
      model: modifyFields(model, {
        headerMenuOpen: () => !model.headerMenuOpen,
        autoDeleteOpen: () => false,
        menuOpen: () => false,
        moreOpen: () => false,
      }),
    }),
    ClickedHeaderSearch: () => ({
      model: modifyFields(model, {
        headerTool: () => (model.headerTool === 'Search' ? 'Closed' : 'Search'),
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
      }),
    }),
    ClickedCall: () => ({
      model: modifyFields(model, {
        headerTool: () => (model.headerTool === 'Call' ? 'Closed' : 'Call'),
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
      }),
    }),
    ClickedEmoji: () => ({
      model: modifyFields(model, {
        composerTool: () =>
          model.composerTool === 'Emoji' ? 'Closed' : 'Emoji',
      }),
    }),
    ClickedAttach: () => ({
      model: modifyFields(model, {
        composerTool: () =>
          model.composerTool === 'Attach' ? 'Closed' : 'Attach',
      }),
    }),
    ClickedVoice: () => ({
      model: modifyFields(model, {
        composerTool: () =>
          model.composerTool === 'Voice' ? 'Closed' : 'Voice',
      }),
    }),
    ClickedSend: () => ({
      model: modifyFields(model, {
        composerTool: () => (model.composerTool === 'Send' ? 'Closed' : 'Send'),
      }),
    }),
    ClickedAutoDelete: () => ({
      model: modifyFields(model, {
        autoDeleteOpen: () => !model.autoDeleteOpen,
      }),
    }),
    ClickedAutoDeleteChoice: ({ value }) => ({
      model: modifyFields(model, {
        autoDelete: () => value,
        autoDeleteOpen: () => false,
        headerMenuOpen: () => false,
      }),
    }),
    // NOTE: Mute, delete, and auto-delete stay in this tab. They do not call Telegram.
    ClickedMute: () => ({
      model: modifyFields(model, {
        mutedChatIds: () =>
          Option.match(model.maybeOpenChatId, {
            onNone: () => model.mutedChatIds,
            onSome: id =>
              model.mutedChatIds.includes(id)
                ? Array.filter(model.mutedChatIds, mutedId => mutedId !== id)
                : Array.append(model.mutedChatIds, id),
          }),
        headerMenuOpen: () => false,
      }),
    }),
    ClickedDeleteChat: () => ({
      model: modifyFields(model, {
        hiddenChatIds: () =>
          Option.match(model.maybeOpenChatId, {
            onNone: () => model.hiddenChatIds,
            onSome: id =>
              model.hiddenChatIds.includes(id)
                ? model.hiddenChatIds
                : Array.append(model.hiddenChatIds, id),
          }),
        maybeOpenChatId: () => Option.none(),
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
      }),
    }),
    ClickedDismissMenu: () => ({
      model: modifyFields(model, closedMenus),
    }),
    CompletedLoadAppCredentials: ({ credentials }) =>
      model.status === 'Busy' || credentials._tag === 'Absent'
        ? { model }
        : {
            model: modifyFields(model, {
              appCredentials: () => 'Supplied',
              apiId: () => credentials.apiId,
              apiHash: () => credentials.apiHash,
              status: () => 'Busy',
            }),
            commands: [
              Restore({
                apiId: credentials.apiId,
                apiHash: credentials.apiHash,
              }),
            ],
          },
    CompletedRestore: ({ accounts }) => {
      const first = accounts[0]
      if (first === undefined || model.login._tag !== 'Editing') {
        return { model: modifyFields(model, { status: () => 'Ready' }) }
      }
      return {
        model: modifyFields(model, {
          login: () => Login.Closed(),
          status: () => 'Busy',
          error: () => '',
          accounts: () => accounts,
          selectedAccountId: () => first.id,
        }),
        commands: [Refresh({ id: first.id })],
      }
    },
    SucceededAuthenticate: ({ result, sourceId }) => {
      if (
        sourceId !== '' &&
        (!('id' in model.login) || model.login.id !== sourceId)
      ) {
        return { model }
      }
      if (result._tag === 'Authorized') {
        return {
          model: modifyFields(model, {
            login: () => Login.Closed(),
            status: () => 'Busy',
            error: () => '',
            answer: () => Redacted.make(''),
            phone: () => Redacted.make(''),
            accounts: accounts => Array.append(accounts, result.account),
            selectedAccountId: () => result.account.id,
            query: () => '',
            draft: () => '',
            maybeOpenChatId: () => Option.none(),
            ...closedMenus,
          }),
          commands: [Refresh({ id: result.account.id })],
        }
      }
      if (result._tag === 'Qr') {
        if (model.login._tag === 'Closed') {
          return { model }
        }
        return {
          model: modifyFields(model, {
            login: () => Login.Qr(result),
            status: () => 'Ready',
            error: () => '',
          }),
        }
      }
      return {
        model: modifyFields(model, {
          login: () =>
            result._tag === 'Code'
              ? Login.Code(result)
              : Login.Password(result),
          status: () => 'Ready',
          error: () => '',
        }),
      }
    },
    FailedAuthenticate: ({ error, sourceId }) =>
      sourceId !== '' && (!('id' in model.login) || model.login.id !== sourceId)
        ? { model }
        : {
            model: modifyFields(model, {
              status: () => 'Ready',
              error: () => error,
            }),
          },
    SucceededRefresh: ({ account }) => ({
      model: modifyFields(model, {
        accounts: Array.map(current =>
          current.id === account.id ? account : current,
        ),
        status: () => 'Ready',
      }),
    }),
    FailedRefresh: () => ({
      model: modifyFields(model, {
        status: () => 'Ready',
        error: () => 'Could not load chats. Try refreshing again.',
      }),
    }),
    CompletedDisconnect: () => ({ model }),
  })
export const initialModel: Model = {
  login: Login.Editing(),
  appCredentials: 'Manual',
  apiId: '',
  apiHash: Redacted.make(''),
  phone: Redacted.make(''),
  countryIso: defaultCountryIso,
  countryOpen: false,
  keepSignedIn: true,
  answer: Redacted.make(''),
  status: 'Ready',
  error: '',
  accounts: [],
  selectedAccountId: '',
  query: '',
  draft: '',
  maybeOpenChatId: Option.none(),
  menuOpen: false,
  moreOpen: false,
  headerMenuOpen: false,
  composerTool: 'Closed',
  headerTool: 'Closed',
  autoDeleteOpen: false,
  autoDelete: 'Never',
  hiddenChatIds: [],
  mutedChatIds: [],
  faces: [],
  fixturePreview: false,
}
export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
  commands: [LoadAppCredentials()],
})

const showLogin = (model: Model): boolean =>
  model.login._tag !== 'Closed' || Array.isReadonlyArrayEmpty(model.accounts)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: '',
  body: h.div(
    [
      h.Class('app-wallpaper relative min-h-screen text-white'),
    ],
    [
      model.error === ''
        ? h.empty
        : h.p(
            [
              h.Role('alert'),
              h.Class(
                'absolute left-1/2 top-3 z-50 -translate-x-1/2 rounded-xl bg-[#3a2428] px-4 py-2 text-sm text-[#ffb4b4]',
              ),
            ],
            [model.error],
          ),
      showLogin(model) ? loginScreen(model, h) : chatShell(model, h),
    ],
  ),
})

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  qr: entry(
    { id: Schema.String },
    {
      modelToDependencies: model => ({
        id:
          model.fixturePreview ||
          (model.login._tag !== 'Qr' &&
            model.login._tag !== 'Code' &&
            model.login._tag !== 'Password')
            ? ''
            : model.login.id,
      }),
      dependenciesToStream: ({ id }) =>
        id === ''
          ? Stream.empty
          : Stream.fromEffectSchedule(
              Effect.sleep('2 seconds').pipe(
                Effect.andThen(Effect.tryPromise(() => pollAccount(id))),
                Effect.map(result =>
                  Message.SucceededAuthenticate({ result, sourceId: id }),
                ),
                Effect.catch(error =>
                  Effect.succeed(
                    Message.FailedAuthenticate({
                      error: loginError(error.cause),
                      sourceId: id,
                    }),
                  ),
                ),
              ),
              Schedule.spaced('1 second'),
            ),
    },
  ),
}))
