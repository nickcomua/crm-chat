import * as Array from 'effect/Array'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Runtime, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'

import { fixtureChats, linesFor, markFor } from './fixture'
import type { Chat, ChatKind } from './generated/core'

const kindTint: Record<ChatKind, string> = {
  Dialog: 'bg-sky-700',
  Group: 'bg-emerald-700',
  Channel: 'bg-amber-700',
}

export const Model = Schema.Struct({
  maybeOpenChatId: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  ClickedChat: { id: Schema.String },
  ClickedBack: {},
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match(message, {
    ClickedChat: ({ id }) => ({
      model: modifyFields(model, { maybeOpenChatId: () => Option.some(id) }),
    }),
    ClickedBack: () => ({
      model: modifyFields(model, { maybeOpenChatId: () => Option.none() }),
    }),
  })

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: { maybeOpenChatId: Option.none() },
})

const openChat = (model: Model): Option.Option<Chat> =>
  Option.flatMap(model.maybeOpenChatId, (id) =>
    Array.findFirst(fixtureChats, (chat) => chat.id === id),
  )

const listHidden = (open: boolean): string => (open ? 'hidden md:flex' : 'flex')

const paneHidden = (open: boolean): string => (open ? 'flex' : 'hidden md:flex')

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const opened = openChat(model)
  const isOpen = Option.isSome(opened)

  return {
    title: '',
    body: h.div(
      [h.Class('flex h-screen overflow-hidden bg-[#0e1621] text-[#f5f5f5]')],
      [
        h.aside(
          [h.Class(`${listHidden(isOpen)} w-full shrink-0 flex-col bg-[#17212b] md:w-[26rem] md:border-r md:border-[#101921]`)],
          [
            h.div(
              [h.Class('px-4 py-3 text-sm font-medium text-[#708499]')],
              ['Chats'],
            ),
            h.ul(
              [h.Class('m-0 list-none overflow-y-auto')],
              fixtureChats.map((chat) => {
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
                      [h.Class(`flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-medium ${kindTint[chat.kind]}`)],
                      [markFor(chat.title)],
                    ),
                    h.div([h.Class('min-w-0 flex-1')], [
                      h.div([h.Class('truncate text-[15px]')], [chat.title]),
                      h.div([h.Class('truncate text-sm text-[#708499]')], [chat.kind]),
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
                  [h.Class('flex flex-1 items-center justify-center text-[#708499]')],
                  ['Select a chat'],
                ),
              onSome: (chat) =>
                h.div([h.Class('flex min-h-0 flex-1 flex-col')], [
                  h.div(
                    [h.Class('flex items-center gap-3 border-b border-[#101921] bg-[#17212b] px-2 py-2')],
                    [
                      h.button(
                        [
                          h.Class('rounded px-3 py-2 text-sm text-[#5288c1] md:hidden'),
                          h.OnClick(Message.ClickedBack()),
                        ],
                        ['Back'],
                      ),
                      h.div(
                        [h.Class(`flex size-10 items-center justify-center rounded-full text-sm ${kindTint[chat.kind]}`)],
                        [markFor(chat.title)],
                      ),
                      h.div([], [
                        h.div([h.Class('text-[15px]')], [chat.title]),
                        h.div([h.Class('text-sm text-[#708499]')], [chat.kind]),
                      ]),
                    ],
                  ),
                  h.div(
                    [h.Class('flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-y-auto px-4 py-4')],
                    linesFor(chat.id).map((line) =>
                      h.div(
                        [h.Class('max-w-md rounded-lg bg-[#182533] px-3 py-2 text-[15px]')],
                        [line],
                      ),
                    ),
                  ),
                  chat.kind === 'Channel'
                    ? h.div(
                        [h.Class('border-t border-[#101921] px-4 py-3 text-sm text-[#708499]')],
                        ['Replies are off'],
                      )
                    : h.div(
                        [h.Class('border-t border-[#101921] bg-[#17212b] px-4 py-3 text-sm text-[#708499]')],
                        ['Message'],
                      ),
                ]),
            }),
          ],
        ),
      ],
    ),
  }
}
