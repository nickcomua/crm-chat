import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Runtime, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { faceFor, fixtureChats, markFor, tintFor } from './fixture'
import type { Chat } from './generated/core'

const kindStatus: Record<'Dialog' | 'Group' | 'Channel', string> = {
  Dialog: 'personal chat',
  Group: 'group',
  Channel: 'channel',
}

export const Model = Schema.Struct({
  maybeOpenChatId: Schema.Option(Schema.String),
  query: Schema.String,
  draft: Schema.String,
  menuOpen: Schema.Boolean,
  moreOpen: Schema.Boolean,
  headerMenuOpen: Schema.Boolean,
  autoDeleteOpen: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedChat: { id: Schema.String },
  ClickedBack: {},
  ChangedQuery: { value: Schema.String },
  ChangedDraft: { value: Schema.String },
  ClickedMenu: {},
  ClickedMore: {},
  ClickedHeaderMenu: {},
  ClickedAutoDelete: {},
  ClickedDismissMenu: {},
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ClickedChat: ({ id }) => ({
      model: modifyFields(model, {
        maybeOpenChatId: () => Option.some(id),
        draft: () => '',
        menuOpen: () => false,
        moreOpen: () => false,
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
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
    ClickedAutoDelete: () => ({
      model: modifyFields(model, { autoDeleteOpen: () => !model.autoDeleteOpen }),
    }),
    ClickedDismissMenu: () => ({
      model: modifyFields(model, {
        menuOpen: () => false,
        moreOpen: () => false,
        headerMenuOpen: () => false,
        autoDeleteOpen: () => false,
      }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    maybeOpenChatId: Option.none(),
    query: '',
    draft: '',
    menuOpen: false,
    moreOpen: false,
    headerMenuOpen: false,
    autoDeleteOpen: false,
  },
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

const panelClass = 'relative bg-[#1c1c22] md:rounded-2xl'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)
  const chats = shownChats(model.query)

  return {
    title: '',
    body: h.div(
      [h.Class('app-wallpaper relative flex h-screen gap-2 px-2 py-5 text-white')],
      [
        h.aside(
          [
            h.Class(
              `${listHidden(isOpen)} ${panelClass} w-full shrink-0 flex-col md:w-[26rem]`,
            ),
          ],
          [
            h.div(
              [h.Class('flex items-center gap-2 px-3 pb-1 pt-3')],
              [
                h.div([h.Class('relative')], [
                  h.button(
                    [
                      h.Class(
                        'flex size-10 shrink-0 items-center justify-center rounded-full text-lg text-[#d7d7e0] hover:bg-white/5',
                      ),
                      h.AriaLabel('Menu'),
                      h.OnClick(Message.ClickedMenu()),
                    ],
                    ['☰'],
                  ),
                  model.menuOpen
                    ? h.div(
                        [
                          h.Class(
                            'absolute left-0 top-12 z-40 w-64 rounded-xl bg-[#2a2a32] py-2 shadow-2xl',
                          ),
                          h.Role('menu'),
                          h.AriaLabel('Menu'),
                        ],
                        [
                          h.div([h.Class('flex items-center gap-3 px-3 py-2')], [
                            h.div(
                              [
                                h.Class(
                                  'flex size-9 items-center justify-center rounded-full bg-[#8774e1] text-sm font-medium',
                                ),
                              ],
                              ['Y'],
                            ),
                            h.div([h.Class('text-[15px] font-medium')], ['You']),
                          ]),
                          h.button(
                            [
                              h.Class('flex w-full items-center gap-3 px-3 py-2 text-left text-[15px] hover:bg-white/10'),
                              h.OnClick(Message.ClickedDismissMenu()),
                            ],
                            ['Saved messages'],
                          ),
                          h.button(
                            [
                              h.Class('flex w-full items-center gap-3 px-3 py-2 text-left text-[15px] hover:bg-white/10'),
                              h.OnClick(Message.ClickedDismissMenu()),
                            ],
                            ['Archived chats'],
                          ),
                          h.button(
                            [
                              h.Class('flex w-full items-center gap-3 px-3 py-2 text-left text-[15px] hover:bg-white/10'),
                              h.OnClick(Message.ClickedDismissMenu()),
                            ],
                            ['Settings'],
                          ),
                          h.div([h.Class('relative')], [
                            h.button(
                              [
                                h.Class(
                                  'flex w-full items-center justify-between px-3 py-2 text-left text-[15px] hover:bg-white/10',
                                ),
                                h.AriaLabel('More'),
                                h.OnClick(Message.ClickedMore()),
                              ],
                              ['More', h.span([h.Class('text-[#9a9aa8]')], ['›'])],
                            ),
                            model.moreOpen
                              ? h.div(
                                  [
                                    h.Class(
                                      'absolute left-full top-0 z-40 ml-2 w-52 rounded-xl bg-[#2a2a32] py-2 shadow-2xl',
                                    ),
                                    h.Role('menu'),
                                    h.AriaLabel('More menu'),
                                  ],
                                  [
                                    h.div([h.Class('px-3 py-2 text-[15px]')], ['About this build']),
                                  ],
                                )
                              : h.div([h.Class('hidden')], []),
                          ]),
                        ],
                      )
                    : h.div([h.Class('hidden')], []),
                ]),
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
                          `flex size-12 shrink-0 items-center justify-center rounded-full text-base font-medium text-white ${tintFor(chat.kind)}`,
                        ),
                      ],
                      [markFor(chat.title)],
                    ),
                    h.div([h.Class('min-w-0 flex-1')], [
                      h.div([h.Class('flex items-baseline justify-between gap-3')], [
                        h.div([h.Class('truncate text-[15px] font-medium')], [chat.title]),
                        h.div([h.Class('shrink-0 text-xs text-[#9a9aa8]')], [face.time]),
                      ]),
                      h.div([h.Class('flex items-center justify-between gap-3')], [
                        h.div([h.Class('truncate text-[13px] text-[#9a9aa8]')], [face.preview]),
                        face.unread > 0
                          ? h.div(
                              [
                                h.Class(
                                  'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#8774e1] px-1.5 text-[11px] font-medium text-white',
                                ),
                              ],
                              [String(face.unread)],
                            )
                          : face.receipt === 'read'
                            ? h.div(
                                [h.Class('shrink-0 text-base font-semibold tracking-[-0.12em] text-[#4fc3f7]')],
                                ['✓✓'],
                              )
                            : face.receipt === 'sent'
                              ? h.div(
                                  [h.Class('shrink-0 text-base font-semibold text-[#c8c8d0]')],
                                  ['✓'],
                                )
                              : h.div([h.Class('shrink-0')], []),
                      ]),
                    ]),
                  ],
                )
              }),
            ),
          ],
        ),
        h.section(
          [
            h.Class(`${paneHidden(isOpen)} min-w-0 flex-1 flex-col items-center`),
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
                  [h.Class('flex h-full w-full max-w-md flex-col')],
                  [
                    h.header(
                      [h.Class('relative z-30 flex h-14 shrink-0 items-center gap-2 rounded-2xl bg-[#1c1c22] px-2')],
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
                              `flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-medium ${tintFor(chat.kind)}`,
                            ),
                          ],
                          [markFor(chat.title)],
                        ),
                        h.div([h.Class('min-w-0 flex-1')], [
                          h.div([h.Class('truncate text-[15px] font-semibold')], [chat.title]),
                          h.div(
                            [h.Class('truncate text-[13px] text-[#8eb8d4]')],
                            [chat.kind === 'Dialog' ? 'last seen recently' : kindStatus[chat.kind]],
                          ),
                        ]),
                        h.button(
                          [
                            h.Class('flex size-9 shrink-0 items-center justify-center rounded-full text-[#d7d7e0] hover:bg-white/10'),
                            h.AriaLabel('Call'),
                            h.OnClick(Message.ClickedHeaderMenu()),
                          ],
                          ['☎'],
                        ),
                        h.button(
                          [
                            h.Class('relative flex size-9 shrink-0 items-center justify-center rounded-full text-lg text-[#d7d7e0] hover:bg-white/10'),
                            h.AriaLabel('Chat menu'),
                            h.OnClick(Message.ClickedHeaderMenu()),
                          ],
                          ['⋮'],
                        ),
                        model.headerMenuOpen
                          ? h.div(
                              [
                                h.Class('absolute right-2 top-12 z-40 w-52 rounded-xl bg-[#2a2a32] py-1.5 shadow-2xl'),
                                h.Role('menu'),
                                h.AriaLabel('Chat menu'),
                              ],
                              [
                                h.div([h.Class('relative')], [
                                  h.button(
                                    [
                                      h.Class('flex w-full items-center justify-between px-3 py-2 text-left text-[15px] hover:bg-white/10'),
                                      h.AriaLabel('Auto-delete'),
                                      h.OnClick(Message.ClickedAutoDelete()),
                                    ],
                                    ['Auto-delete', h.span([h.Class('text-[#9a9aa8]')], ['›'])],
                                  ),
                                  model.autoDeleteOpen
                                    ? h.div(
                                        [
                                          h.Class('absolute right-full top-0 z-40 mr-2 w-40 rounded-xl bg-[#2a2a32] py-1.5 shadow-2xl'),
                                          h.Role('menu'),
                                          h.AriaLabel('Auto-delete menu'),
                                        ],
                                        ['Never', '1 day', '1 week', '1 month', 'Other'].map((label) =>
                                          h.button(
                                            [
                                              h.Class('block w-full px-3 py-2 text-left text-[15px] hover:bg-white/10'),
                                              h.OnClick(Message.ClickedDismissMenu()),
                                            ],
                                            [label],
                                          ),
                                        ),
                                      )
                                    : h.div([h.Class('hidden')], []),
                                ]),
                                h.button(
                                  [h.Class('block w-full px-3 py-2 text-left text-[15px] hover:bg-white/10'), h.OnClick(Message.ClickedDismissMenu())],
                                  ['Mute'],
                                ),
                                h.button(
                                  [h.Class('block w-full px-3 py-2 text-left text-[15px] hover:bg-white/10'), h.OnClick(Message.ClickedDismissMenu())],
                                  ['Call'],
                                ),
                                h.button(
                                  [h.Class('block w-full px-3 py-2 text-left text-[15px] text-[#e25c5c] hover:bg-white/10'), h.OnClick(Message.ClickedDismissMenu())],
                                  ['Delete chat'],
                                ),
                              ],
                            )
                          : h.div([h.Class('hidden')], []),
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
                              line.caption === undefined
                                ? [line.text, h.span([h.Class('ml-3 align-bottom text-[11px] text-white/70')], [line.time])]
                                : [
                                    h.div([h.Class('mb-1.5 overflow-hidden rounded-xl')], [
                                      h.div(
                                        [
                                          h.Class(
                                            'flex h-36 items-end bg-gradient-to-br from-[#3a2f63] to-[#1c2438] px-3 py-2 text-sm text-white/80',
                                          ),
                                        ],
                                        [line.caption],
                                      ),
                                    ]),
                                    h.div([h.Class('px-0.5')], [line.text]),
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
