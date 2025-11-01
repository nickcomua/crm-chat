import { RecordId } from "@surrealdb/surrealdb";
import {
	type DefinedUseQueryResult,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	commands,
	events,
	type LiveQueryEvent,
	type LiveQueryRange,
	type LiveQueryTable,
} from "@/bindings";

type LiveAction = "CREATE" | "UPDATE" | "DELETE" | "CLOSE" | "BATCH_CREATE";

type UseLiveQueryOptions<T, TB extends LiveQueryTable> = {
	table: TB;
	range: LiveQueryRange | null;
	enabled?: boolean;
	onEvent?: (action: LiveAction, result: unknown) => void;
	initialData?: Record<string, T>;
	queryKey: string;
};

/**
 * Hook that subscribes via Tauri events to changes in the given table,
 * and keeps a map of id → record in the React Query cache.
 * Returns the map of records keyed by id.
 */
export function useLiveQuery<
TB extends LiveQueryTable,
T extends {
	id: { tb: TB; id: { String: string } };
},
>({
	table,
	range,
	queryKey,
	enabled = true,
	onEvent,
	initialData = {},
}: UseLiveQueryOptions<T, TB>): DefinedUseQueryResult<
	Record<string, T>,
	Error
> {
	const queryClient = useQueryClient();

	const handleEvent = (event: { payload: LiveQueryEvent }) => {
		const { query_key, action, data: dataStr } = event.payload;

		// id: {tb: "chat", id: {String: "telegram:380973781241:1040055501"}}
		if (query_key !== queryKey) {
			return;
		}
		const dataOrBatch = JSON.parse(dataStr) as T[] | T;
		onEvent?.(action, dataOrBatch);
		const prev =
			queryClient.getQueryData<Record<string, T | undefined>>([queryKey]) ?? {};
		const next = { ...prev };
		// console.log("updateCache", action, dataOrBatch);
		if (action === "BATCH_CREATE") {
			for (const item of dataOrBatch as T[]) {
				const id = new RecordId(item.id.tb, item.id.id.String);
				next[id.toString()] = item;
			}
			queryClient.setQueryData([queryKey], next);
			return;
		}
		const data = dataOrBatch as T;
		const id = new RecordId(data.id.tb, data.id.id.String).toString();
		if (action === "CREATE" || action === "UPDATE") {
			// Handle single item - rec is a single T
			next[id] = data as T;
		} else if (action === "DELETE") {
			delete next[id];
		} else if (action === "CLOSE") {
			return;
		}

		queryClient.setQueryData([queryKey], next);
	};
	// Use React Query to hold the live data state
	const query = useQuery<Record<string, T>>({
		queryKey: [queryKey],
		queryFn: async () => {
			const resp = commands.subscribeLiveQuery(queryKey, table, range);
			const unsubscribe = await events.liveQueryEvent.listen(handleEvent);
			await resp;
			unsubscribe();
			return {};
		},
		enabled,
		initialData,
	});

	return query;
}
