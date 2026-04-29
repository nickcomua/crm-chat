import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupUser, createRobotClient } from "./helpers";

const USER_META_FILE = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	".auth/user-meta.json",
);

export default async function globalTeardown(): Promise<void> {
	if (!existsSync(USER_META_FILE)) {
		console.log(
			"[global-teardown] No user-meta.json found — nothing to clean up",
		);
		return;
	}

	let meta: { tokenIdentifier: string };
	try {
		meta = JSON.parse(readFileSync(USER_META_FILE, "utf-8")) as {
			tokenIdentifier: string;
		};
	} catch {
		console.log(
			"[global-teardown] user-meta.json unreadable — skipping cleanup",
		);
		return;
	}

	try {
		const robot = await createRobotClient();
		await cleanupUser(meta.tokenIdentifier, robot);
		console.log(
			`[global-teardown] Cleaned up data for ${meta.tokenIdentifier}`,
		);
	} catch (err) {
		console.warn(`[global-teardown] cleanupUser failed: ${err}`);
	}
}
