export async function runQuery(name: string, args: any, opts?: any) {
	// Simple manual dispatcher for lightweight test runs.
	// - If name === 'dbInsert', perform a write to a test in-memory DB object.
	// - If name matches a query, import the query handler and call it.
	// This is intentionally minimal; adapt to your test harness as needed.

	if (name === "dbInsert") {
		// Store into a global test store.
		(global as any).__TEST_DB__ = (global as any).__TEST_DB__ || {
			messages: [],
		};
		(global as any).__TEST_DB__.messages.push(args.doc);
		return args.doc;
	}

	if (name === "textByKeywords") {
		const allMessages = (global as any).__TEST_DB__?.messages || [];

		const { keywords, scope, paginationOpts } = args;
		const { userId } = opts?.auth ?? {};

		let filtered = allMessages;

		// Filter by scope
		if (scope?.type === "client" && scope.clientId) {
			filtered = filtered.filter((m: any) => m.clientId === scope.clientId);
		} else if (scope?.type === "chat" && scope.chatId) {
			filtered = filtered.filter((m: any) => m.chatId === scope.chatId);
		}

		// Filter by user
		if (userId) {
			filtered = filtered.filter((m: any) => m.userId === userId);
		}

		// Filter by keywords (simple substring match)
		const trimmedKeywords = keywords?.trim();
		if (trimmedKeywords) {
			filtered = filtered.filter((m: any) =>
				m.text?.toLowerCase().includes(trimmedKeywords.toLowerCase()),
			);
		} else {
			// If no keywords, return empty results as per backend logic
			filtered = [];
		}

		// Apply pagination
		const numItems = paginationOpts?.numItems ?? filtered.length;
		const page = filtered.slice(0, numItems);

		return Promise.resolve({
			page,
			isDone: page.length === filtered.length,
			continueCursor: null, // Not implemented in stub
		});
	}

	throw new Error(`runQuery stub: unknown action ${name}`);
}
