# crm-chat-web

React + TypeScript frontend for CRM Chat, built with Vite.

## Stack

- **React** with React Compiler enabled (do NOT use `useMemo`, `useCallback`, or `memo()`)
- **Vite** for bundling and dev server
- **Convex React SDK** for real-time database subscriptions (`useQuery`, `useMutation`)
- **Clerk** for authentication (wrapped with `ConvexProviderWithClerk`)
- **TanStack Router** for file-based routing
- **shadcn/ui** (Radix UI primitives) for components
- **Ultracite** (Biome-based) for linting and formatting

## Development

```bash
# Install dependencies
yarn install

# Start dev server
npx vite dev

# Build for production
npx vite build

# Lint/format
npx ultracite check   # check only
npx ultracite fix     # auto-fix
```

## Environment Variables

Validated with `@t3-oss/env-core` + Zod in `src/env.ts`:

| Variable | Description |
|----------|-------------|
| `VITE_CONVEX_URL` | Convex backend URL (e.g. `http://127.0.0.1:3210`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key |

## Testing

Playwright integration tests live in `tests/`. See [tests/README.md](tests/README.md).
