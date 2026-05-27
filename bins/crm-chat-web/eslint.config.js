import { defineConfig, globalIgnores } from "eslint/config";
import { browserTypeScriptConfig, reactConfig } from "../../eslint.config.js";

export default defineConfig([
	globalIgnores(["dist"]),
	browserTypeScriptConfig(),
	reactConfig({ vite: true }),
]);
