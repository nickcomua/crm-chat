/**
 * Backend tests for the contactPins domain (Task 29 of the contacts feature plan).
 *
 * Coverage — scenarios from Task 29 of plans/2026-04-08-contacts-feature-v2.md:
 *   6. `contactPins.pinMessage` idempotency on duplicate calls.
 *   7. `contactPins.listForContact` returns snapshot data even after the
 *      underlying `messages` row is hard-deleted (surviving
 *      `updateScanEnabled(false)`). The query marks such pins as
 *      `isOrphaned: true`.
 *  10. Cross-user permission rejections for pin mutations/queries.
 *
 * How to run: see the header comment in `contacts.test.ts` in this same
 * directory. The convex-backend package currently has no JS test runner
 * wired into `package.json`; add `convex-test` + `vitest` as dev deps and
 * point a `test` script at vitest with the edge-runtime environment, then
 * run `bun run test` from `bins/convex-backend/`.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const ISSUER = "https://clerk.test/";
const ALICE = { subject: "user_alice", issuer: ISSUER };
const BOB = { subject: "user_bob", issuer: ISSUER };
const ALICE_TOKEN = `${ISSUER}|user_alice`;

// =============================================================================
// Shared seed helpers
// =============================================================================

/**
 * Lazy per-test client cache — see the note in contacts.test.ts for rationale.
 */
const clientCache = new WeakMap<object, Map<string, Id<"clients">>>();

async function getClientId(
  t: ReturnType<typeof convexTest>,
  userId: string
): Promise<Id<"clients">> {
  let perUser = clientCache.get(t as unknown as object);
  if (!perUser) {
    perUser = new Map();
    clientCache.set(t as unknown as object, perUser);
  }
  const existing = perUser.get(userId);
  if (existing) {
    return existing;
  }
  const clientId = await t.run(async (ctx) =>
    ctx.db.insert("clients", {
      userId,
      kind: "Telegram" as const,
      telegramId: `telegram:${userId}`,
      scanningChatIds: [],
      status: { type: "Connected" as const },
    })
  );
  perUser.set(userId, clientId);
  return clientId;
}

async function seedChat(
  t: ReturnType<typeof convexTest>,
  opts: {
    userId: string;
    chatId: string;
    chatType: "Dialog" | "Group";
    pinnedName?: string;
    scanEnabled?: boolean;
  }
): Promise<void> {
  const clientId = await getClientId(t, opts.userId);
  await t.run(async (ctx) => {
    await ctx.db.insert("chats", {
      userId: opts.userId,
      clientId,
      chatId: opts.chatId,
      chatType: opts.chatType,
      isPinned: true,
      pinnedName: opts.pinnedName,
      lastMessageTimestamp: Date.now(),
      scanEnabled: opts.scanEnabled ?? true,
    });
  });
}

async function seedMessage(
  t: ReturnType<typeof convexTest>,
  opts: {
    userId: string;
    chatId: string;
    messageId: string;
    senderId: string;
    text?: string;
    timestamp: number;
  }
): Promise<Id<"messages">> {
  const clientId = await getClientId(t, opts.userId);
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      userId: opts.userId,
      clientId,
      chatId: opts.chatId,
      messageId: opts.messageId,
      externalId: `ext-${opts.messageId}`,
      senderId: opts.senderId,
      text: opts.text,
      outgoing: false,
      deleted: false,
      timestamp: opts.timestamp,
    })
  );
}

// =============================================================================
// Scenario 6: pinMessage idempotency
// =============================================================================

describe("contactPins.pinMessage — idempotency", () => {
  test("calling pinMessage twice for the same (contact, message) is a no-op", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      messageId: "msg-dup",
      senderId: "s1",
      text: "hello",
      timestamp: 1000,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Dup",
      initialLink: { chatId: "c1", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const first = await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId,
      messageId: "msg-dup",
    });
    const second = await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId,
      messageId: "msg-dup",
    });

    expect("Ok" in first).toBe(true);
    expect("Ok" in second).toBe(true);

    // Idempotency: both calls return the same pinId.
    if ("Ok" in first && "Ok" in second) {
      expect(first.Ok.pinId).toBe(second.Ok.pinId);
    }

    // And only one row exists in the table.
    await t.run(async (ctx) => {
      const pins = await ctx.db
        .query("contactPins")
        .withIndex("by_contactId_pinnedAt", (q) => q.eq("contactId", contactId))
        .collect();
      expect(pins).toHaveLength(1);
      expect(pins[0].messageId).toBe("msg-dup");
    });
  });

  test("pinning a message that does not exist returns Err('Message not found')", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "NoMsg",
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const res = await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId,
      messageId: "never-existed",
    });
    expect(res).toEqual({ Err: "Message not found" });
  });
});

// =============================================================================
// Scenario 7: pins survive hard-delete of the underlying message
// =============================================================================

describe("contactPins.listForContact — hard-delete survival", () => {
  test("snapshot survives direct deletion of the messages row", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
      pinnedName: "Survivor Chat",
    });
    const msgDocId = await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      messageId: "msg-survivor",
      senderId: "s1",
      text: "This should survive in the pin snapshot",
      timestamp: 5000,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Survivor",
      initialLink: { chatId: "c1", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const pinRes = await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId,
      messageId: "msg-survivor",
    });
    expect("Ok" in pinRes).toBe(true);

    // Hard-delete the underlying message row. This is what happens during
    // `chats.updateScanEnabled(false)` — the messages rows for the chat
    // are purged, but the contactPin rows must continue to render.
    await t.run(async (ctx) => {
      await ctx.db.delete(msgDocId);
    });

    const page = await asAlice.query(
      api.model.contactPins.listForContact,
      { contactId, paginationOpts: { numItems: 10, cursor: null } }
    );
    expect(page.page).toHaveLength(1);
    const pin = page.page[0];
    expect(pin.isOrphaned).toBe(true);
    // Snapshot fields should still render the original message.
    expect(pin.snapshot.text).toBe(
      "This should survive in the pin snapshot"
    );
    expect(pin.snapshot.senderId).toBe("s1");
    expect(pin.snapshot.timestamp).toBe(5000);
    expect(pin.snapshot.chatDisplayNameAtPinTime).toBe("Survivor Chat");
  });

  test("survives updateScanEnabled(false) which hard-deletes messages", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c-scan",
      chatType: "Dialog",
      pinnedName: "Scan Chat",
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "c-scan",
      messageId: "msg-scan-1",
      senderId: "s1",
      text: "scanned content",
      timestamp: 7777,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "ScanSurvivor",
      initialLink: { chatId: "c-scan", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId,
      messageId: "msg-scan-1",
    });

    const scanRes = await asAlice.mutation(api.model.chats.updateScanEnabled, {
      chatId: "c-scan",
      scanEnabled: false,
    });
    expect(scanRes).toEqual({ Ok: null });

    // All messages for this chat should now be purged.
    await t.run(async (ctx) => {
      const remaining = await ctx.db
        .query("messages")
        .withIndex("by_chatId_timestamp", (q) => q.eq("chatId", "c-scan"))
        .collect();
      expect(remaining).toHaveLength(0);
    });

    // But the pin should still render, now marked orphaned.
    const page = await asAlice.query(
      api.model.contactPins.listForContact,
      { contactId, paginationOpts: { numItems: 10, cursor: null } }
    );
    expect(page.page).toHaveLength(1);
    expect(page.page[0].isOrphaned).toBe(true);
    expect(page.page[0].snapshot.text).toBe("scanned content");
  });
});

// =============================================================================
// Scenario 10 (pins): cross-user permission checks
// =============================================================================

describe("contactPins — cross-user permission checks", () => {
  test("Bob cannot pin, unpin, or list pins for Alice's contact", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      messageId: "m1",
      senderId: "s1",
      text: "alice msg",
      timestamp: 100,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "AlicesContact",
      initialLink: { chatId: "c1", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const asBob = t.withIdentity(BOB);

    await expect(
      asBob.mutation(api.model.contactPins.pinMessage, {
        contactId,
        messageId: "m1",
      })
    ).rejects.toThrow(/Unauthorized/);

    await expect(
      asBob.mutation(api.model.contactPins.unpinMessage, {
        contactId,
        messageId: "m1",
      })
    ).rejects.toThrow(/Unauthorized/);

    await expect(
      asBob.query(api.model.contactPins.listForContact, {
        contactId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow(/Unauthorized/);
  });
});
