import { type PreparedQuery, Surreal, Uuid } from "@surrealdb/surrealdb";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

type SurrealProviderProps = {
	children: React.ReactNode;
	/** The database endpoint URL */
	endpoint: string;
	/** Optional existing Surreal client */
	client?: Surreal;
	/* Optional connection parameters */
	params?: Parameters<Surreal["connect"]>[1];
	/** Auto connect on component mount, defaults to true */
	autoConnect?: boolean;
};

type SurrealProviderState = {
	/** The Surreal instance */
	client: Surreal;
	/** Whether the connection is pending */
	isConnecting: boolean;
	/** Whether the connection was successfully established */
	isSuccess: boolean;
	/** Whether the connection rejected in an error */
	isError: boolean;
	/** The connection error, if present */
	error: unknown;
	/** Connect to the Surreal instance */
	connect: () => Promise<true>;
	/** Close the Surreal instance */
	close: () => Promise<true>;
	params?: Parameters<Surreal["connect"]>[1];
	endpoint: string;
};

const SurrealContext = createContext<SurrealProviderState | undefined>(
	undefined
);

export function SurrealProvider({
	children,
	client,
	endpoint,
	params,
	autoConnect = true,
}: SurrealProviderProps) {
	// Surreal instance remains stable across re-renders
	const [surrealInstance] = useState(() => client ?? new Surreal());
	// React Query mutation for connecting to Surreal
	const {
		mutateAsync: connectMutation,
		isPending,
		isSuccess,
		isError,
		error,
		reset,
	} = useMutation({
		mutationFn: () => surrealInstance.connect(endpoint, params),
	});

	// Wrap close() in a stable callback
	const close = () => surrealInstance.close();

	// Auto-connect on mount (if enabled) and cleanup on unmount
	useEffect(() => {
		if (autoConnect) {
			connectMutation();
		}

		return () => {
			reset();
			console.log("useSurreal: closing surreal instance");
			surrealInstance.close();
		};
	}, [autoConnect, reset, connectMutation, surrealInstance]);

	return (
		<SurrealContext.Provider
			value={{
				client: surrealInstance,
				isConnecting: isPending,
				isSuccess,
				isError,
				error,
				connect: connectMutation,
				close,
				params,
				endpoint,
			}}
		>
			{children}
		</SurrealContext.Provider>
	);
}

/**
 * Access the Surreal connection state from the context.
 */
export function useSurreal() {
	const context = useContext(SurrealContext);
	if (!context) {
		throw new Error("useSurreal must be used within a SurrealProvider");
	}
	return context;
}

/**
 * Access the Surreal client from the context.
 */
export function useSurrealClient() {
	const { client } = useSurreal();
	return client;
}

type LiveAction = "CREATE" | "UPDATE" | "DELETE" | "CLOSE";

type LiveNotification<T> = {
	action: LiveAction;
	result: T | { patches: any[] }; // if diff mode maybe patches
};

type UseLiveQueryOptions<T> = {
	query: PreparedQuery;
	liveQuery: PreparedQuery;
	diff?: boolean;
	enabled?: boolean;
	onEvent?: (action: LiveAction, result: any) => void;
	initialData?: Record<string, T>;
	queryKey: readonly unknown[];
};

/**
 * Hook that subscribes via SurrealDB .live() to changes in the given table,
 * and keeps a map of id → record in the React Query cache.
 * Returns the map of records keyed by id.
 */
export function useLiveQuery<T extends { id: Uuid | string }>(
	opts: UseLiveQueryOptions<T>
): { data: Record<string, T | undefined>; isSubscribed: boolean } {
	const {
		query: preperedQuery,
		liveQuery: livePreparedQuery,
		queryKey,
		diff = false,
		enabled = true,
		onEvent,
		initialData = {},
	} = opts;

	// const { endpoint, params } = useSurreal();
	// const [client] = useState(new Surreal())
	const client = useSurrealClient();
	const queryClient = useQueryClient();
	const subscriptionIdRef = useRef<string | null>(null);
	const isSubscribedRef = useRef(false);
	// Use React Query to hold the live data state
	const query = useQuery<Record<string, T | undefined>>({
		queryKey,
		queryFn: async () => {
			// Initialize with initialData
			return { ...initialData };
		},
		enabled,
		// we won't refetch (live updates will keep it fresh)
		staleTime: Number.POSITIVE_INFINITY,
	});

	// useEffect(() => {
	//     client.connect(endpoint, params)
	// }, [endpoint, params, client])
	useEffect(() => {
		if (!enabled) {
			return;
		}
		if (!client) {
			console.warn("useLiveQuery: no Surreal client available");
			return;
		}

		isSubscribedRef.current = true;

		const handleEvent = (action: LiveAction, result: any) => {
			// allow callback hook
			// console.log('useLiveQuery: live event', action, result);
			onEvent?.(action, result);

			// get current data
			const prev =
				queryClient.getQueryData<Record<string, T | undefined>>(queryKey) ?? {};

			const next = { ...prev };

			switch (action) {
				case "CREATE": {
					const rec = result as T;
					next[rec.id.toString()] = rec;
					break;
				}
				case "UPDATE": {
					const rec = result as T;
					next[rec.id.toString()] = rec;
					break;
				}
				case "DELETE": {
					const rec = result as T;
					// some records might return only id or something; adjust accordingly
					delete next[rec.id.toString()];
					break;
				}
				case "CLOSE": {
					// subscription closed: we might want to clear or leave as is
					isSubscribedRef.current = false;
					break;
				}
				default:
					break;
			}

			queryClient.setQueryData(queryKey, next);
		};

		// Subscribe live
		(async () => {
			try {
				await client.ready;
				const subId = (await client.query(livePreparedQuery))[0] as Uuid;
				// console.log('useLiveQuery: subId', subId);
				client.subscribeLive(subId, handleEvent);
				// client.
				subscriptionIdRef.current = subId.toString();
				const res = await client.query(preperedQuery);
				const rows = res?.[0] ?? [];
				const mapped: Record<string, T> = {};
				for (const rec of rows as any[]) {
					mapped[rec.id.toString()] = rec;
				}
				queryClient.setQueryData(queryKey, mapped);
			} catch (err) {
				console.error("useLiveQuery: error in live subscription", err);
			}
		})();

		return () => {
			// cleanup
			// console.log('useLiveQuery: cleaning up');
			const subId = subscriptionIdRef.current;
			if (subId) {
				client.kill(new Uuid(subId)).catch((err) => {
					console.warn("useLiveQuery: error killing live subscription", err);
				});
			}
			isSubscribedRef.current = false;
		};
	}, [
		client,
		enabled,
		queryClient,
		livePreparedQuery, // allow callback hook
		// console.log('useLiveQuery: live event', action, result);
		onEvent,
		preperedQuery,
		queryKey,
	]);

	return { data: query.data ?? {}, isSubscribed: isSubscribedRef.current };
}
