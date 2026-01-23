import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
} from "@clerk/clerk-react";
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage(): React.ReactNode {
  return (
    <>
      <SignedOut>
        <LoginPage />
      </SignedOut>
      <SignedIn>
        <Navigate to="/chats" />
      </SignedIn>
    </>
  );
}

function LoginPage(): React.ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md space-y-8 px-4">
        <div className="text-center">
          <h1 className="font-bold text-4xl text-foreground tracking-tight">
            CRM Chat
          </h1>
          <p className="mt-2 text-muted-foreground">
            Manage your Telegram clients
          </p>
        </div>
        <div className="flex flex-col gap-4">
          <SignInButton mode="modal">
            <button
              className="w-full rounded-lg bg-primary px-4 py-3 font-medium text-primary-foreground text-sm transition-colors hover:bg-primary/90"
              type="button"
            >
              Sign In
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button
              className="w-full rounded-lg border border-input bg-background px-4 py-3 font-medium text-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
              type="button"
            >
              Create Account
            </button>
          </SignUpButton>
        </div>
      </div>
    </div>
  );
}
