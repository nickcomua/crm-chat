import * as effect from "@effect/eslint-plugin/plugin";
import disableConflictRules from "@effect/eslint-plugin/configs/disable-conflict-rules";
import parser from "@typescript-eslint/parser";

export default [
  ...disableConflictRules,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser,
    },
    plugins: {
      "@effect": effect,
    },
    rules: {
      "@effect/no-import-from-barrel-package": [
        "error",
        { packageNames: ["effect"] },
      ],
      // Foldkit formats with oxfmt. The plugin's dprint rule fights that.
      "@effect/dprint": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "repos/**"],
  },
];
