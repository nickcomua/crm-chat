import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Runtime, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { faceFor, fixtureChats, markFor } from './fixture'
import type { Chat, ChatKind } from './generated/core'

const kindTint: Record<ChatKind, string> = {
  Dialog: 'bg-[#5288c1]',
  Group: 'bg-[#3e9e6a]',
  Channel: 'bg-[#c47a2c]',
}

const kindStatus: Record<ChatKind, string> = {
  Dialog: 'personal chat',
  Group: 'group',
  Channel: 'channel',
}

export const Model = Schema.Struct({
  maybeOpenChatId: Schema.Option(Schema.String),
  query: Schema.String,
  draft: Schema.String,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedChat: { id: Schema.String },
  ClickedBack: {},
  ChangedQuery: { value: Schema.String },
  ChangedDraft: { value: Schema.String },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ClickedChat: ({ id }) => ({
      model: modifyFields(model, {
        maybeOpenChatId: () => Option.some(id),
        draft: () => '',
      }),
    }),
    ClickedBack: () => ({
      model: modifyFields(model, { maybeOpenChatId: () => Option.none() }),
    }),
    ChangedQuery: ({ value }) => ({
      model: modifyFields(model, { query: () => value }),
    }),
    ChangedDraft: ({ value }) => ({
      model: modifyFields(model, { draft: () => value }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { maybeOpenChatId: Option.none(), query: '', draft: '' },
})

const openChat = (model: Model): Option.Option<Chat> =>
  Option.flatMap(model.maybeOpenChatId, (id) =>
    Array.findFirst(fixtureChats, (chat) => chat.id === id),
  )

const shownChats = (query: string): ReadonlyArray<Chat> => {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return fixtureChats
  }
  return Array.filter(fixtureChats, (chat) => chat.title.toLowerCase().includes(needle))
}

const listHidden = (open: boolean): string => (open ? 'hidden md:flex' : 'flex')

const paneHidden = (open: boolean): string => (open ? 'flex' : 'hidden md:flex')

const fieldClass =
  'w-full rounded-full border border-[#8774e1]/40 bg-[#1c1c22] px-4 py-2.5 text-[15px] text-white outline-none placeholder:text-[#9a9aa8]'

const panelClass = 'overflow-hidden bg-[#1c1c22] md:rounded-2xl'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)
  const chats = shownChats(model.query)

  return {
    title: '',
    body: h.div(
      [h.Class('app-wallpaper flex h-screen gap-2 overflow-hidden p-2 text-white')],
      [
        h.aside(
          [
            h.Class(
              `${listHidden(isOpen)} ${panelClass} w-full shrink-0 flex-col md:w-[26rem]`,
            ),
          ],
          [
            h.div(
              [h.Class('px-3 pb-1 pt-3')],
              [
                h.input([
                  h.Class(fieldClass),
                  h.Type('search'),
                  h.Placeholder('Search'),
                  h.AriaLabel('Search chats'),
                  h.Value(model.query),
                  h.OnInput((value) => Message.ChangedQuery({ value })),
                ]),
              ],
            ),
            h.ul(
              [h.Class('m-0 min-h-0 flex-1 list-none overflow-y-auto px-2 py-2')],
              chats.map((chat) => {
                const face = faceFor(chat.id)
                const selected = Option.match(model.maybeOpenChatId, {
                  onNone: () => false,
                  onSome: (id) => id === chat.id,
                })
                return h.keyed('li')(
                  chat.id,
                  [
                    h.Class(
                      `flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 ${selected ? 'bg-[#5c4d86]' : 'hover:bg-white/5'}`,
                    ),
                    h.OnClick(Message.ClickedChat({ id: chat.id })),
                  ],
                  [
                    h.div(
                      [
                        h.Class(
                          `flex size-12 shrink-0 items-center justify-center rounded-full text-base font-medium text-white ${kindTint[chat.kind]}`,
                        ),
                      ],
                      [markFor(chat.title)],
                    ),
                    h.div([h.Class('min-w-0 flex-1')], [
                      h.div([h.Class('flex items-baseline justify-between gap-3')], [
                        h.div([h.Class('truncate text-[15px] font-medium')], [chat.title]),
                        h.div([h.Class('shrink-0 text-xs text-[#9a9aa8]')], [face.time]),
                      ]),
                      h.div([h.Class('truncate text-[13px] text-[#9a9aa8]')], [face.preview]),
                    ]),
                  ],
                )
              }),
            ),
          ],
        ),
        h.section(
          [
            h.Class(`${paneHidden(isOpen)} min-w-0 flex-1 flex-col items-start`),
            h.AriaLabel('Open chat'),
          ],
          [
            Option.match(opened, {
              onNone: () =>
                h.div(
                  [h.Class('flex flex-1 items-center justify-center text-sm text-[#9a9aa8]')],
                  ['Select a chat'],
                ),
              onSome: (chat) => {
                const face = faceFor(chat.id)
                return h.div(
                  [h.Class('flex h-full w-full max-w-[32rem] flex-col')],
                  [
                    h.header(
                      [
                        h.Class(
                          'flex h-14 shrink-0 items-center gap-3 rounded-2xl bg-[#1c1c22] px-3',
                        ),
                      ],
                      [
                        h.button(
                          [
                            h.Class('rounded-full px-3 py-2 text-sm text-[#8774e1] md:hidden'),
                            h.OnClick(Message.ClickedBack()),
                          ],
                          ['Back'],
                        ),
                        h.div(
                          [
                            h.Class(
                              `flex size-10 items-center justify-center rounded-full text-sm font-medium ${kindTint[chat.kind]}`,
                            ),
                          ],
                          [markFor(chat.title)],
                        ),
                        h.div([h.Class('min-w-0 flex-1')], [
                          h.div([h.Class('truncate text-[15px] font-semibold')], [chat.title]),
                          h.div(
                            [h.Class('truncate text-[13px] text-[#9a9aa8]')],
                            [kindStatus[chat.kind]],
                          ),
                        ]),
                      ],
                    ),
                    h.div(
                      [h.Class('flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto px-1 py-3')],
                      face.lines.map((line) =>
                        h.div(
                          [h.Class(`flex ${line.mine ? 'justify-end' : 'justify-start'}`)],
                          [
                            h.div(
                              [
                                h.Class(
                                  `w-fit max-w-[80%] rounded-2xl px-3 py-2 text-[15px] leading-5 ${
                                    line.mine
                                      ? 'rounded-br-md bg-[#8774e1]'
                                      : 'rounded-bl-md bg-[#2a2a32]'
                                  }`,
                                ),
                              ],
                              [
                                line.text,
                                h.span(
                                  [h.Class('ml-3 align-bottom text-[11px] text-white/70')],
                                  [line.time],
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    chat.kind === 'Channel'
                      ? h.div(
                          [
                            h.Class(
                              'flex h-12 shrink-0 items-center justify-center rounded-full bg-[#1c1c22] text-sm text-[#9a9aa8]',
                            ),
                          ],
                          ['Replies are off'],
                        )
                      : h.div(
                          [h.Class('shrink-0')],
                          [
                            h.input([
                              h.Class(fieldClass),
                              h.Type('text'),
                              h.Placeholder('Message'),
                              h.AriaLabel('Message'),
                              h.Value(model.draft),
                              h.OnInput((value) => Message.ChangedDraft({ value })),
                            ]),
                          ],
                        ),
                  ],
                )
              },
            }),
          ],
        ),
      ],
    ),
  }
}
