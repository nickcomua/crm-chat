import * as Schema from 'effect/Schema'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'

import { ChatLine, StoredFace } from './chatFace'
import { Account, AuthResult } from './telegram'

export const Secret = Schema.Redacted(Schema.String)
export const RuntimeCredentials = defineTaggedUnion({
  Absent: {},
  Present: { apiId: Schema.String, apiHash: Secret },
})
export const Message = defineMessageUnion({
  UpdatedApiId: { value: Schema.String },
  UpdatedApiHash: { value: Secret },
  UpdatedPhone: { value: Secret },
  ClickedCountry: {},
  SelectedCountry: { iso: Schema.String },
  ClickedPhoneForm: {},
  ClickedPasskey: {},
  ClickedTheme: {},
  ClickedFolder: {
    folder: Schema.Literals(['All', 'Personal', 'Groups', 'Channels']),
  },
  UpdatedAnswer: { value: Secret },
  UpdatedQuery: { value: Schema.String },
  UpdatedDraft: { value: Schema.String },
  ClickedPhoneLogin: {},
  ClickedQrLogin: {},
  SubmittedAnswer: {},
  ClickedAddAccount: {},
  ClickedCancel: {},
  SelectedAccount: { id: Schema.String },
  ClickedRefresh: {},
  ClickedChat: { id: Schema.String },
  ClickedBack: {},
  ClickedMenu: {},
  ClickedMore: {},
  ClickedHeaderMenu: {},
  ClickedHeaderSearch: {},
  ClickedCall: {},
  ClickedEmoji: {},
  ClickedAttach: {},
  ClickedVoice: {},
  ClickedSend: {},
  ClickedAutoDelete: {},
  ClickedAutoDeleteChoice: { value: Schema.String },
  ClickedMute: {},
  ClickedDeleteChat: {},
  ClickedDismissMenu: {},
  CompletedLoadAppCredentials: { credentials: RuntimeCredentials },
  CompletedRestore: {
    accounts: Schema.Array(Account),
    faces: Schema.optional(Schema.Array(StoredFace)),
  },
  SucceededAuthenticate: { result: AuthResult, sourceId: Schema.String },
  FailedAuthenticate: { error: Schema.String, sourceId: Schema.String },
  SucceededRefresh: {
    account: Account,
    faces: Schema.optional(Schema.Array(StoredFace)),
  },
  LoadedHistory: { id: Schema.String, lines: Schema.Array(ChatLine) },
  FailedRefresh: {},
  CompletedDisconnect: {},
})
export type Message = typeof Message.Type
