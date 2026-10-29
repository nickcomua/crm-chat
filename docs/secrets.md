# SecretSpec

Enter the development environment with `nix develop`. It includes SecretSpec
from the pinned nixpkgs input. The official `bws` CLI must be available locally;
it is already installed on this workstation.

## Profiles

`secretspec.toml` declares one set of secrets on `[profiles.default]`.
`[profiles.nixos]` inherits that set and adds nothing of its own.

The user-local config `~/.config/secretspec/config.toml` selects profile
`nixos` when a command omits `--profile`. That name did not used to exist in
this repo, so a bare `secretspec run` looked for a profile the manifest did
not declare. Declaring `nixos` settles that. `--profile default` still
resolves the same declarations, because `nixos` inherits `default` and the BWS
provider stores flat key names rather than profile-prefixed ones.

The same user config defines a provider alias `bws` and does not set
`[defaults] provider`. SecretSpec therefore does not select BWS unless the
command passes `--provider bws`. The project does not commit a provider URI,
a project ID, or an access token. Do not add them to close this gap.

## What is declared

Application credentials, the same key names the legacy worker read:

- `TG_ID` — Telegram application API ID. Required.
- `TG_HASH` — Telegram application API hash. Required.

Integration-test account material, optional so a missing test secret does not
block the app:

- `TG_API_ID_1`, `TG_API_HASH_1`, `TG_SESSION_FILE_1`, `TG_USER_ID_1`
- `TG_API_ID_2`, `TG_API_HASH_2`, `TG_SESSION_FILE_2`

`CACHIX_AUTH_TOKEN` remains optional build-tooling material. GitHub Actions
still reads that token from GitHub's secret store. Local BWS configuration is
not copied to a runner. Nix checks and package builds do not need vault access.

No Clerk, Convex, or other legacy credentials are declared.

## Scopes

`secretspec run` without `--scope` injects every secret in the active profile.
Use a scope so a shell does not receive test-account material.

Web and desktop:

    secretspec run --provider bws --scope app -- COMMAND

Integration tests, when those tickets land:

    secretspec run --provider bws --scope integration -- COMMAND

Run the command from this repository so SecretSpec finds `secretspec.toml`.
`--profile nixos` is optional on this workstation because the user config
already selects it. Pass `--profile default` on a machine whose user config
selects `default`.

## Runtime only

Do not pass `TG_ID` or `TG_HASH` as `VITE_` variables, Vite `define` entries,
or `import.meta.env`. Vite inlines those into the client bundle, and the
static website package would then contain them.

The web dev and preview servers read the process environment at request time
and answer `GET /runtime/telegram-app`. Bind that server to localhost. The
desktop process reads the same variables when the page invokes
`telegram_app_credentials`. Neither path runs during `vite build` or
`nix build`.

Start the web shell from this repo:

    secretspec run --provider bws --scope app -- npm run dev --prefix web -- --host 127.0.0.1 --port 4173 --strictPort

Start the desktop shell the same way, with the Tauri or Nix command in place
of `npm run dev`. The installed Nix binary does not contain the credentials.
Launch it under `secretspec run` from this repo if it should see them.

If the variables are absent, the page still accepts an API ID and hash typed
for that tab. Those values stay in tab memory and are not written back to BWS.

## Providing values

Store values in the BWS project selected by the user-local `bws` alias. From
this repo:

    secretspec set TG_ID --provider bws

SecretSpec prompts for the value. Do not pass the value as an argument: the
BWS CLI can place it on a process command line. Do not paste it into chat,
tickets, pull requests, or commits. Repeat for `TG_HASH` and any
integration-test key you need to rotate.

Check resolution without printing values:

    secretspec check --provider bws --json --no-prompt

A required secret that is missing makes that command fail. Optional test
secrets may be missing. The access token comes from the user-local provider
credential or from `BWS_ACCESS_TOKEN` in the invoking environment. Configure
that locally; never paste the token into chat or put it on a command line.
