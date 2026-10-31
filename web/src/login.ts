import * as Schema from 'effect/Schema'
import { defineTaggedUnion } from 'foldkit/schema'

export const Login = defineTaggedUnion({
  Editing: {},
  Closed: {},
  Code: { id: Schema.String },
  Password: { id: Schema.String, hint: Schema.optional(Schema.String) },
  Qr: { id: Schema.String, image: Schema.String },
})
export type Login = typeof Login.Type
