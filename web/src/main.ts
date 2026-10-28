import * as Schema from 'effect/Schema'
import { Runtime, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { fixtureChats } from './fixture'

const kindClass = {
  Dialog: 'w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-sky-300',
  Group: 'w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-emerald-300',
  Channel: 'w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-amber-300',
} as const

export const Model = Schema.Struct({})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({})
export type Message = typeof Message.Type

export const update = (
  _model: Model,
  message: Message,
): Update.Return<Model, Message> => Message.match(message, {})

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {},
})

export const view = (_model: Model, h: HtmlBuilder<Message>): Document => ({
  title: '',
  body: h.ul(
    [h.Class('m-0 min-h-screen list-none bg-zinc-950 p-2 text-zinc-100')],
    fixtureChats.map((chat) =>
      h.keyed('li')(
        chat.id,
        [h.Class('flex items-baseline gap-3 border-b border-zinc-800 px-3 py-3')],
        [
          h.span([h.Class(kindClass[chat.kind])], [chat.kind]),
          h.span([h.Class('text-base text-zinc-50')], [chat.title]),
        ],
      ),
    ),
  ),
})
