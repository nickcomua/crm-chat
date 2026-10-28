# Agent notes

The web shell is `web/`. Read `web/FOLDKIT.md` and `web/AGENTS.md` before changing it.

Before changing shells, the Rust core, or Telegram behavior, read `docs/project-context.md`.

Shared core and fixture chat list: `docs/plans/shared-core.md`. Confirmed design. Local x86_64-linux checks passed; aarch64-linux is evaluated only.

Do not open or update a pull request until the CI job has passed on this machine. A scene test or a lint pass is not a substitute. Run:

```
nix flake check --accept-flake-config --print-build-logs
nix build .#website .#desktop --accept-flake-config --print-build-logs
nix develop --accept-flake-config -c true
```

Effect and Foldkit skills are installed as real directories in `.agents/skills/`. Foldkit's optional source reference is ignored at `web/repos/foldkit`; the skill files themselves are available in a fresh clone.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `web/node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the guide doesn't cover, search through the source code in `web/node_modules/effect/src`.
