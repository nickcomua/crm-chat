const authConfig = {
  providers: [
    {
      // Clerk for human users
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    {
      // Self-signed RS256 JWT for worker services (crm-worker)
      // issuer must match the `iss` claim in the worker JWT exactly
      // jwks is a data URI containing the RS256 public key (set via env var)
      // TODO: migrate to Clerk M2M JWTs when Clerk ships JWT-format M2M tokens
      type: "customJwt" as const,
      issuer: "https://crm-chat-robot.local",
      jwks: process.env.ROBOT_JWKS ?? "",
      algorithm: "RS256" as const,
    },
  ],
};

export default authConfig;
