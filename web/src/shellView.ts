import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import { HtmlBuilder } from 'foldkit/html'

import { faceFor, kindStatus, markFor, tintFor } from './chatFace'
import type { Chat } from './generated/core'
import {
  attachIcon,
  emojiIcon,
  moreIcon,
  phoneIcon,
  searchIcon,
  sendIcon,
  voiceIcon,
} from './icons'
import type { Model } from './main'
import { Message } from './message'

const fieldClass =
  'w-full rounded-full border border-[#8774e1]/40 bg-[#1c1c22] px-4 py-2.5 text-[15px] text-white outline-none placeholder:text-[#9a9aa8]'

const panelClass = 'relative bg-[#1c1c22] md:rounded-2xl'

const listHidden = (open: boolean): string => (open ? 'hidden md:flex' : 'flex')

const paneHidden = (open: boolean): string => (open ? 'flex' : 'hidden md:flex')

const menuItemClass =
  'flex w-full items-center gap-3 px-3 py-2 text-left text-[15px] hover:bg-white/10'

const selectedAccount = (model: Model) =>
  Array.findFirst(
    model.accounts,
    account => account.id === model.selectedAccountId,
  )

const accountChats = (model: Model): ReadonlyArray<Chat> =>
  Option.match(selectedAccount(model), {
    onNone: () => [],
    onSome: account => account.chats,
  })

const shownChats = (model: Model): ReadonlyArray<Chat> => {
  const needle = model.query.trim().toLowerCase()
  return Array.filter(
    accountChats(model),
    chat =>
      !model.hiddenChatIds.includes(chat.id) &&
      (needle === '' || chat.title.toLowerCase().includes(needle)),
  )
}

const openChat = (model: Model): Option.Option<Chat> =>
  Option.flatMap(model.maybeOpenChatId, id =>
    Array.findFirst(
      accountChats(model),
      chat => chat.id === id && !model.hiddenChatIds.includes(chat.id),
    ),
  )

const receipt = (
  unread: number,
  mark: 'none' | 'sent' | 'read',
  h: HtmlBuilder<Message>,
) => {
  if (unread > 0) {
    return h.div(
      [
        h.Class(
          'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[#8774e1] px-1.5 text-[11px] font-medium text-white',
        ),
      ],
      [String(unread)],
    )
  }
  if (mark === 'read') {
    return h.div(
      [
        h.Class(
          'shrink-0 text-base font-semibold tracking-[-0.12em] text-[#4fc3f7]',
        ),
      ],
      ['✓✓'],
    )
  }
  if (mark === 'sent') {
    return h.div(
      [h.Class('shrink-0 text-base font-semibold text-[#c8c8d0]')],
      ['✓'],
    )
  }
  return h.empty
}

const menuButton = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
  className = menuItemClass,
) => h.button([h.Class(className), h.OnClick(message)], [label])

const iconButton = (
  label: string,
  pressed: boolean,
  message: Message,
  icon: ReturnType<HtmlBuilder<Message>['span']>,
  h: HtmlBuilder<Message>,
) =>
  h.button(
    [
      h.Class(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[#d7d7e0] hover:bg-white/10',
      ),
      h.AriaLabel(label),
      h.AriaPressed(pressed ? 'true' : 'false'),
      h.OnClick(message),
    ],
    [icon],
  )

export const chatShell = (model: Model, h: HtmlBuilder<Message>) => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)
  const chats = shownChats(model)
  const account = selectedAccount(model)

  return h.section(
    [h.Class('flex h-screen gap-2 px-2 py-5'), h.AriaLabel('Telegram chats')],
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
              h.div(
                [h.Class('relative')],
                [
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
                          h.div(
                            [h.Class('flex items-center gap-3 px-3 py-2')],
                            [
                              h.div(
                                [
                                  h.Class(
                                    'flex size-9 items-center justify-center rounded-full bg-[#8774e1] text-sm font-medium',
                                  ),
                                ],
                                [
                                  Option.match(account, {
                                    onNone: () => 'Y',
                                    onSome: current => markFor(current.title),
                                  }),
                                ],
                              ),
                              h.div(
                                [
                                  h.Class(
                                    'min-w-0 truncate text-[15px] font-medium',
                                  ),
                                ],
                                [
                                  Option.match(account, {
                                    onNone: () => 'You',
                                    onSome: current => current.title,
                                  }),
                                ],
                              ),
                            ],
                          ),
                          ...model.accounts
                            .filter(
                              current => current.id !== model.selectedAccountId,
                            )
                            .map(current =>
                              h.keyed('button')(
                                current.id,
                                [
                                  h.Class(menuItemClass),
                                  h.OnClick(
                                    Message.SelectedAccount({ id: current.id }),
                                  ),
                                ],
                                [current.title],
                              ),
                            ),
                          menuButton(
                            'Saved messages',
                            Message.ClickedDismissMenu(),
                            h,
                          ),
                          menuButton(
                            'Archived chats',
                            Message.ClickedDismissMenu(),
                            h,
                          ),
                          menuButton(
                            'Settings',
                            Message.ClickedDismissMenu(),
                            h,
                          ),
                          h.button(
                            [
                              h.Class(
                                'flex w-full items-center justify-between px-3 py-2 text-left text-[15px] hover:bg-white/10',
                              ),
                              h.AriaLabel('Add account'),
                              h.Disabled(model.status === 'Busy'),
                              h.OnClick(Message.ClickedAddAccount()),
                            ],
                            ['Add account'],
                          ),
                          h.button(
                            [
                              h.Class(menuItemClass),
                              h.AriaLabel('Refresh chats'),
                              h.Disabled(
                                model.status === 'Busy' ||
                                  model.selectedAccountId === '',
                              ),
                              h.OnClick(Message.ClickedRefresh()),
                            ],
                            ['Refresh chats'],
                          ),
                          h.div(
                            [h.Class('relative')],
                            [
                              h.button(
                                [
                                  h.Class(
                                    'flex w-full items-center justify-between px-3 py-2 text-left text-[15px] hover:bg-white/10',
                                  ),
                                  h.AriaLabel('More'),
                                  h.OnClick(Message.ClickedMore()),
                                ],
                                [
                                  'More',
                                  h.span([h.Class('text-[#9a9aa8]')], ['›']),
                                ],
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
                                      h.div(
                                        [h.Class('px-3 py-2 text-[15px]')],
                                        ['About this build'],
                                      ),
                                    ],
                                  )
                                : h.empty,
                            ],
                          ),
                        ],
                      )
                    : h.empty,
                ],
              ),
              h.input([
                h.Class(fieldClass),
                h.Type('search'),
                h.Placeholder('Search'),
                h.AriaLabel('Search chats'),
                h.Value(model.query),
                h.OnInput(value => Message.UpdatedQuery({ value })),
              ]),
            ],
          ),
          model.status === 'Busy'
            ? h.p(
                [h.Role('status'), h.Class('px-4 py-2 text-sm text-[#9a9aa8]')],
                ['Loading chats…'],
              )
            : h.empty,
          Array.match(chats, {
            onEmpty: () =>
              h.p([h.Class('px-4 py-6 text-sm text-[#9a9aa8]')], ['No chats']),
            onNonEmpty: items =>
              h.ul(
                [
                  h.Class(
                    'm-0 min-h-0 flex-1 list-none overflow-y-auto px-2 py-2',
                  ),
                ],
                items.map(chat => {
                  const face = faceFor(model.faces, chat.id)
                  const selected = Option.match(model.maybeOpenChatId, {
                    onNone: () => false,
                    onSome: id => id === chat.id,
                  })
                  const preview =
                    face.preview === '' ? kindStatus[chat.kind] : face.preview
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
                      h.div(
                        [h.Class('min-w-0 flex-1')],
                        [
                          h.div(
                            [
                              h.Class(
                                'flex items-baseline justify-between gap-3',
                              ),
                            ],
                            [
                              h.div(
                                [h.Class('truncate text-[15px] font-medium')],
                                [chat.title],
                              ),
                              h.div(
                                [h.Class('shrink-0 text-xs text-[#9a9aa8]')],
                                [
                                  model.mutedChatIds.includes(chat.id)
                                    ? 'Muted'
                                    : face.time,
                                ],
                              ),
                            ],
                          ),
                          h.div(
                            [
                              h.Class(
                                'flex items-center justify-between gap-3',
                              ),
                            ],
                            [
                              h.div(
                                [
                                  h.Class(
                                    'truncate text-[13px] text-[#9a9aa8]',
                                  ),
                                ],
                                [preview],
                              ),
                              receipt(face.unread, face.receipt, h),
                            ],
                          ),
                        ],
                      ),
                    ],
                  )
                }),
              ),
          }),
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
                    'flex flex-1 items-center justify-center text-sm text-[#9a9aa8]',
                  ),
                ],
                ['Select a chat'],
              ),
            onSome: chat => {
              const face = faceFor(model.faces, chat.id)
              const muted = model.mutedChatIds.includes(chat.id)
              return h.div(
                [h.Class('flex h-full w-full flex-col')],
                [
                  h.header(
                    [
                      h.Class(
                        'relative z-30 flex h-14 shrink-0 items-center gap-2 rounded-2xl bg-[#1c1c22] px-2',
                      ),
                    ],
                    [
                      h.button(
                        [
                          h.Class(
                            'rounded-full px-3 py-2 text-sm text-[#8774e1] md:hidden',
                          ),
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
                      h.div(
                        [h.Class('min-w-0 flex-1')],
                        [
                          h.div(
                            [h.Class('truncate text-[15px] font-semibold')],
                            [chat.title],
                          ),
                          h.div(
                            [h.Class('truncate text-[13px] text-[#8eb8d4]')],
                            [
                              muted
                                ? 'muted'
                                : chat.kind === 'Dialog'
                                  ? 'last seen recently'
                                  : kindStatus[chat.kind],
                            ],
                          ),
                        ],
                      ),
                      h.span(
                        [h.Class('flex shrink-0 items-center gap-0.5')],
                        [
                          iconButton(
                            'Search',
                            model.headerTool === 'Search',
                            Message.ClickedHeaderSearch(),
                            searchIcon(h),
                            h,
                          ),
                          iconButton(
                            'Call',
                            model.headerTool === 'Call',
                            Message.ClickedCall(),
                            phoneIcon(h),
                            h,
                          ),
                        ],
                      ),
                      h.button(
                        [
                          h.Class(
                            'relative flex size-9 shrink-0 items-center justify-center rounded-full text-[#d7d7e0] hover:bg-white/10',
                          ),
                          h.AriaLabel('Chat menu'),
                          h.OnClick(Message.ClickedHeaderMenu()),
                        ],
                        [moreIcon(h)],
                      ),
                      model.headerMenuOpen
                        ? h.div(
                            [
                              h.Class(
                                'absolute right-2 top-12 z-40 w-52 rounded-xl bg-[#2a2a32] py-1.5 shadow-2xl',
                              ),
                              h.Role('menu'),
                              h.AriaLabel('Chat menu'),
                            ],
                            [
                              h.div(
                                [h.Class('relative')],
                                [
                                  h.button(
                                    [
                                      h.Class(
                                        'flex w-full items-center justify-between px-3 py-2 text-left text-[15px] hover:bg-white/10',
                                      ),
                                      h.AriaLabel('Auto-delete'),
                                      h.OnClick(Message.ClickedAutoDelete()),
                                    ],
                                    [
                                      'Auto-delete',
                                      h.span(
                                        [h.Class('text-[#9a9aa8]')],
                                        [model.autoDelete],
                                      ),
                                    ],
                                  ),
                                  model.autoDeleteOpen
                                    ? h.div(
                                        [
                                          h.Class(
                                            'absolute right-full top-0 z-40 mr-2 w-40 rounded-xl bg-[#2a2a32] py-1.5 shadow-2xl',
                                          ),
                                          h.Role('menu'),
                                          h.AriaLabel('Auto-delete menu'),
                                        ],
                                        [
                                          'Never',
                                          '1 day',
                                          '1 week',
                                          '1 month',
                                          'Other',
                                        ].map(label =>
                                          h.keyed('button')(
                                            label,
                                            [
                                              h.Class(
                                                'block w-full px-3 py-2 text-left text-[15px] hover:bg-white/10',
                                              ),
                                              h.OnClick(
                                                Message.ClickedAutoDeleteChoice(
                                                  {
                                                    value: label,
                                                  },
                                                ),
                                              ),
                                            ],
                                            [label],
                                          ),
                                        ),
                                      )
                                    : h.empty,
                                ],
                              ),
                              h.button(
                                [
                                  h.Class(
                                    'block w-full px-3 py-2 text-left text-[15px] hover:bg-white/10',
                                  ),
                                  h.OnClick(Message.ClickedMute()),
                                ],
                                [muted ? 'Unmute' : 'Mute'],
                              ),
                              h.button(
                                [
                                  h.Class(
                                    'block w-full px-3 py-2 text-left text-[15px] text-[#e25c5c] hover:bg-white/10',
                                  ),
                                  h.OnClick(Message.ClickedDeleteChat()),
                                ],
                                ['Delete chat'],
                              ),
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                  Array.match(face.lines, {
                    onEmpty: () =>
                      h.div(
                        [
                          h.Class(
                            'flex min-h-0 flex-1 items-center justify-center text-sm text-[#9a9aa8]',
                          ),
                        ],
                        ['No messages yet'],
                      ),
                    onNonEmpty: lines =>
                      h.div(
                        [
                          h.Class(
                            'flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto px-4 py-3',
                          ),
                        ],
                        lines.map(line =>
                          h.div(
                            [
                              h.Class(
                                `flex ${line.mine ? 'justify-end' : 'justify-start'}`,
                              ),
                            ],
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
                                  ? [
                                      line.text,
                                      h.span(
                                        [
                                          h.Class(
                                            'ml-3 align-bottom text-[11px] text-white/70',
                                          ),
                                        ],
                                        [line.time],
                                      ),
                                    ]
                                  : [
                                      h.div(
                                        [
                                          h.Class(
                                            'mb-1.5 overflow-hidden rounded-xl',
                                          ),
                                        ],
                                        [
                                          h.div(
                                            [
                                              h.Class(
                                                'flex h-36 items-end bg-gradient-to-br from-[#3a2f63] to-[#1c2438] px-3 py-2 text-sm text-white/80',
                                              ),
                                            ],
                                            [line.caption],
                                          ),
                                        ],
                                      ),
                                      h.div([h.Class('px-0.5')], [line.text]),
                                      h.span(
                                        [
                                          h.Class(
                                            'ml-3 align-bottom text-[11px] text-white/70',
                                          ),
                                        ],
                                        [line.time],
                                      ),
                                    ],
                              ),
                            ],
                          ),
                        ),
                      ),
                  }),
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
                        [
                          h.Class(
                            'flex w-full shrink-0 items-center gap-0.5 rounded-full bg-[#1c1c22] px-1.5',
                          ),
                        ],
                        [
                          iconButton(
                            'Emoji',
                            model.composerTool === 'Emoji',
                            Message.ClickedEmoji(),
                            emojiIcon(h),
                            h,
                          ),
                          h.input([
                            h.Class(
                              'min-w-0 flex-1 bg-transparent px-2 py-2.5 text-[15px] text-white outline-none placeholder:text-[#9a9aa8]',
                            ),
                            h.Type('text'),
                            h.Placeholder('Message'),
                            h.AriaLabel('Message'),
                            h.Value(model.draft),
                            h.OnInput(value => Message.UpdatedDraft({ value })),
                          ]),
                          iconButton(
                            'Attach',
                            model.composerTool === 'Attach',
                            Message.ClickedAttach(),
                            attachIcon(h),
                            h,
                          ),
                          model.draft.trim() === ''
                            ? iconButton(
                                'Voice message',
                                model.composerTool === 'Voice',
                                Message.ClickedVoice(),
                                voiceIcon(h),
                                h,
                              )
                            : iconButton(
                                'Send',
                                model.composerTool === 'Send',
                                Message.ClickedSend(),
                                sendIcon(h),
                                h,
                              ),
                        ],
                      ),
                ],
              )
            },
          }),
        ],
      ),
    ],
  )
}
