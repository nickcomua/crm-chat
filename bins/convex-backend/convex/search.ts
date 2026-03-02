import { v } from "convex/values"
import { query } from "./_generated/server";
import { requireHuman } from "./helpers/auth";
import { paginationOptsValidator } from "convex/server";

export const textByKeywords = query({
    args: {
        paginationOpts: paginationOptsValidator,
        keywords: v.string(),
        scope: v.union(
            v.object({ type: v.literal("all") }),
            v.object({ type: v.literal("client"), clientId: v.id("clients") }),
            v.object({ type: v.literal("chat"), chatId: v.id("chats") })
        )
    },
    handler: async (ctx, args) => {
        const caller = await requireHuman(ctx);

        const scopedQuery = ((s) => {
            switch (s.type) {
                case "all":
                    return ctx.db
                        .query("messages")
                        .withSearchIndex("search_text", q =>
                            q.search("text", args.keywords)
                                .eq("userId", caller.id)
                        )
                case "client":
                    return ctx.db
                        .query("messages")
                        .withSearchIndex("search_text", q =>
                            q.search("text", args.keywords)
                                .eq("userId", caller.id)
                                .eq("clientId", s.clientId)
                        )
                case "chat":
                    return ctx.db
                        .query("messages")
                        .withSearchIndex("search_text", q =>
                            q.search("text", args.keywords)
                                .eq("userId", caller.id)
                                .eq("chatId", s.chatId)
                        )
            }
        })(args.scope)

        return await scopedQuery.paginate(args.paginationOpts)
    },
});

export default null;

