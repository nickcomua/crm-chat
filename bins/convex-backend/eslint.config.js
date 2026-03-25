import convexPlugin from "@convex-dev/eslint-plugin";
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["convex/_generated/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["convex/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    plugins: { "@convex-dev": convexPlugin },
    rules: {
      "@convex-dev/no-old-registered-function-syntax": "error",
      "@convex-dev/require-args-validator": "error",
      "@convex-dev/explicit-table-ids": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["*/_generated/server"],
              importNames: ["mutation", "internalMutation"],
              message: "Use functions.ts for mutation",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["convex/functions.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  }
);
