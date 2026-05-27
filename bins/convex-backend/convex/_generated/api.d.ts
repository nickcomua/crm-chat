/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as env from "../env.js";
import type * as functions from "../functions.js";
import type * as helpers_result from "../helpers/result.js";
import type * as helpers_validators from "../helpers/validators.js";
import type * as model_chatContactLinks from "../model/chatContactLinks.js";
import type * as model_chats from "../model/chats.js";
import type * as model_clients from "../model/clients.js";
import type * as model_contactPins from "../model/contactPins.js";
import type * as model_contacts from "../model/contacts.js";
import type * as model_media from "../model/media.js";
import type * as model_messages from "../model/messages.js";
import type * as model_notifications from "../model/notifications.js";
import type * as model_phoneAuth from "../model/phoneAuth.js";
import type * as model_presence from "../model/presence.js";
import type * as model_qrAuth from "../model/qrAuth.js";
import type * as testHelpers from "../testHelpers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  env: typeof env;
  functions: typeof functions;
  "helpers/result": typeof helpers_result;
  "helpers/validators": typeof helpers_validators;
  "model/chatContactLinks": typeof model_chatContactLinks;
  "model/chats": typeof model_chats;
  "model/clients": typeof model_clients;
  "model/contactPins": typeof model_contactPins;
  "model/contacts": typeof model_contacts;
  "model/media": typeof model_media;
  "model/messages": typeof model_messages;
  "model/notifications": typeof model_notifications;
  "model/phoneAuth": typeof model_phoneAuth;
  "model/presence": typeof model_presence;
  "model/qrAuth": typeof model_qrAuth;
  testHelpers: typeof testHelpers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  presence: import("@convex-dev/presence/_generated/component.js").ComponentApi<"presence">;
};
