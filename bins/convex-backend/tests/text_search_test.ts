import { v } from "convex/values";
import { runQuery } from "./run_query_stub";

// A small unit test for the textByKeywords Convex query handler.
// Requires the test harness in tests/test_utils to provide runQuery that
// can invoke server queries in a test environment.

test("textByKeywords filters by user and scope", async () => {
	// Seed messages into the in-memory test DB (test_utils.runQuery should
	// provide direct DB access or helper methods; adjust as necessary).
	const userId = "test-user-1";
	const otherUser = "other-user";

	// Insert messages for both users and different chats/clients.
	await runQuery("dbInsert", {
		table: "messages",
		doc: {
			messageId: "m1",
			externalId: "e1",
			userId,
			clientId: "client1",
			chatId: "chatA",
			senderId: "s1",
			text: "hello world",
			outgoing: false,
			deleted: false,
			timestamp: Date.now(),
		},
	});

	await runQuery("dbInsert", {
		table: "messages",
		doc: {
			messageId: "m2",
			externalId: "e2",
			userId: otherUser,
			clientId: "client1",
			chatId: "chatA",
			senderId: "s2",
			text: "hello from other",
			outgoing: false,
			deleted: false,
			timestamp: Date.now(),
		},
	});

	const resp = await runQuery(
		"textByKeywords",
		{
			paginationOpts: { numItems: 10, cursor: null },
			keywords: "hello",
			scope: { type: "all" },
		},
		{ auth: { userId } },
	);

	expect(resp).toBeDefined();
	expect(resp.page).toBeDefined();
	const hits = resp.page;
	// Only one hit should be present for the test user
	expect(hits.length).toBe(1);
	expect(hits[0].chatId).toBe("chatA");
	expect(hits[0].messageId).toBe("m1");
});
