export async function runQuery(name: string, args: any, opts?: any) {
  // Simple manual dispatcher for lightweight test runs.
  // - If name === 'dbInsert', perform a write to a test in-memory DB object.
  // - If name matches a query, import the query handler and call it.
  // This is intentionally minimal; adapt to your test harness as needed.

  if (name === "dbInsert") {
    // Store into a global test store.
    (global as any).__TEST_DB__ = (global as any).__TEST_DB__ || { messages: [] };
    (global as any).__TEST_DB__.messages.push(args.doc);
    return args.doc;
  }

  if (name === "textByKeywords") {
    // Import the query handler directly.
    const module = await import("../convex/search");
    const handler = module && module.textByKeywords && module.textByKeywords.handler ? module.textByKeywords.handler : null;
    if (!handler) throw new Error("textByKeywords handler not found");

    // Create fake context with db.query that reads from the in-memory store.
    const db = {
      query: (table: string) => ({
        withSearchIndex: (idxName: string, fn: any) => {
          // naive implementation: apply filter over in-memory messages
          const all = ((global as any).__TEST_DB__ && (global as any).__TEST_DB__.messages) || [];
          // Provide an object that has paginate() for the handler to call
          const qs = {
            paginate: async (paginationOpts: any) => {
              // Apply the function to a fake query builder that filters items
              const qb = fn({
                search: (_field: string, q: string) => ({
                  eq: (field: string, value: any) => {
                    // filter by field/value now for simplicity
                    return {
                      paginate: async () => {
                        const filtered = all.filter((m: any) => {
                          if (field === "userId") {
                            return m.userId === value;
                          }
                          return true;
                        });
                        return filtered;
                      },
                    };
                  },
                }),
              });
              // If qb has paginate, call it, else return all
              if (qb && qb.paginate) return qb.paginate(paginationOpts);
              return all;
            },
          };
          return qs;
        },
      }),
    };

    const ctx: any = { db, auth: { userId: opts?.auth?.userId } };
    return await handler(ctx, args);
  }

  throw new Error(`runQuery stub: unknown action ${name}`);
}
