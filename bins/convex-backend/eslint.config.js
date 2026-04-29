import convexPlugin from "@convex-dev/eslint-plugin";
import tseslint from "typescript-eslint";
import { nodeTypeScriptConfig } from "../../eslint.config.js";

export default tseslint.config(
  { ignores: ["convex/_generated/"] },
  nodeTypeScriptConfig({ files: ["convex/**/*.ts"] }),
  {
    files: ["convex/**/*.ts"],
    plugins: { "@convex-dev": convexPlugin },
    rules: {
      "@convex-dev/no-old-registered-function-syntax": "error",
      "@convex-dev/require-args-validator": "error",
      "@convex-dev/explicit-table-ids": "error",

      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*/_generated/server"],
              importNames: ["mutation", "internalMutation"],
              message:
                "Use functions.ts: mutation, humanMutation, workerMutation",
            },
            {
              group: ["*/_generated/server"],
              importNames: ["query"],
              message:
                "Use functions.ts: humanQuery, workerQuery. Raw query only allowed in functions.ts and presence.ts",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["convex/functions.ts", "convex/model/presence.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
