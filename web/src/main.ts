import * as Schema from 'effect/Schema'
import { Runtime, type Update } from 'foldkit'
import { Document, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'

import { fixtureChats } from './fixture'

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
    [h.Class('min-h-screen bg-white')],
    fixtureChats.map((chat) =>
      h.keyed('li')(chat.id, [], [`${chat.title} ${chat.kind}`]),
    ),
  ),
})
