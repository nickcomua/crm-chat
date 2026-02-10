const authConfig = {
  providers: [
    {
      // Clerk for human users
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
    {
      // Self-signed RS256 JWT for robot services (telegram-subscriber)
      // issuer must match the `iss` claim in the robot JWT exactly
      // jwks is a data URI containing the RS256 public key (set via env var)
      type: "customJwt" as const,
      issuer: "https://crm-chat-robot.local",
      jwks: process.env.ROBOT_JWKS ?? "",
      algorithm: "RS256" as const,
    },
  ],
};

export default authConfig;
