import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// =============================================================================
// Enum-like validators (Convex uses v.union(v.literal(...)) for enums)
// =============================================================================

export const clientKind = v.literal("Telegram");

export const clientStatus = v.union(
  v.object({ type: v.literal("Authenticating") }),
  v.object({ type: v.literal("Connected") }),
  v.object({ type: v.literal("Error"), message: v.string() }),
);

export const chatType = v.union(
  v.literal("Dialog"),
  v.literal("Group"),
);

export const messageSeverity = v.union(
  v.literal("Info"),
  v.literal("Warning"),
  v.literal("Error"),
);

export const phoneAuthStep = v.union(
  v.literal("SendingCode"),
  v.literal("WaitingCode"),
  v.literal("VerifyingCode"),
  v.literal("WaitingPassword"),
  v.literal("VerifyingPassword"),
  v.literal("Connected"),
  v.literal("Failed"),
  v.literal("Cancelled"),
);

export const qrAuthStep = v.union(
  v.literal("Pending"),
  v.literal("Generating"),
  v.literal("Token"),
  v.literal("Authorized"),
  v.literal("AlreadyAuthorized"),
  v.literal("Failed"),
  v.literal("Cancelled"),
);

export const mediaKind = v.union(
  v.literal("Photo"),
  v.literal("Video"),
  v.literal("Audio"),
  v.literal("MessageRef"),
);

// =============================================================================
// Schema
// =============================================================================

export default defineSchema({
  // ---- Users & Robots ----

  humans: defineTable({
    userId: v.string(), // Clerk token identifier (sub claim)
    username: v.optional(v.string()), // email from JWT
    displayName: v.optional(v.string()), // name from JWT
    online: v.boolean(),
    lastHeartbeat: v.number(), // Unix ms — used by cron to detect stale connections
    updatedAt: v.number(), // Unix ms
  })
    .index("by_userId", ["userId"])
    .index("by_online", ["online"]),

  robots: defineTable({
    robotId: v.string(), // JWT subject for robot
    online: v.boolean(),
    lastHeartbeat: v.number(),
    updatedAt: v.number(),
  })
    .index("by_robotId", ["robotId"])
    .index("by_online", ["online"]),

  // ---- Clients (Telegram connections) ----

  clients: defineTable({
    userId: v.string(), // FK to humans.userId
    kind: clientKind,
    externalId: v.string(), // phone number or Telegram user_id
    activeChats: v.array(v.string()),
    status: clientStatus,
  })
    .index("by_userId", ["userId"])
    .index("by_userId_externalId", ["userId", "externalId"]),

  // ---- Chats ----

  chats: defineTable({
    chatId: v.string(), // composite key (client_id + chat identifier)
    userId: v.string(), // FK to humans.userId
    clientId: v.id("clients"), // FK to clients
    chatType: chatType,
    isPinned: v.boolean(),
    pinnedName: v.optional(v.string()),
    lastMessageTs: v.number(), // Unix ms
  })
    .index("by_chatId", ["chatId"])
    .index("by_userId", ["userId"])
    .index("by_clientId", ["clientId"])
    .index("by_userId_lastMessageTs", ["userId", "lastMessageTs"]),

  // ---- Messages ----

  messages: defineTable({
    messageId: v.string(), // composite primary key from SpacetimeDB
    externalId: v.string(), // Telegram message ID
    userId: v.string(), // FK to humans.userId
    clientId: v.id("clients"),
    chatId: v.string(), // FK to chats.chatId
    senderId: v.string(), // Telegram user ID who sent the message
    text: v.optional(v.string()),
    out: v.boolean(), // true if sent by client owner
    deleted: v.boolean(),
    ts: v.number(), // Unix ms
    mediaId: v.optional(v.string()),
  })
    .index("by_messageId", ["messageId"])
    .index("by_externalId", ["externalId"])
    .index("by_userId", ["userId"])
    .index("by_chatId_ts", ["chatId", "ts"]),

  // ---- Phone Auth State Machine ----

  phoneAuths: defineTable({
    userId: v.string(), // FK to humans.userId (owner)
    clientId: v.id("clients"), // FK to clients
    phone: v.string(),
    step: phoneAuthStep,
    // Auth secrets — stored server-side, read by robot, never sent to frontend
    phoneCodeHash: v.optional(v.string()),
    loginCode: v.optional(v.string()),
    passwordToken: v.optional(v.string()),
    password: v.optional(v.string()),
    passwordHint: v.optional(v.string()),
    // Error info
    error: v.optional(v.string()),
    // Robot assignment (set once, stays for entire flow)
    assignedRobot: v.optional(v.string()), // robotId
    updatedAt: v.number(), // Unix ms
  })
    .index("by_userId", ["userId"])
    .index("by_step", ["step"])
    .index("by_assignedRobot", ["assignedRobot"]),

  // ---- QR Auth State Machine ----

  qrAuths: defineTable({
    userId: v.string(), // FK to humans.userId (owner)
    step: qrAuthStep,
    qrUrl: v.optional(v.string()),
    qrExpires: v.optional(v.number()), // seconds until QR expires
    telegramUserId: v.optional(v.int64()),
    error: v.optional(v.string()),
    assignedRobot: v.optional(v.string()), // robotId
    updatedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_step", ["step"])
    .index("by_assignedRobot", ["assignedRobot"]),

  // ---- Notifications ----

  notifications: defineTable({
    userId: v.string(), // FK to humans.userId
    severity: messageSeverity,
    message: v.string(),
    dismissed: v.boolean(),
  })
    .index("by_userId", ["userId"])
    .index("by_userId_dismissed", ["userId", "dismissed"]),
});
