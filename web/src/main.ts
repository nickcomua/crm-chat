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
import { type ChatLine, StoredFace, deliverLive } from './chatFace'
import { countryByIso, defaultCountryIso, dialFor } from './countries'
import { Login } from './login'
import { loginScreen } from './loginView'
import { Message, RuntimeCredentials, Secret } from './message'
import { chatShell } from './shellView'
import { type LiveItem, clockTime } from './tdlibProtocol'
import {
  Account,
  accountFaces,
  beginLogin,
  closeTelegramChat,
  desktopFailure,
  loadAccount,
  loadMessages,
  loadSponsored,
  openTelegramChat,
  pollAccount,
  removeConnection,
  restoreAccounts,
  submitCode,
  submitPassword,
  takeIncoming,
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
  authEntry: Schema.Literals(['Qr', 'Phone']),
  theme: Schema.Literals(['Day', 'Night']),
  folder: Schema.Literals(['All', 'Personal', 'Groups', 'Channels']),
  passkeyNote: Schema.Boolean,
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
      Effect.map(accounts =>
        Message.CompletedRestore({
          accounts,
          faces: accounts.flatMap(account => accountFaces(account.id)),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.CompletedRestore({ accounts: [] })),
      ),
    ),
})
export const Refresh = Command.define('Refresh', {
  args: { id: Schema.String },
  messages: [Message.SucceededRefresh, Message.FailedRefresh],
  execute: ({ id }) =>
    Effect.tryPromise(() =>
      loadAccount(id).then(account => ({
        account,
        faces: accountFaces(id),
      })),
    ).pipe(
      Effect.map(({ account, faces }) =>
        Message.SucceededRefresh({ account, faces }),
      ),
      Effect.catch(() => Effect.succeed(Message.FailedRefresh())),
    ),
})
export const LoadHistory = Command.define('LoadHistory', {
  args: { accountId: Schema.String, chatId: Schema.String },
  messages: [Message.LoadedHistory],
  execute: ({ accountId, chatId }) =>
    Effect.tryPromise(() => loadMessages(accountId, chatId)).pipe(
      Effect.map(messages =>
        Message.LoadedHistory({
          id: chatId,
          lines: messages.flatMap(message =>
            message.text === ''
              ? []
              : [
                  {
                    id: message.id,
                    text: message.text,
                    mine: message.outgoing,
                    time: clockTime(message.date),
                  },
                ],
          ),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.LoadedHistory({ id: chatId, lines: [] })),
      ),
    ),
})
// openChat is required because supergroup and channel updates arrive only
// for chats TDLib considers open.
export const OpenChat = Command.define('OpenChat', {
  args: { accountId: Schema.String, chatId: Schema.String },
  messages: [Message.CompletedOpenChat],
  execute: ({ accountId, chatId }) =>
    Effect.tryPromise(() => openTelegramChat(accountId, chatId)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedOpenChat(),
        onFailure: () => Message.CompletedOpenChat(),
      }),
    ),
})
export const CloseChat = Command.define('CloseChat', {
  args: { accountId: Schema.String, chatId: Schema.String },
  messages: [Message.CompletedCloseChat],
  execute: ({ accountId, chatId }) =>
    Effect.tryPromise(() => closeTelegramChat(accountId, chatId)).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedCloseChat(),
        onFailure: () => Message.CompletedCloseChat(),
      }),
    ),
})
export const LoadSponsored = Command.define('LoadSponsored', {
  args: { accountId: Schema.String, chatId: Schema.String },
  messages: [Message.LoadedSponsored, Message.FailedSponsored],
  execute: ({ accountId, chatId }) =>
    Effect.tryPromise(() => loadSponsored(accountId, chatId)).pipe(
      Effect.map(page =>
        Message.LoadedSponsored({
          id: chatId,
          between: page.between,
          lines: page.messages.map(item => ({
            id: item.id,
            text: item.text,
            title: item.title,
            button: item.button,
            recommended: item.recommended,
            info: item.info,
          })),
        }),
      ),
      Effect.catch(() =>
        Effect.succeed(Message.FailedSponsored({ id: chatId })),
      ),
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
const mergeFaces = (
  current: ReadonlyArray<StoredFace>,
  incoming: ReadonlyArray<StoredFace>,
): Array<StoredFace> => {
  const next = [...current]
  for (const face of incoming) {
    const index = next.findIndex(item => item.id === face.id)
    const previous = index < 0 ? undefined : next[index]
    if (previous === undefined) {
      next.push(face)
      continue
    }
    next[index] = {
      ...previous,
      ...face,
      lines: face.lines.length > 0 ? face.lines : previous.lines,
    }
  }
  return next
}
const blankFace = (id: string): StoredFace => ({
  id,
  time: '',
  preview: '',
  unread: 0,
  receipt: 'none',
  lines: [],
})

const keptSponsored = (face: StoredFace) => ({
  ...(face.sponsored === undefined ? {} : { sponsored: face.sponsored }),
  ...(face.sponsoredBetween === undefined
    ? {}
    : { sponsoredBetween: face.sponsoredBetween }),
  ...(face.sponsoredLoaded === undefined
    ? {}
    : { sponsoredLoaded: face.sponsoredLoaded }),
})

const mergeLoaded = (
  face: StoredFace,
  lines: ReadonlyArray<ChatLine>,
): StoredFace => {
  const fetched = new Set(
    lines.flatMap(line => (line.id === undefined ? [] : [line.id])),
  )
  const extras = (face.pending ?? []).filter(
    line => line.id === undefined || !fetched.has(line.id),
  )
  return {
    id: face.id,
    time: face.time,
    preview: face.preview,
    unread: face.unread,
    receipt: face.receipt,
    lines: [...lines, ...extras],
    historyLoaded: true,
    ...keptSponsored(face),
  }
}

const withArrival = (
  face: StoredFace,
  incoming: ReadonlyArray<ChatLine>,
  open: boolean,
): StoredFace => {
  const delivered = deliverLive(face, incoming)
  const latest = incoming[incoming.length - 1]
  const unreadAdded = open
    ? 0
    : incoming.filter(line => !line.mine).length
  return {
    id: face.id,
    time:
      latest !== undefined && latest.time !== '' ? latest.time : face.time,
    preview: latest === undefined ? face.preview : latest.text,
    unread: face.unread + unreadAdded,
    receipt: face.receipt,
    lines: delivered.lines,
    ...(delivered.pending.length > 0 ? { pending: delivered.pending } : {}),
    ...(face.historyLoaded === undefined
      ? {}
      : { historyLoaded: face.historyLoaded }),
    ...keptSponsored(face),
  }
}

const realOpenChat = (
  model: Model,
): { accountId: string; chatId: string } | undefined => {
  if (model.fixturePreview || model.selectedAccountId === '') {
    return undefined
  }
  const chatId = Option.match(model.maybeOpenChatId, {
    onNone: () => '',
    onSome: id => id,
  })
  if (chatId === '') {
    return undefined
  }
  const face = model.faces.find(item => item.id === chatId)
  if (
    face !== undefined &&
    face.lines.length > 0 &&
    face.historyLoaded !== true
  ) {
    return undefined
  }
  return { accountId: model.selectedAccountId, chatId }
}

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
    ClickedPhoneForm: () => {
      if (model.status === 'Busy') {
        return { model }
      }
      const next = modifyFields(model, {
        authEntry: () => 'Phone',
        passkeyNote: () => false,
        error: () => '',
        login: () =>
          model.login._tag === 'Qr' ? Login.Editing() : model.login,
      })
      if (!model.fixturePreview && model.login._tag === 'Qr') {
        return { model: next, commands: [Disconnect({ id: model.login.id })] }
      }
      return { model: next }
    },
    ClickedPasskey: () => ({
      model: modifyFields(model, { passkeyNote: () => true }),
    }),
    ClickedTheme: () => {
      const theme = model.theme === 'Day' ? 'Night' : 'Day'
      try {
        localStorage.setItem(
          'crm-chat.theme',
          theme === 'Night' ? 'Dark' : 'Light',
        )
      } catch {
        // The toggle still applies to this view when storage is blocked.
      }
      return { model: modifyFields(model, { theme: () => theme }) }
    },
    ClickedFolder: ({ folder }) => ({
      model: modifyFields(model, {
        folder: () => folder,
        maybeOpenChatId: () => Option.none(),
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
    ClickedQrLogin: () =>
      startLogin(
        modifyFields(model, {
          authEntry: () => 'Qr',
          passkeyNote: () => false,
        }),
        true,
      ),
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
    ClickedAddAccount: () => {
      if (model.status === 'Busy') {
        return { model }
      }
      const next = modifyFields(model, {
        login: () => Login.Editing(),
        authEntry: () => 'Qr',
        passkeyNote: () => false,
        error: () => '',
        ...closedMenus,
      })
      if (model.fixturePreview || model.appCredentials !== 'Supplied') {
        return { model: next }
      }
      return startLogin(next, true)
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
    SelectedAccount: ({ id }) => {
      const closing = realOpenChat(model)
      return {
        model: modifyFields(model, {
          selectedAccountId: () => id,
          query: () => '',
          draft: () => '',
          maybeOpenChatId: () => Option.none(),
          ...closedMenus,
        }),
        ...(closing === undefined ? {} : { commands: [CloseChat(closing)] }),
      }
    },
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
    ClickedChat: ({ id }) => {
      const face = model.faces.find(item => item.id === id)
      const fixtureLines =
        face !== undefined &&
        face.lines.length > 0 &&
        face.historyLoaded !== true
      const previous = realOpenChat(model)
      const closePrevious =
        previous !== undefined && previous.chatId !== id
          ? CloseChat(previous)
          : undefined
      const next = modifyFields(model, {
        maybeOpenChatId: () => Option.some(id),
        draft: () => '',
        ...closedMenus,
      })
      if (
        model.fixturePreview ||
        model.selectedAccountId === '' ||
        fixtureLines
      ) {
        return {
          model: next,
          ...(closePrevious === undefined
            ? {}
            : { commands: [closePrevious] }),
        }
      }
      const account = model.accounts.find(
        item => item.id === model.selectedAccountId,
      )
      const chat = account?.chats.find(item => item.id === id)
      return {
        model: next,
        commands: [
          ...(closePrevious === undefined ? [] : [closePrevious]),
          OpenChat({
            accountId: model.selectedAccountId,
            chatId: id,
          }),
          ...(face?.historyLoaded === true
            ? []
            : [
                LoadHistory({
                  accountId: model.selectedAccountId,
                  chatId: id,
                }),
              ]),
          ...(chat?.kind === 'Channel' && face?.sponsoredLoaded !== true
            ? [
                LoadSponsored({
                  accountId: model.selectedAccountId,
                  chatId: id,
                }),
              ]
            : []),
        ],
      }
    },
    ClickedBack: () => {
      const closing = realOpenChat(model)
      return {
        model: modifyFields(model, {
          maybeOpenChatId: () => Option.none(),
          ...closedMenus,
        }),
        ...(closing === undefined ? {} : { commands: [CloseChat(closing)] }),
      }
    },
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
    ClickedDeleteChat: () => {
      const closing = realOpenChat(model)
      return {
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
        ...(closing === undefined ? {} : { commands: [CloseChat(closing)] }),
      }
    },
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
    CompletedRestore: ({ accounts, faces }) => {
      const first = accounts[0]
      if (first !== undefined && model.login._tag === 'Editing') {
        return {
          model: modifyFields(model, {
            login: () => Login.Closed(),
            // readAccount already filled these previews. Leaving status Busy
            // until a second Refresh kept the list on "Loading chats…" and
            // kind labels whenever that refresh never finished.
            status: () => 'Ready',
            error: () => '',
            accounts: () => accounts,
            selectedAccountId: () => first.id,
            faces: current =>
              faces === undefined ? current : mergeFaces(current, faces),
          }),
        }
      }
      if (
        first === undefined &&
        model.login._tag === 'Editing' &&
        model.authEntry === 'Qr' &&
        !model.fixturePreview &&
        model.appCredentials === 'Supplied' &&
        /^[1-9]\d*$/.test(model.apiId) &&
        /^[a-f\d]{32}$/i.test(Redacted.value(model.apiHash))
      ) {
        return {
          model: modifyFields(model, { status: () => 'Busy', error: () => '' }),
          commands: [
            BeginLogin({
              apiId: model.apiId,
              apiHash: model.apiHash,
              phone: phoneForLogin(model),
              qr: true,
            }),
          ],
        }
      }
      return { model: modifyFields(model, { status: () => 'Ready' }) }
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
            faces: current =>
              result.faces === undefined
                ? current
                : mergeFaces(current, result.faces),
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
    SucceededRefresh: ({ account, faces }) => ({
      model: modifyFields(model, {
        accounts: Array.map(current =>
          current.id === account.id ? account : current,
        ),
        status: () => 'Ready',
        faces: current =>
          faces === undefined ? current : mergeFaces(current, faces),
      }),
    }),
    LoadedHistory: ({ id, lines }) => ({
      model: modifyFields(model, {
        faces: current => {
          const index = current.findIndex(face => face.id === id)
          const previous = index < 0 ? blankFace(id) : current[index]
          if (previous === undefined) {
            return current
          }
          const merged = mergeLoaded(previous, lines)
          if (index < 0) {
            return [...current, merged]
          }
          return current.map(face => (face.id === id ? merged : face))
        },
      }),
    }),
    ArrivedMessages: ({ accountId, items }) => {
      if (accountId !== model.selectedAccountId || items.length === 0) {
        return { model }
      }
      const openId = Option.match(model.maybeOpenChatId, {
        onNone: () => '',
        onSome: id => id,
      })
      const grouped = new Map<string, Array<ChatLine>>()
      for (const item of items) {
        if (item.text === '') {
          continue
        }
        const line: ChatLine = {
          id: item.id,
          text: item.text,
          mine: item.outgoing,
          time: clockTime(item.date),
        }
        const list = grouped.get(item.chatId)
        if (list === undefined) {
          grouped.set(item.chatId, [line])
        } else {
          list.push(line)
        }
      }
      if (grouped.size === 0) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          faces: current => {
            const next = [...current]
            for (const [chatId, lines] of grouped) {
              const index = next.findIndex(face => face.id === chatId)
              const previous = index < 0 ? blankFace(chatId) : next[index]
              if (previous === undefined) {
                continue
              }
              const updated = withArrival(previous, lines, chatId === openId)
              if (index < 0) {
                next.push(updated)
              } else {
                next[index] = updated
              }
            }
            return next
          },
        }),
      }
    },
    LoadedSponsored: ({ id, between, lines }) => ({
      model: modifyFields(model, {
        faces: current => {
          const index = current.findIndex(face => face.id === id)
          const previous = index < 0 ? blankFace(id) : current[index]
          if (previous === undefined) {
            return current
          }
          const updated: StoredFace = {
            ...previous,
            sponsored: lines,
            sponsoredBetween: between,
            sponsoredLoaded: true,
          }
          if (index < 0) {
            return [...current, updated]
          }
          return current.map(face => (face.id === id ? updated : face))
        },
      }),
    }),
    FailedSponsored: () => ({ model }),
    CompletedOpenChat: () => ({ model }),
    CompletedCloseChat: () => ({ model }),
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
  authEntry: 'Qr',
  theme: 'Day',
  folder: 'All',
  passkeyNote: false,
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
const storedTheme = (): Model['theme'] => {
  try {
    return localStorage.getItem('crm-chat.theme') === 'Dark' ? 'Night' : 'Day'
  } catch {
    return 'Day'
  }
}

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: modifyFields(initialModel, { theme: () => storedTheme() }),
  commands: [LoadAppCredentials()],
})

const showLogin = (model: Model): boolean =>
  model.login._tag !== 'Closed' || Array.isReadonlyArrayEmpty(model.accounts)

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: '',
  body: h.div(
    [
      h.Class(
        `app-wallpaper relative min-h-screen ${model.theme === 'Night' ? 'theme-night' : 'theme-day'}`,
      ),
    ],
    [
      h.button(
        [
          h.Class('tg-theme-toggle'),
          h.AriaLabel(
            model.theme === 'Night'
              ? 'Switch to day theme'
              : 'Switch to night theme',
          ),
          h.OnClick(Message.ClickedTheme()),
        ],
        [model.theme === 'Night' ? '☀' : '☾'],
      ),
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

const seenLiveIds = new Set<string>()
const liveTicks = { count: 0 }

const rememberSeen = (key: string): boolean => {
  if (seenLiveIds.has(key)) {
    return false
  }
  seenLiveIds.add(key)
  if (seenLiveIds.size > 500) {
    const oldest = seenLiveIds.values().next().value
    if (typeof oldest === 'string') {
      seenLiveIds.delete(oldest)
    }
  }
  return true
}

const pollLive = (
  accountId: string,
  chatId: string,
): Effect.Effect<Array<LiveItem>> =>
  Effect.gen(function* () {
    liveTicks.count += 1
    const tick = liveTicks.count
    const incoming = yield* Effect.tryPromise(() =>
      takeIncoming(accountId),
    ).pipe(Effect.catch(() => Effect.succeed<Array<LiveItem>>([])))
    const fresh = incoming.filter(
      item => item.text !== '' && rememberSeen(`${item.chatId}:${item.id}`),
    )
    if (chatId !== '' && tick % 3 === 0) {
      const history = yield* Effect.tryPromise(() =>
        loadMessages(accountId, chatId),
      ).pipe(
        Effect.catch(() => {
          const emptyHistory: Array<{
            id: string
            text: string
            outgoing: boolean
            date: number
          }> = []
          return Effect.succeed(emptyHistory)
        }),
      )
      for (const message of history) {
        if (
          message.text === '' ||
          !rememberSeen(`${chatId}:${message.id}`)
        ) {
          continue
        }
        fresh.push({
          chatId,
          id: message.id,
          text: message.text,
          outgoing: message.outgoing,
          date: message.date,
        })
      }
    }
    return fresh
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
              Effect.sleep('200 millis').pipe(
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
              Schedule.spaced('200 millis'),
            ),
    },
  ),
  live: entry(
    { accountId: Schema.String, chatId: Schema.String },
    {
      modelToDependencies: model => ({
        accountId:
          model.fixturePreview ||
          model.login._tag !== 'Closed' ||
          model.selectedAccountId === ''
            ? ''
            : model.selectedAccountId,
        chatId: Option.match(model.maybeOpenChatId, {
          onNone: () => '',
          onSome: id => id,
        }),
      }),
      dependenciesToStream: ({ accountId, chatId }) =>
        accountId === ''
          ? Stream.empty
          : Stream.fromEffectSchedule(
              pollLive(accountId, chatId),
              Schedule.spaced('750 millis'),
            ).pipe(
              Stream.filter(items => items.length > 0),
              Stream.map(items =>
                Message.ArrivedMessages({ accountId, items }),
              ),
            ),
    },
  ),
}))
