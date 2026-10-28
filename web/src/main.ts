import * as Array from 'effect/Array'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { Command, Runtime, Subscription, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import * as BrowserCrypto from '@effect/platform-browser/BrowserCrypto'

import {
  Account,
  AuthResult,
  beginLogin,
  loadAccount,
  pollQr,
  removeConnection,
  submitCode,
  submitPassword,
} from './telegram'

const Secret = Schema.Redacted(Schema.String)
const Login = defineTaggedUnion({
  Editing: {},
  Closed: {},
  Code: { id: Schema.String },
  Password: { id: Schema.String },
  Qr: { id: Schema.String, image: Schema.String },
})
export const Model = Schema.Struct({
  login: Login,
  apiId: Schema.String,
  apiHash: Secret,
  phone: Secret,
  answer: Secret,
  status: Schema.Literals(['Ready', 'Busy']),
  error: Schema.String,
  accounts: Schema.Array(Account),
  selectedAccountId: Schema.String,
  query: Schema.String,
})
export type Model = typeof Model.Type
export const Message = defineMessageUnion({
  UpdatedApiId: { value: Schema.String },
  UpdatedApiHash: { value: Secret },
  UpdatedPhone: { value: Secret },
  UpdatedAnswer: { value: Secret },
  UpdatedQuery: { value: Schema.String },
  ClickedPhoneLogin: {},
  ClickedQrLogin: {},
  SubmittedAnswer: {},
  ClickedAddAccount: {},
  ClickedCancel: {},
  SelectedAccount: { id: Schema.String },
  ClickedRefresh: {},
  SucceededAuthenticate: { result: AuthResult, sourceId: Schema.String },
  FailedAuthenticate: { error: Schema.String, sourceId: Schema.String },
  SucceededRefresh: { account: Account },
  FailedRefresh: {},
  CompletedDisconnect: {},
})
export type Message = typeof Message.Type

const loginError = (error: unknown): string => {
  if (error instanceof Error) {
    if (error.message.includes('PHONE_CODE_INVALID')) {
      return 'The code is incorrect. Try again.'
    }
    if (error.message.includes('PHONE_CODE_EXPIRED')) {
      return 'The code expired. Cancel and start again.'
    }
    if (error.message.includes('PASSWORD_HASH_INVALID')) {
      return 'The password is incorrect. Try again.'
    }
    if (error.message.includes('FLOOD_WAIT')) {
      return 'Telegram requires a wait before trying again.'
    }
    if (error.message.includes('API_ID_INVALID')) {
      return 'Check your Telegram API ID and hash.'
    }
    if (error.message.includes('PHONE_NUMBER_INVALID')) {
      return 'Enter your phone number with its country code.'
    }
  }
  return 'Telegram could not complete the request. Retry or cancel and start again.'
}
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
const startLogin = (
  model: Model,
  qr: boolean,
): Update.Return<Model, Message> => {
  if (model.status === 'Busy' || model.login._tag !== 'Editing') {
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
        phone: model.phone,
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
    UpdatedAnswer: ({ value }) => ({
      model: modifyFields(model, { answer: () => value }),
    }),
    UpdatedQuery: ({ value }) => ({
      model: modifyFields(model, { query: () => value }),
    }),
    ClickedPhoneLogin: () => startLogin(model, false),
    ClickedQrLogin: () => startLogin(model, true),
    SubmittedAnswer: () => {
      if (
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
      })
      if (
        model.login._tag === 'Code' ||
        model.login._tag === 'Password' ||
        model.login._tag === 'Qr'
      ) {
        return { model: next, commands: [Disconnect({ id: model.login.id })] }
      }
      return { model: next }
    },
    SelectedAccount: ({ id }) => ({
      model: modifyFields(model, {
        selectedAccountId: () => id,
        query: () => '',
      }),
    }),
    ClickedRefresh: () =>
      model.status === 'Busy' || model.selectedAccountId === ''
        ? { model }
        : {
            model: modifyFields(model, {
              status: () => 'Busy',
              error: () => '',
            }),
            commands: [Refresh({ id: model.selectedAccountId })],
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
  apiId: '',
  apiHash: Redacted.make(''),
  phone: Redacted.make(''),
  answer: Redacted.make(''),
  status: 'Ready',
  error: '',
  accounts: [],
  selectedAccountId: '',
  query: '',
}
export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: initialModel,
})
const fieldClass =
  'w-full rounded-xl border border-white/20 bg-[#1c1c22] px-4 py-3 text-white'
const buttonClass =
  'rounded-xl bg-[#8774e1] px-4 py-3 text-white disabled:opacity-50'
const answerView = (model: Model, password: boolean, h: HtmlBuilder<Message>) =>
  h.div(
    [h.Class('flex flex-col gap-4')],
    [
      h.p(
        [],
        [
          password
            ? 'Enter your Telegram two-step verification password.'
            : 'Enter the login code Telegram sent to your app or phone.',
        ],
      ),
      h.input([
        h.Class(fieldClass),
        h.Type('password'),
        h.AriaLabel(password ? '2FA password' : 'Login code'),
        h.Value(Redacted.value(model.answer)),
        h.Disabled(model.status === 'Busy'),
        h.OnInput(value =>
          Message.UpdatedAnswer({ value: Redacted.make(value) }),
        ),
      ]),
      h.button(
        [
          h.Class(buttonClass),
          h.Disabled(model.status === 'Busy'),
          h.OnClick(Message.SubmittedAnswer()),
        ],
        ['Continue'],
      ),
    ],
  )
const loginView = (model: Model, h: HtmlBuilder<Message>) => {
  const disabled = model.status === 'Busy'
  return h.section(
    [
      h.Class(
        'flex w-full max-w-md flex-col gap-4 rounded-2xl bg-[#23232b] p-6',
      ),
      h.AriaLabel('Telegram login'),
    ],
    [
      h.h1([h.Class('text-xl')], ['Attach Telegram account']),
      Login.match(model.login, {
        Closed: () => h.empty,
        Editing: () =>
          h.div(
            [h.Class('flex flex-col gap-4')],
            [
              h.p(
                [],
                [
                  'Use your application credentials from my.telegram.org. Accounts remain connected for this tab; reloading signs this shell out.',
                ],
              ),
              h.input([
                h.Class(fieldClass),
                h.AriaLabel('API ID'),
                h.Placeholder('API ID'),
                h.Value(model.apiId),
                h.Disabled(disabled),
                h.OnInput(value => Message.UpdatedApiId({ value })),
              ]),
              h.input([
                h.Class(fieldClass),
                h.Type('password'),
                h.AriaLabel('API hash'),
                h.Placeholder('API hash'),
                h.Value(Redacted.value(model.apiHash)),
                h.Disabled(disabled),
                h.OnInput(value =>
                  Message.UpdatedApiHash({ value: Redacted.make(value) }),
                ),
              ]),
              h.input([
                h.Class(fieldClass),
                h.Type('tel'),
                h.AriaLabel('Phone number'),
                h.Placeholder('+31 …'),
                h.Value(Redacted.value(model.phone)),
                h.Disabled(disabled),
                h.OnInput(value =>
                  Message.UpdatedPhone({ value: Redacted.make(value) }),
                ),
              ]),
              h.button(
                [
                  h.Class(buttonClass),
                  h.Disabled(disabled),
                  h.OnClick(Message.ClickedPhoneLogin()),
                ],
                ['Log in with phone'],
              ),
              h.button(
                [
                  h.Class(buttonClass),
                  h.Disabled(disabled),
                  h.OnClick(Message.ClickedQrLogin()),
                ],
                ['Log in with QR'],
              ),
            ],
          ),
        Code: () => answerView(model, false, h),
        Password: () => answerView(model, true, h),
        Qr: ({ image }) =>
          h.div(
            [],
            [
              h.p(
                [],
                [
                  'In Telegram on your phone, open Settings → Devices → Link Desktop Device and scan this code.',
                ],
              ),
              h.img([
                h.Src(image),
                h.Alt('Telegram login QR code'),
                h.Class('mx-auto my-4 w-64'),
              ]),
            ],
          ),
      }),
      model.login._tag !== 'Editing' ||
      Array.isReadonlyArrayNonEmpty(model.accounts)
        ? h.button(
            [h.Disabled(disabled), h.OnClick(Message.ClickedCancel())],
            ['Cancel'],
          )
        : h.empty,
      disabled ? h.p([h.Role('status')], ['Connecting to Telegram…']) : h.empty,
    ],
  )
}
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: '',
  body: h.main(
    [
      h.Class(
        'app-wallpaper flex min-h-screen flex-col items-center gap-4 p-6 text-white',
      ),
    ],
    [
      model.error === '' ? h.empty : h.p([h.Role('alert')], [model.error]),
      model.login._tag === 'Closed' ? h.empty : loginView(model, h),
      Array.isReadonlyArrayEmpty(model.accounts)
        ? h.empty
        : h.section(
            [
              h.Class('w-full max-w-2xl rounded-2xl bg-[#1c1c22] p-4'),
              h.AriaLabel('Telegram chats'),
            ],
            [
              h.nav(
                [h.AriaLabel('Accounts'), h.Class('flex flex-wrap gap-3')],
                model.accounts.map(account =>
                  h.keyed('button')(
                    account.id,
                    [
                      h.Class(buttonClass),
                      h.AriaPressed(
                        String(model.selectedAccountId === account.id),
                      ),
                      h.OnClick(Message.SelectedAccount({ id: account.id })),
                    ],
                    [account.title],
                  ),
                ),
              ),
              h.div(
                [h.Class('my-4 flex gap-4')],
                [
                  h.button(
                    [
                      h.OnClick(Message.ClickedAddAccount()),
                      h.Disabled(
                        model.status === 'Busy' ||
                          model.login._tag !== 'Closed',
                      ),
                    ],
                    ['Add account'],
                  ),
                  h.button(
                    [
                      h.OnClick(Message.ClickedRefresh()),
                      h.Disabled(
                        model.status === 'Busy' ||
                          model.login._tag !== 'Closed',
                      ),
                    ],
                    ['Refresh chats'],
                  ),
                ],
              ),
              h.input([
                h.Class(fieldClass),
                h.Type('search'),
                h.AriaLabel('Search chats'),
                h.Value(model.query),
                h.OnInput(value => Message.UpdatedQuery({ value })),
              ]),
              h.ul(
                [h.Class('mt-4 divide-y divide-white/10')],
                model.accounts
                  .filter(account => account.id === model.selectedAccountId)
                  .flatMap(account => account.chats)
                  .filter(chat =>
                    chat.title
                      .toLowerCase()
                      .includes(model.query.toLowerCase()),
                  )
                  .map(chat =>
                    h.keyed('li')(
                      chat.id,
                      [h.Class('flex justify-between gap-4 py-4')],
                      [
                        h.span([], [chat.title]),
                        h.span([h.Class('text-[#b8a8ff]')], [chat.kind]),
                      ],
                    ),
                  ),
              ),
            ],
          ),
    ],
  ),
})

export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  qr: entry(
    { id: Schema.String },
    {
      modelToDependencies: model => ({
        id: model.login._tag === 'Qr' ? model.login.id : '',
      }),
      dependenciesToStream: ({ id }) =>
        id === ''
          ? Stream.empty
          : Stream.fromEffectSchedule(
              Effect.sleep('2 seconds').pipe(
                Effect.andThen(Effect.tryPromise(() => pollQr(id))),
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
