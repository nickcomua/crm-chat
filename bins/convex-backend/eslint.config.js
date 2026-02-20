import tseslint from "typescript-eslint";
import convexPlugin from "@convex-dev/eslint-plugin";

export default tseslint.config(
	{ ignores: ["convex/_generated/"] },
	...tseslint.configs.recommended,
	{
		files: ["convex/**/*.ts"],
		plugins: { "@convex-dev": convexPlugin },
		rules: {
			"@convex-dev/no-old-registered-function-syntax": "error",
			"@convex-dev/require-args-validator": "error",
			"@convex-dev/explicit-table-ids": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
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
	},
);
