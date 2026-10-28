# SecretSpec

Enter the development environment with `nix develop`. It includes SecretSpec
from the pinned nixpkgs input. The official `bws` CLI must be available locally;
it is already installed on this workstation.

`secretspec.toml` declares the optional `CACHIX_AUTH_TOKEN` used by build tooling.
The empty boot shells need no application secrets. No legacy Convex, Clerk, or
Telegram credentials are copied into this project.

Run developer commands with credentials injected only into their process:

    secretspec run --profile default -- COMMAND

The provider and BWS project are selected by the existing user-local
`~/.config/secretspec/config.toml`. The project does not override them. Do not
commit BWS tokens, project-specific credentials, or dotenv files. Avoid injecting
credentials into frontend build commands; Vite variables can become public.

The BWS provider needs either a configured `credentials.access_token` or
`BWS_ACCESS_TOKEN` in the invoking environment. Configure that locally; never
paste the token into chat or put it on a command line.

Verification: the installed SecretSpec finds the existing local BWS provider,
but real resolution currently fails because its access token is unavailable.
The environment-provider smoke test validates the declaration without contacting
BWS or printing secret values. Nix checks and package builds do not require vault
access. GitHub Actions still obtains its cache token from GitHub's secret store;
local BWS configuration is not copied to a runner.
