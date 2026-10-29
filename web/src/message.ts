import * as Schema from 'effect/Schema'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'

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
  ToggledKeepSignedIn: {},
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
  CompletedRestore: { accounts: Schema.Array(Account) },
  SucceededAuthenticate: { result: AuthResult, sourceId: Schema.String },
  FailedAuthenticate: { error: Schema.String, sourceId: Schema.String },
  SucceededRefresh: { account: Account },
  FailedRefresh: {},
  CompletedDisconnect: {},
})
export type Message = typeof Message.Type
