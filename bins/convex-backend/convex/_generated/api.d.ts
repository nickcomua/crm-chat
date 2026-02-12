/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chats from "../chats.js";
import type * as clients from "../clients.js";
import type * as helpers_auth from "../helpers/auth.js";
import type * as media from "../media.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as phoneAuth from "../phoneAuth.js";
import type * as qrAuth from "../qrAuth.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chats: typeof chats;
  clients: typeof clients;
  "helpers/auth": typeof helpers_auth;
  media: typeof media;
  messages: typeof messages;
  notifications: typeof notifications;
  phoneAuth: typeof phoneAuth;
  qrAuth: typeof qrAuth;
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

export declare const components: {};
