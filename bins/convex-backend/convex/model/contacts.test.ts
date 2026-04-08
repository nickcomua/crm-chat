/**
 * Backend tests for the contacts domain (Task 29 of the contacts feature plan).
 *
 * These tests exercise the `model/contacts.ts` handlers directly against an
 * in-memory Convex runtime via the `convex-test` library. They complement the
 * Playwright e2e specs in `bins/crm-chat-web/tests/contacts-*.spec.ts` — the
 * specs drive the UI with a real Convex container, while these tests verify
 * the low-level transactional semantics that are awkward to poke at from the
 * browser (same-timestamp tie-breaking, cursor reactivity, permission errors,
 * hard-delete cascade survival, etc.).
 *
 * Coverage — scenarios from Task 29 of plans/2026-04-08-contacts-feature-v2.md:
 *   1. `contacts.create` rejects a chat the caller does not own.
 *   2. `linkSender` conflict → reassign path (transactional atomicity).
 *   3. `listMergedMessages` ordering across two chats with interleaved
 *      timestamps and same-timestamp tie-breaking by messageId.
 *   4. `listMergedMessages` excludes Group chats.
 *   5. `listMergedMessages` reactivity: a new message inserted mid-pagination
 *      is picked up on re-run of the first page.
 *   8. `mergeContacts` moves links, pins, custom fields, and notes.
 *   9. `mergeContacts` conflict resolution for all three modes.
 *  10. Cross-user permission rejections (read/update/link/merge).
 *  11. Edge: linking to a non-existent chat/sender, linking to a chat owned
 *      by another user, merging contacts owned by different users.
 *
 * How to run:
 *   The convex-backend package currently has no JS/TS test runner wired into
 *   `package.json`. To run these tests locally, add the `convex-test` and
 *   `vitest` dev dependencies and a `test` script, for example:
 *
 *     bun add -d convex-test vitest @edge-runtime/vm
 *     # package.json:
 *     # "test": "vitest run --environment=edge-runtime"
 *
 *   Then run `bun run test` from `bins/convex-backend/`.
 *
 * The tests are structured around the conventional `convex-test` pattern:
 *   import { convexTest } from "convex-test";
 *   import schema from "../schema";
 *   const t = convexTest(schema);
 *   const asAlice = t.withIdentity({ subject: "user_alice", issuer: "https://clerk.test/" });
 *   await asAlice.mutation(api.model.contacts.create, { ... });
 *
 * The `issuer` field is required so that `ctx.auth.getUserIdentity()` yields
 * a tokenIdentifier of the form `{issuer}|{subject}` that matches the
 * `ctx.caller.tokenIdentifier` strings used for ownership checks in
 * `model/contacts.ts`.
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
const BOB_TOKEN = `${ISSUER}|user_bob`;

// =============================================================================
// Shared seed helpers
// =============================================================================

/**
 * Lazy per-test client cache so we do not have to thread `clientId` through
 * every call site. Each test constructs its own `convexTest(schema)` instance,
 * so keying the cache on `t` gives us exactly-once client creation per user
 * per test.
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
    lastMessageTimestamp?: number;
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
      lastMessageTimestamp: opts.lastMessageTimestamp ?? Date.now(),
      scanEnabled: true,
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
    outgoing?: boolean;
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
      outgoing: opts.outgoing ?? false,
      deleted: false,
      timestamp: opts.timestamp,
    })
  );
}

// =============================================================================
// Scenario 1: contacts.create rejects a chat the caller does not own
// =============================================================================

describe("contacts.create — ownership enforcement", () => {
  test("rejects initialLink pointing at another user's chat", async () => {
    const t = convexTest(schema);

    // Alice owns the chat.
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "alice-chat-1",
      chatType: "Dialog",
      pinnedName: "Alice's DM",
    });

    // Bob tries to create a contact linked to Alice's chat.
    const asBob = t.withIdentity(BOB);
    await expect(
      asBob.mutation(api.model.contacts.create, {
        displayName: "Sneaky",
        initialLink: { chatId: "alice-chat-1", senderId: "sender-a" },
      })
    ).rejects.toThrow(/Unauthorized/);
  });

  test("rejects initialLink pointing at a non-existent chat", async () => {
    const t = convexTest(schema);
    const asAlice = t.withIdentity(ALICE);
    await expect(
      asAlice.mutation(api.model.contacts.create, {
        displayName: "Ghost",
        initialLink: { chatId: "does-not-exist", senderId: "x" },
      })
    ).rejects.toThrow(/Unauthorized/);
  });
});

// =============================================================================
// Scenario 2: linkSender conflict → reassign (transactional atomicity)
// =============================================================================

describe("contacts.linkSender — conflict reassignment", () => {
  test("without reassign flag, returns Err and leaves the link untouched", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });

    const asAlice = t.withIdentity(ALICE);
    const createA = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Contact A",
      initialLink: { chatId: "c1", senderId: "sender-1" },
    });
    const createB = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Contact B",
    });
    const contactAId =
      "Ok" in createA ? createA.Ok.contactId : (null as never);
    const contactBId =
      "Ok" in createB ? createB.Ok.contactId : (null as never);

    const res = await asAlice.mutation(api.model.contacts.linkSender, {
      contactId: contactBId,
      chatId: "c1",
      senderId: "sender-1",
    });
    expect(res).toEqual({ Err: "Sender already linked to another contact" });

    // Verify the link still belongs to A.
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("chatContactLinks")
        .withIndex("by_userId_chatId_senderId", (q) =>
          q
            .eq("userId", ALICE_TOKEN)
            .eq("chatId", "c1")
            .eq("senderId", "sender-1")
        )
        .unique();
      expect(link).not.toBeNull();
      expect(link?.contactId).toBe(contactAId);
    });
  });

  test("with reassign: true, atomically moves the link from A to B", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });

    const asAlice = t.withIdentity(ALICE);
    const createA = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Contact A",
      initialLink: { chatId: "c1", senderId: "sender-1" },
    });
    const createB = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Contact B",
    });
    const contactAId = "Ok" in createA ? createA.Ok.contactId : (null as never);
    const contactBId = "Ok" in createB ? createB.Ok.contactId : (null as never);

    const res = await asAlice.mutation(api.model.contacts.linkSender, {
      contactId: contactBId,
      chatId: "c1",
      senderId: "sender-1",
      reassign: true,
    });
    expect(res).toEqual({ Ok: null });

    // After reassign:
    //   - B owns the link
    //   - A has zero links
    //   - there is still exactly one row for (chatId, senderId)
    await t.run(async (ctx) => {
      const linksForA = await ctx.db
        .query("chatContactLinks")
        .withIndex("by_contactId", (q) => q.eq("contactId", contactAId))
        .collect();
      const linksForB = await ctx.db
        .query("chatContactLinks")
        .withIndex("by_contactId", (q) => q.eq("contactId", contactBId))
        .collect();
      expect(linksForA).toHaveLength(0);
      expect(linksForB).toHaveLength(1);
      expect(linksForB[0].chatId).toBe("c1");
      expect(linksForB[0].senderId).toBe("sender-1");
    });
  });
});

// =============================================================================
// Scenario 3 & 4 & 5: listMergedMessages — ordering, Group exclusion, reactivity
// =============================================================================

describe("contacts.listMergedMessages", () => {
  test("interleaves messages by (timestamp, messageId) across two chats", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-x",
      chatType: "Dialog",
      pinnedName: "X",
    });
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-y",
      chatType: "Dialog",
      pinnedName: "Y",
    });

    // Interleaved timestamps: x=100, y=150, x=200, y=200, x=300.
    // The (y=200, x=200) pair tests same-timestamp tie-breaking by messageId.
    // `listMergedMessages` sorts desc by (timestamp, messageId), so within the
    // 200-bucket the entry with the lexicographically *greater* messageId
    // comes first.
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-x",
      messageId: "m-x-100",
      senderId: "sx",
      timestamp: 100,
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-y",
      messageId: "m-y-150",
      senderId: "sy",
      timestamp: 150,
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-x",
      messageId: "m-x-200",
      senderId: "sx",
      timestamp: 200,
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-y",
      messageId: "m-y-200",
      senderId: "sy",
      timestamp: 200,
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-x",
      messageId: "m-x-300",
      senderId: "sx",
      timestamp: 300,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Interleaved",
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    await asAlice.mutation(api.model.contacts.linkSender, {
      contactId,
      chatId: "chat-x",
      senderId: "sx",
    });
    await asAlice.mutation(api.model.contacts.linkSender, {
      contactId,
      chatId: "chat-y",
      senderId: "sy",
    });

    const page = await asAlice.query(api.model.contacts.listMergedMessages, {
      contactId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(page.page.map((m: { messageId: string }) => m.messageId)).toEqual([
      "m-x-300",
      "m-y-200",
      "m-x-200",
      "m-y-150",
      "m-x-100",
    ]);
  });

  test("excludes Group chats from the merged timeline", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "dm-1",
      chatType: "Dialog",
    });
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "grp-1",
      chatType: "Group",
    });

    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "dm-1",
      messageId: "dm-msg-1",
      senderId: "s-dm",
      text: "hi from dm",
      timestamp: 1000,
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "grp-1",
      messageId: "grp-msg-1",
      senderId: "s-grp",
      text: "hi from group",
      timestamp: 2000,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "GroupFilter",
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    await asAlice.mutation(api.model.contacts.linkSender, {
      contactId,
      chatId: "dm-1",
      senderId: "s-dm",
    });
    await asAlice.mutation(api.model.contacts.linkSender, {
      contactId,
      chatId: "grp-1",
      senderId: "s-grp",
    });

    const page = await asAlice.query(api.model.contacts.listMergedMessages, {
      contactId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    // Only the dm-1 message should show up, even though grp-1 had a newer ts.
    expect(page.page).toHaveLength(1);
    expect(page.page[0].messageId).toBe("dm-msg-1");
    expect(page.page[0].chatId).toBe("dm-1");
  });

  test("reactivity: a newer message becomes visible on re-running first page", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-r",
      chatType: "Dialog",
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-r",
      messageId: "r-msg-old",
      senderId: "s1",
      text: "old",
      timestamp: 1000,
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Reactive",
      initialLink: { chatId: "chat-r", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const first = await asAlice.query(api.model.contacts.listMergedMessages, {
      contactId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(first.page.map((m: { messageId: string }) => m.messageId)).toEqual([
      "r-msg-old",
    ]);

    // Insert a newer message after the first page was already read.
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "chat-r",
      messageId: "r-msg-new",
      senderId: "s1",
      text: "new",
      timestamp: 2000,
    });

    // Re-running the first page from scratch (cursor: null) should pick it up.
    const second = await asAlice.query(api.model.contacts.listMergedMessages, {
      contactId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(second.page.map((m: { messageId: string }) => m.messageId)).toEqual([
      "r-msg-new",
      "r-msg-old",
    ]);
  });
});

// =============================================================================
// Scenario 8 & 9: mergeContacts — moves everything, conflict resolution modes
// =============================================================================

describe("contacts.mergeContacts", () => {
  test("moves links, pins, custom fields, and notes from source to target", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      chatType: "Dialog",
    });
    await seedMessage(t, {
      userId: ALICE_TOKEN,
      chatId: "c1",
      messageId: "msg-pin-1",
      senderId: "s1",
      text: "to-be-pinned",
      timestamp: 100,
    });

    const asAlice = t.withIdentity(ALICE);
    const srcCreate = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Source",
      notes: "source notes",
      customFields: [{ key: "city", value: "Berlin" }],
      initialLink: { chatId: "c1", senderId: "s1" },
    });
    const sourceId =
      "Ok" in srcCreate ? srcCreate.Ok.contactId : (null as never);

    const tgtCreate = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Target",
      notes: "target notes",
      customFields: [{ key: "email", value: "t@example.com" }],
    });
    const targetId =
      "Ok" in tgtCreate ? tgtCreate.Ok.contactId : (null as never);

    const pinRes = await asAlice.mutation(api.model.contactPins.pinMessage, {
      contactId: sourceId,
      messageId: "msg-pin-1",
    });
    expect("Ok" in pinRes).toBe(true);

    const merge = await asAlice.mutation(api.model.contacts.mergeContacts, {
      sourceId,
      targetId,
      conflictResolution: "keepBoth",
    });
    expect("Ok" in merge).toBe(true);

    // Source should be gone, target should carry everything.
    await t.run(async (ctx) => {
      const src = await ctx.db.get(sourceId);
      expect(src).toBeNull();

      const tgt = await ctx.db.get(targetId);
      expect(tgt).not.toBeNull();
      // Notes concatenated.
      expect(tgt?.notes).toContain("target notes");
      expect(tgt?.notes).toContain("source notes");
      // Custom fields appended (keepBoth).
      const keys = (tgt?.customFields ?? []).map(
        (f: { key: string }) => f.key
      );
      expect(keys.sort()).toEqual(["city", "email"]);

      const links = await ctx.db
        .query("chatContactLinks")
        .withIndex("by_contactId", (q) => q.eq("contactId", targetId))
        .collect();
      expect(links).toHaveLength(1);
      expect(links[0].chatId).toBe("c1");

      const pins = await ctx.db
        .query("contactPins")
        .withIndex("by_contactId_pinnedAt", (q) =>
          q.eq("contactId", targetId)
        )
        .collect();
      expect(pins).toHaveLength(1);
      expect(pins[0].messageId).toBe("msg-pin-1");
    });
  });

  test.each(["keepTarget", "keepSource", "keepBoth"] as const)(
    "custom-field conflict resolution mode = %s",
    async (mode) => {
      const t = convexTest(schema);
      const asAlice = t.withIdentity(ALICE);

      const src = await asAlice.mutation(api.model.contacts.create, {
        displayName: "Src",
        customFields: [{ key: "email", value: "source@x.com" }],
      });
      const tgt = await asAlice.mutation(api.model.contacts.create, {
        displayName: "Tgt",
        customFields: [{ key: "email", value: "target@x.com" }],
      });
      const sourceId = "Ok" in src ? src.Ok.contactId : (null as never);
      const targetId = "Ok" in tgt ? tgt.Ok.contactId : (null as never);

      await asAlice.mutation(api.model.contacts.mergeContacts, {
        sourceId,
        targetId,
        conflictResolution: mode,
      });

      await t.run(async (ctx) => {
        const merged = await ctx.db.get(targetId);
        const fields = (merged?.customFields ?? []) as Array<{
          key: string;
          value: string;
        }>;
        if (mode === "keepTarget") {
          expect(fields).toHaveLength(1);
          expect(fields[0].value).toBe("target@x.com");
        } else if (mode === "keepSource") {
          expect(fields).toHaveLength(1);
          expect(fields[0].value).toBe("source@x.com");
        } else {
          // keepBoth: both values preserved; order is [target..., source...]
          expect(fields).toHaveLength(2);
          expect(fields.map((f) => f.value).sort()).toEqual([
            "source@x.com",
            "target@x.com",
          ]);
        }
      });
    }
  );
});

// =============================================================================
// Scenario 10: cross-user permission rejections
// =============================================================================

describe("contacts — cross-user permission checks", () => {
  test("Bob cannot read, update, link to, or delete Alice's contact", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "alice-c",
      chatType: "Dialog",
    });

    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "AlicesContact",
      initialLink: { chatId: "alice-c", senderId: "s1" },
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const asBob = t.withIdentity(BOB);

    // get — throws Unauthorized
    await expect(
      asBob.query(api.model.contacts.get, { contactId })
    ).rejects.toThrow(/Unauthorized/);

    // update — throws Unauthorized
    await expect(
      asBob.mutation(api.model.contacts.update, {
        contactId,
        displayName: "Hacked",
      })
    ).rejects.toThrow(/Unauthorized/);

    // linkSender — throws Unauthorized
    await expect(
      asBob.mutation(api.model.contacts.linkSender, {
        contactId,
        chatId: "alice-c",
        senderId: "s-bob",
      })
    ).rejects.toThrow(/Unauthorized/);

    // deleteContact — throws Unauthorized
    await expect(
      asBob.mutation(api.model.contacts.deleteContact, { contactId })
    ).rejects.toThrow(/Unauthorized/);
  });

  test("Bob cannot merge Alice's contact into his own", async () => {
    const t = convexTest(schema);
    const asAlice = t.withIdentity(ALICE);
    const asBob = t.withIdentity(BOB);

    const aliceC = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Alice",
    });
    const bobC = await asBob.mutation(api.model.contacts.create, {
      displayName: "Bob",
    });
    const aliceId = "Ok" in aliceC ? aliceC.Ok.contactId : (null as never);
    const bobId = "Ok" in bobC ? bobC.Ok.contactId : (null as never);

    // Bob tries to merge Alice's contact into his own → Unauthorized.
    await expect(
      asBob.mutation(api.model.contacts.mergeContacts, {
        sourceId: aliceId,
        targetId: bobId,
      })
    ).rejects.toThrow(/Unauthorized/);

    // And the other direction.
    await expect(
      asBob.mutation(api.model.contacts.mergeContacts, {
        sourceId: bobId,
        targetId: aliceId,
      })
    ).rejects.toThrow(/Unauthorized/);
  });
});

// =============================================================================
// Scenario 11: edge cases — non-existent chat, foreign chat, cross-user merge
// =============================================================================

describe("contacts — edge cases", () => {
  test("linkSender to a non-existent chat returns Err('Chat not found')", async () => {
    const t = convexTest(schema);
    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "NoChat",
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const res = await asAlice.mutation(api.model.contacts.linkSender, {
      contactId,
      chatId: "nope",
      senderId: "x",
    });
    expect(res).toEqual({ Err: "Chat not found" });
  });

  test("linkSender to a foreign chat throws Unauthorized", async () => {
    const t = convexTest(schema);
    await seedChat(t, {
      userId: ALICE_TOKEN,
      chatId: "alices-chat",
      chatType: "Dialog",
    });

    const asBob = t.withIdentity(BOB);
    const bobC = await asBob.mutation(api.model.contacts.create, {
      displayName: "BobsContact",
    });
    const bobContactId =
      "Ok" in bobC ? bobC.Ok.contactId : (null as never);

    await expect(
      asBob.mutation(api.model.contacts.linkSender, {
        contactId: bobContactId,
        chatId: "alices-chat",
        senderId: "x",
      })
    ).rejects.toThrow(/Unauthorized/);
  });

  test("mergeContacts refuses to merge contacts owned by different users", async () => {
    // Because auth checks throw first, the defensive
    // "Cannot merge contacts owned by different users" branch is unreachable
    // through the normal path — auth rejects before we even compare userIds.
    // The behaviour we test here is "the caller cannot merge contacts they
    // don't own", which still surfaces as Unauthorized.
    const t = convexTest(schema);
    const asAlice = t.withIdentity(ALICE);
    const asBob = t.withIdentity(BOB);

    const aliceC = await asAlice.mutation(api.model.contacts.create, {
      displayName: "A",
    });
    const bobC = await asBob.mutation(api.model.contacts.create, {
      displayName: "B",
    });
    const aliceId = "Ok" in aliceC ? aliceC.Ok.contactId : (null as never);
    const bobId = "Ok" in bobC ? bobC.Ok.contactId : (null as never);

    // Alice attempts to merge her contact into Bob's — rejected by auth.
    await expect(
      asAlice.mutation(api.model.contacts.mergeContacts, {
        sourceId: aliceId,
        targetId: bobId,
      })
    ).rejects.toThrow(/Unauthorized/);
  });

  test("mergeContacts refuses self-merge", async () => {
    const t = convexTest(schema);
    const asAlice = t.withIdentity(ALICE);
    const created = await asAlice.mutation(api.model.contacts.create, {
      displayName: "Only",
    });
    const contactId =
      "Ok" in created ? created.Ok.contactId : (null as never);

    const res = await asAlice.mutation(api.model.contacts.mergeContacts, {
      sourceId: contactId,
      targetId: contactId,
    });
    expect(res).toEqual({ Err: "Cannot merge a contact into itself" });
  });
});
