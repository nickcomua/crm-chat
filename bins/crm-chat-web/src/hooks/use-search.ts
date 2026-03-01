import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/clerk-react";
import { createApiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

export type SearchScope = components["schemas"]["SearchScope"];
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchResponse = components["schemas"]["SearchResponse"];

/** Message document source fields returned from Elasticsearch */
export interface MessageSource {
  chat_id?: string;
  client_id?: number;
  content?: string | null;
  created_at?: number;
  external_id?: string;
  id?: string;
  out?: boolean;
  sender_id?: string;
}

interface UseSearchOptions {
  enabled?: boolean;
  from?: number;
  q: string;
  scope?: SearchScope;
  semantic?: boolean;
  size?: number;
}

export function useSearch({
  q,
  scope,
  semantic = false,
  size = 20,
  from = 0,
  enabled = true,
}: UseSearchOptions) {
  const { getToken } = useAuth();

  return useQuery({
    queryKey: ["search", q, scope, semantic, size, from],
    queryFn: async () => {
      const token = getToken ? await getToken() : null;
      if (!token) {
        throw new Error("Not authenticated");
      }
      const client = createApiClient(token);

      const { data, error } = await client.POST("/search/simple", {
        body: {
          q,
          scope,
          semantic,
          size,
          from,
        },
      });

      if (error) {
        throw new Error(
          "error" in error ? error.error : "Search request failed"
        );
      }

      return data;
    },
    enabled: enabled && q.length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useSearchInChat(
  chatId: string,
  q: string,
  options?: Partial<UseSearchOptions>
) {
  return useSearch({
    q,
    scope: { chat: { chat_id: chatId } },
    ...options,
  });
}

export function useSearchInClient(
  clientId: number,
  q: string,
  options?: Partial<UseSearchOptions>
) {
  return useSearch({
    q,
    scope: { client: { client_id: clientId } },
    ...options,
  });
}

export function useSearchAll(q: string, options?: Partial<UseSearchOptions>) {
  return useSearch({
    q,
    scope: "all",
    ...options,
  });
}

export function usePrefetchSearch() {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();

  return async (params: UseSearchOptions) => {
    const { q, scope, semantic = false, size = 20, from = 0 } = params;

    await queryClient.prefetchQuery({
      queryKey: ["search", q, scope, semantic, size, from],
      queryFn: async () => {
        const token = getToken ? await getToken() : null;
        if (!token) {
          throw new Error("Not authenticated");
        }
        const client = createApiClient(token);

        const { data, error } = await client.POST("/search/simple", {
          body: {
            q,
            scope,
            semantic,
            size,
            from,
          },
        });

        if (error) {
          throw new Error(
            "error" in error ? error.error : "Search request failed"
          );
        }

        return data;
      },
      staleTime: 30_000,
    });
  };
}
