import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

const ecmaVersion = 2023;

export const commonIgnores = globalIgnores([
  "**/dist/**",
  "**/node_modules/**",
  "**/target/**",
  "**/.direnv/**",
  "**/.devenv/**",
  "**/convex/_generated/**",
]);

export const typescriptConfig = ({
  files = ["**/*.{ts,tsx}"],
  globals: projectGlobals = {},
} = {}) => ({
  files,
  extends: [js.configs.recommended, tseslint.configs.recommended],
  languageOptions: {
    ecmaVersion,
    globals: projectGlobals,
  },
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      },
    ],
  },
});

export const browserTypeScriptConfig = (options = {}) =>
  typescriptConfig({
    files: options.files,
    globals: { ...globals.browser, ...(options.globals ?? {}) },
  });

export const nodeTypeScriptConfig = (options = {}) =>
  typescriptConfig({
    files: options.files,
    globals: { ...globals.node, ...(options.globals ?? {}) },
  });

export const reactConfig = ({
  files = ["**/*.{ts,tsx}"],
  vite = false,
} = {}) => ({
  files,
  extends: [
    reactHooks.configs.flat["recommended-latest"],
    ...(vite ? [reactRefresh.configs.vite] : []),
  ],
  rules: {
    // The React Compiler owns dependency/memoization analysis. Keep the core
    // Rules of Hooks checks from recommended-latest, but don't force manual
    // dependency arrays or manual memoization patterns that the compiler can
    // optimize for us.
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/preserve-manual-memoization": "off",
    "react-hooks/use-memo": "off",

    // These are valid patterns in this app: effects reset local form state
    // from dialog/contact identity changes, and TanStack Virtual is used in a
    // controlled way inside message lists.
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/incompatible-library": "off",
  },
});

export default defineConfig([
  commonIgnores,
  browserTypeScriptConfig(),
  reactConfig({ vite: true }),
]);
