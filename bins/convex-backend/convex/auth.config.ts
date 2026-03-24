import type { AuthConfig } from "convex/server";
import { env } from "./env";

const authConfig: AuthConfig = {
  providers: [
    {
      // Clerk for human users + Clerk M2M JWTs for worker services
      // Human tokens have sub: "user_*", M2M tokens have sub: "mch_*"
      // Using customJwt without applicationID because Clerk M2M JWTs
      // have aud:[] (empty). Issuer is still validated.
      type: "customJwt",
      issuer: env.CLERK_JWT_ISSUER_DOMAIN,
      jwks: `${env.CLERK_JWT_ISSUER_DOMAIN}/.well-known/jwks.json`,
      algorithm: "RS256",
    },
  ],
};

export default authConfig;
