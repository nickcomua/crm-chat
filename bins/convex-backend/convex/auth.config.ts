import type { AuthConfig } from "convex/server";

const domain = process.env.CLERK_JWT_ISSUER_DOMAIN as string;

const authConfig: AuthConfig = {
	providers: [
		{
			// Clerk for human users + Clerk M2M JWTs for worker services
			// Human tokens have sub: "user_*", M2M tokens have sub: "mch_*"
			// Using customJwt without applicationID because Clerk M2M JWTs
			// have aud:[] (empty). Issuer is still validated.
			type: "customJwt",
			issuer: domain,
			jwks: `${domain}/.well-known/jwks.json`,
			algorithm: "RS256",
		},
	],
};

export default authConfig;
