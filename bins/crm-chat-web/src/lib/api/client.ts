import createClient, { type Middleware } from "openapi-fetch";
import { env } from "@/env";
import type { paths } from "./schema";

export function createApiClient(token: string | null) {
  const client = createClient<paths>({
    baseUrl: env.VITE_ES_PROXY_URL,
  });

  if (token) {
    const authMiddleware: Middleware = {
      onRequest: ({ request }) => {
        request.headers.set("Authorization", `Bearer ${token}`);
        return request;
      },
    };
    client.use(authMiddleware);
  }

  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
