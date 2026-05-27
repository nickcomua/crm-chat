import { SignIn, useAuth, useSignIn } from "@clerk/clerk-react";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { env } from "@/env";

export const Route = createFileRoute("/sign-in")({
	component: SignInPage,
});

/**
 * Auto-sign-in using VITE_TEST_USERNAME / VITE_TEST_PASSWORD env vars.
 * Useful for preview tools that block external Clerk redirects.
 */
function AutoSignIn(): React.ReactNode {
	const { isLoaded, signIn, setActive } = useSignIn();
	const navigate = useNavigate();
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!(isLoaded && signIn)) {
			return;
		}

		const username = env.VITE_TEST_USERNAME;
		const password = env.VITE_TEST_PASSWORD;
		if (!(username && password)) {
			return;
		}

		let cancelled = false;
		signIn
			.create({ identifier: username, password })
			.then((result) => {
				if (cancelled) {
					return;
				}
				if (result.status === "complete" && result.createdSessionId) {
					return setActive({ session: result.createdSessionId }).then(() => {
						navigate({ to: "/chats" });
					});
				}
				setError(`Unexpected sign-in status: ${result.status}`);
			})
			.catch((err: unknown) => {
				if (cancelled) {
					return;
				}
				const message =
					err instanceof Error ? err.message : "Auto sign-in failed";
				setError(message);
			});

		return () => {
			cancelled = true;
		};
	}, [isLoaded, signIn, setActive, navigate]);

	if (error) {
		return (
			<div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
				<p className="text-destructive text-sm">{error}</p>
				<p className="text-muted-foreground text-xs">
					Falling back to standard sign-in...
				</p>
				<SignIn forceRedirectUrl="/#/chats" routing="hash" />
			</div>
		);
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-background">
			<div className="flex flex-col items-center gap-3">
				<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
				<span className="text-muted-foreground text-sm">
					Signing in as {env.VITE_TEST_USERNAME}...
				</span>
			</div>
		</div>
	);
}

/**
 * Tests that need the app to behave as an unauthenticated session (e.g. the
 * auth-guard redirect spec) can disable auto-signin by setting this
 * sessionStorage flag before navigation. Needed because VITE_TEST_USERNAME
 * is baked into the build, so AutoSignIn would otherwise always fire.
 */
const E2E_DISABLE_AUTO_SIGNIN_KEY = "e2e:disable-auto-signin";

function autoSignInDisabled(): boolean {
	return (
		typeof window !== "undefined" &&
		window.sessionStorage?.getItem(E2E_DISABLE_AUTO_SIGNIN_KEY) === "1"
	);
}

function SignInPage(): React.ReactNode {
	const { isLoaded, isSignedIn } = useAuth();
	if (isLoaded && isSignedIn) {
		return <Navigate to="/chats" />;
	}
	if (
		env.VITE_TEST_USERNAME &&
		env.VITE_TEST_PASSWORD &&
		!autoSignInDisabled()
	) {
		return <AutoSignIn />;
	}
	return (
		<div className="flex min-h-screen items-center justify-center bg-background">
			<SignIn forceRedirectUrl="/#/chats" routing="hash" />
		</div>
	);
}
