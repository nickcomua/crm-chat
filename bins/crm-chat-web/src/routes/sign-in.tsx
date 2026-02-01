import { SignIn } from "@clerk/clerk-react";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-in")({
  component: SignInPage,
});

function SignInPage(): React.ReactNode {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <SignIn afterSignInUrl="/#/" routing="hash" signUpUrl="/sign-up" />
    </div>
  );
}
