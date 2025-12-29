import { ClerkProvider } from "@clerk/clerk-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app.tsx";
import { env } from "./env.ts";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <ClerkProvider
      afterSignOutUrl="/"
      publishableKey={env.VITE_CLERK_PUBLISHABLE_KEY}
    >
      <App />
    </ClerkProvider>
  </StrictMode>
);
