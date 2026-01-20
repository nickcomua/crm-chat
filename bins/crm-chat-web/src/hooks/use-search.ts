import { useAuth } from "@clerk/clerk-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createApiClient } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";

export type SearchScope = components["schemas"]["SearchScope"];
export type SearchHit = components["schemas"]["SearchHit"];
export type SearchResponse = components["schemas"]["SearchResponse"];

/** Message document source fields returned from Elasticsearch */
export interface MessageSource {
  id?: string;
  external_id?: string;
  chat_id?: string;
  client_id?: number;
  sender_id?: string;
  content?: string | null;
  out?: boolean;
  created_at?: number;
}

interface UseSearchOptions {
  q: string;
  scope?: SearchScope;
  semantic?: boolean;
  size?: number;
  from?: number;
  enabled?: boolean;
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
      const token = await getToken();
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
        const token = await getToken();
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
