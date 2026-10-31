import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import { HtmlBuilder } from 'foldkit/html'

import {
  faceFor,
  kindStatus,
  markFor,
  threadEntries,
  tintFor,
} from './chatFace'
import type { ThreadEntry } from './chatFace'
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

const folders = ['All', 'Personal', 'Groups', 'Channels'] as const

const folderFor = (kind: Chat['kind']): 'Personal' | 'Groups' | 'Channels' =>
  kind === 'Group' ? 'Groups' : kind === 'Channel' ? 'Channels' : 'Personal'

const listHidden = (open: boolean): string => (open ? 'hidden md:flex' : 'flex')

const paneHidden = (open: boolean): string => (open ? 'flex' : 'hidden md:flex')

const bubbleClass = (mine: boolean, tail: boolean): string =>
  `tg-bubble ${mine ? 'tg-bubble-out' : 'tg-bubble-in'} ${
    tail ? (mine ? 'tg-bubble-tail-out' : 'tg-bubble-tail-in') : ''
  }`

const messageTail = <Message>(mine: boolean, h: HtmlBuilder<Message>) =>
  h.span([
    h.AriaHidden(true),
    h.Class(mine ? 'bubble-tail bubble-tail-out' : 'bubble-tail bubble-tail-in'),
  ])

const menuItemClass = 'tg-menu-item'

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
      (model.folder === 'All' || folderFor(chat.kind) === model.folder) &&
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
        h.Class('tg-unread'),
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
      h.Class('tg-icon-button'),
      h.AriaLabel(label),
      h.AriaPressed(pressed ? 'true' : 'false'),
      h.OnClick(message),
    ],
    [icon],
  )

const messageColumn = (
  entries: ReadonlyArray<ThreadEntry>,
  h: HtmlBuilder<Message>,
) => {
  if (entries.length === 0) {
    return h.div(
      [
        h.Class(
          'flex min-h-0 flex-1 items-center justify-center text-sm text-[#9a9aa8]',
        ),
      ],
      ['No messages yet'],
    )
  }
  return h.div(
    [
      h.Class(
        'flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-4 py-3',
      ),
    ],
    entries.map((entry, index) => {
      if (entry.kind === 'sponsored') {
        const label = entry.line.recommended ? 'Recommended' : 'Sponsored'
        return h.keyed('div')(
          entry.key,
          [
            h.Class(
              `flex justify-center ${index === entries.length - 1 ? '' : 'mb-2'}`,
            ),
          ],
          [
            h.div(
              [h.Class('tg-sponsored'), h.Role('note'), h.AriaLabel(label)],
              [
                h.p([h.Class('tg-sponsored-label')], [label]),
                entry.line.title === ''
                  ? h.empty
                  : h.p(
                      [h.Class('tg-sponsored-title')],
                      [entry.line.title],
                    ),
                entry.line.text === ''
                  ? h.empty
                  : h.p([h.Class('tg-sponsored-text')], [entry.line.text]),
                entry.line.button === ''
                  ? h.empty
                  : h.span(
                      [h.Class('tg-sponsored-button')],
                      [entry.line.button],
                    ),
                entry.line.info === ''
                  ? h.empty
                  : h.p([h.Class('tg-sponsored-info')], [entry.line.info]),
              ],
            ),
          ],
        )
      }
      const line = entry.line
      const following = entries[index + 1]
      const tail =
        following === undefined ||
        following.kind !== 'message' ||
        following.line.mine !== line.mine
      const time = h.span([h.Class('bubble-time')], [line.time])
      return h.keyed('div')(
        entry.key,
        [
          h.Class(
            `flex ${line.mine ? 'justify-end' : 'justify-start'} ${
              index === entries.length - 1 ? '' : tail ? 'mb-2' : 'mb-0.5'
            }`,
          ),
        ],
        [
          h.div(
            [h.Class(bubbleClass(line.mine, tail))],
            line.caption === undefined
              ? [
                  line.text,
                  time,
                  tail ? messageTail(line.mine, h) : h.empty,
                ]
              : [
                  h.div(
                    [h.Class('mb-1.5 overflow-hidden rounded-xl')],
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
                  time,
                  tail ? messageTail(line.mine, h) : h.empty,
                ],
          ),
        ],
      )
    }),
  )
}

export const chatShell = (model: Model, h: HtmlBuilder<Message>) => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)
  const chats = shownChats(model)
  const account = selectedAccount(model)

  return h.section(
    [h.Class('tg-shell'), h.AriaLabel('Telegram chats')],
    [
      h.aside(
        [
          h.Class(
            `${listHidden(isOpen)} tg-panel tg-list w-full shrink-0 flex-col md:w-[22.5rem]`,
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
                      h.Class('tg-avatar-button'),
                      h.AriaLabel('Menu'),
                      h.OnClick(Message.ClickedMenu()),
                    ],
                    [
                      Option.match(account, {
                        onNone: () => 'Y',
                        onSome: current => markFor(current.title),
                      }),
                    ],
                  ),
                  model.menuOpen
                    ? h.div(
                        [
                          h.Class(
                            'tg-menu absolute left-0 top-12 z-40 w-64 py-2',
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
                                  h.Class('tg-avatar-button size-9 text-sm'),
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
                                'tg-menu-item justify-between',
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
                                  h.Class('tg-menu-item justify-between'),
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
                                        'tg-menu absolute left-full top-0 z-40 ml-2 w-52 py-2',
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
                h.Class('tg-search'),
                h.Type('search'),
                h.Placeholder('Search'),
                h.AriaLabel('Search chats'),
                h.Value(model.query),
                h.OnInput(value => Message.UpdatedQuery({ value })),
              ]),
            ],
          ),
          h.div(
            [h.Class('tg-folders'), h.Role('tablist'), h.AriaLabel('Chat folders')],
            folders.map(folder =>
              h.keyed('button')(
                folder,
                [
                  h.Class(
                    model.folder === folder
                      ? 'tg-folder tg-folder-active'
                      : 'tg-folder',
                  ),
                  h.Role('tab'),
                  h.AriaSelected(model.folder === folder),
                  h.OnClick(Message.ClickedFolder({ folder })),
                ],
                [folder],
              ),
            ),
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
                        selected ? 'chat-row chat-row-selected' : 'chat-row',
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
                                [h.Class('chat-row-meta shrink-0 text-xs')],
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
                                  h.Class('chat-row-meta truncate text-[13px]'),
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
                [h.Class('flex flex-1 items-center justify-center')],
                [
                  h.p(
                    [h.Class('tg-empty-pill')],
                    ['Select a chat to start messaging'],
                  ),
                ],
              ),
            onSome: chat => {
              const stored = model.faces.find(item => item.id === chat.id)
              const entries = threadEntries(
                stored?.lines ?? [],
                stored?.pending ?? [],
                stored?.sponsored ?? [],
                stored?.sponsoredBetween ?? 0,
              )
              const muted = model.mutedChatIds.includes(chat.id)
              return h.div(
                [h.Class('flex h-full w-full flex-col')],
                [
                  h.header(
                    [
                      h.Class(
                        'tg-header relative z-30 flex h-14 shrink-0 items-center gap-2 px-2',
                      ),
                    ],
                    [
                      h.button(
                        [
                          h.Class(
                            'rounded-full px-3 py-2 text-sm text-[var(--tg-primary)] md:hidden',
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
                          h.Class('tg-icon-button relative'),
                          h.AriaLabel('Chat menu'),
                          h.OnClick(Message.ClickedHeaderMenu()),
                        ],
                        [moreIcon(h)],
                      ),
                      model.headerMenuOpen
                        ? h.div(
                            [
                              h.Class(
                                'tg-menu absolute right-2 top-12 z-40 w-52 py-1.5',
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
                                      h.Class('tg-menu-item justify-between'),
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
                                            'tg-menu absolute right-full top-0 z-40 mr-2 w-40 py-1.5',
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
                                              h.Class('tg-menu-item'),
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
                                  h.Class('tg-menu-item'),
                                  h.OnClick(Message.ClickedMute()),
                                ],
                                [muted ? 'Unmute' : 'Mute'],
                              ),
                              h.button(
                                [
                                  h.Class('tg-menu-item text-[#e25c5c]'),
                                  h.OnClick(Message.ClickedDeleteChat()),
                                ],
                                ['Delete chat'],
                              ),
                            ],
                          )
                        : h.empty,
                    ],
                  ),
                  messageColumn(entries, h),
                  chat.kind === 'Channel'
                    ? h.div(
                        [
                          h.Class(
                            'tg-composer flex h-12 shrink-0 items-center justify-center text-sm text-[var(--tg-muted)]',
                          ),
                        ],
                        ['Replies are off'],
                      )
                    : h.div(
                        [
                          h.Class(
                            'tg-composer flex w-full shrink-0 items-center gap-0.5 px-1.5',
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
                            h.Class('tg-composer-input'),
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
