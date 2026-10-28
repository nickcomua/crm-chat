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
  'w-full rounded-full bg-[#242f3d] px-4 py-2.5 text-[15px] text-[#f5f5f5] outline-none placeholder:text-[#708499]'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)
  const chats = shownChats(model.query)

  return {
    title: '',
    body: h.div(
      [h.Class('flex h-screen overflow-hidden bg-[#0e1621] text-[#f5f5f5]')],
      [
        h.aside(
          [
            h.Class(
              `${listHidden(isOpen)} w-full shrink-0 flex-col bg-[#17212b] md:w-[22rem] md:border-r md:border-black/40 xl:w-[26rem]`,
            ),
          ],
          [
            h.div(
              [h.Class('px-3 py-3')],
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
              [h.Class('m-0 min-h-0 flex-1 list-none overflow-y-auto')],
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
                      `flex cursor-pointer items-center gap-3 px-3 py-2 ${selected ? 'bg-[#2b5278]' : 'hover:bg-[#202b36]'}`,
                    ),
                    h.OnClick(Message.ClickedChat({ id: chat.id })),
                  ],
                  [
                    h.div(
                      [
                        h.Class(
                          `flex size-14 shrink-0 items-center justify-center rounded-full text-lg font-medium text-white ${kindTint[chat.kind]}`,
                        ),
                      ],
                      [markFor(chat.title)],
                    ),
                    h.div([h.Class('min-w-0 flex-1')], [
                      h.div([h.Class('flex items-baseline justify-between gap-3')], [
                        h.div([h.Class('truncate text-[15px] font-medium')], [chat.title]),
                        h.div([h.Class('shrink-0 text-xs text-[#708499]')], [face.time]),
                      ]),
                      h.div([h.Class('truncate text-sm text-[#708499]')], [face.preview]),
                    ]),
                  ],
                )
              }),
            ),
          ],
        ),
        h.section(
          [
            h.Class(`${paneHidden(isOpen)} min-w-0 flex-1 flex-col`),
            h.AriaLabel('Open chat'),
          ],
          [
            Option.match(opened, {
              onNone: () =>
                h.div(
                  [
                    h.Class(
                      'chat-wallpaper flex flex-1 items-center justify-center text-sm text-[#708499]',
                    ),
                  ],
                  ['Select a chat'],
                ),
              onSome: (chat) => {
                const face = faceFor(chat.id)
                return h.div([h.Class('flex min-h-0 flex-1 flex-col')], [
                  h.header(
                    [
                      h.Class(
                        'flex h-14 shrink-0 items-center gap-3 border-b border-black/40 bg-[#17212b] px-2',
                      ),
                    ],
                    [
                      h.button(
                        [
                          h.Class('rounded-full px-3 py-2 text-sm text-[#5288c1] md:hidden'),
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
                      h.div([h.Class('min-w-0')], [
                        h.div([h.Class('truncate text-[15px] font-medium')], [chat.title]),
                        h.div([h.Class('truncate text-sm text-[#708499]')], [kindStatus[chat.kind]]),
                      ]),
                    ],
                  ),
                  h.div(
                    [
                      h.Class(
                        'chat-wallpaper flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-y-auto px-4 py-3',
                      ),
                    ],
                    face.lines.map((line) =>
                      h.div(
                        [h.Class(`flex ${line.mine ? 'justify-end' : 'justify-start'}`)],
                        [
                          h.div(
                            [
                              h.Class(
                                `w-fit max-w-[75%] px-3 py-1.5 text-[15px] leading-5 shadow-sm ${
                                  line.mine
                                    ? 'rounded-2xl rounded-br-md bg-[#2b5278]'
                                    : 'rounded-2xl rounded-bl-md bg-[#182533]'
                                }`,
                              ),
                            ],
                            [
                              line.text,
                              h.span(
                                [h.Class('ml-3 align-bottom text-[11px] text-[#8aa4b8]')],
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
                            'flex h-14 shrink-0 items-center justify-center bg-[#17212b] text-sm text-[#708499]',
                          ),
                        ],
                        ['Replies are off'],
                      )
                    : h.div(
                        [h.Class('flex h-14 shrink-0 items-center bg-[#17212b] px-3')],
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
                ])
              },
            }),
          ],
        ),
      ],
    ),
  }
}
