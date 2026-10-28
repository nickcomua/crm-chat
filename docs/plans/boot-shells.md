# Boot both shells

Status: confirmed design, with local x86_64-linux verification completed. GitHub CI and cutover remain pending.

Implementation is authorized. Acceptance is `nix build` of the website and desktop package, plus `nix develop` and `nix flake check`. AppImage was withdrawn.

Interview record for [KAM-40](https://linear.app/kaminazuma/issue/KAM-40/boot-both-shells-in-a-new-monorepo). Parent design: [KAM-39](https://linear.app/kaminazuma/issue/KAM-39/plan-a-refactor). These three files live in the new repo. Do not commit them to the legacy history.

## Accepted

- New GitHub repo: public `nickcomua/crm-chat` at `~/Documents/crm-chat`, empty history. Nothing is imported. A GitHub ruleset blocks direct pushes to `main` for everyone, including admins. `main` moves only by pull-request merge. The legacy repo does not get this rule. See [ADR 0001](../adr/0001-repo-cutover.md).
- The implementing agent renames, moves, retargets, creates, protects `main`, archives, then makes the legacy repo private. Deletes nothing.
- Old GitHub repo is renamed to `nickcomua/crm-chat-legacy`. It is archived as soon as the new repo exists, before either shell has booted, then made private. It is not deleted. The local move is the refactor reference.
- The local checkout moves to `~/Documents/crm-chat-legacy`. Orca worktrees are retargeted to that path. Nothing local is deleted. The primary checkout's uncommitted work, `.env`, and session files move with it.
- The page is an empty Foldkit view. The browser SPA scaffolder's example is replaced. Starter Tailwind, Effect linters, `AGENTS.md`, and `FOLDKIT.md` stay. No fixed title, no shell label, no chat-list sketch.
- Acceptance is `nix build`, not `nix run`. A launched window is not required. Flake package outputs are the website and a Nix package of the Tauri app. The Nix package is the Tauri app. AppImage is not an output; it was withdrawn on 2026-10-28. One dev shell, `devShells.default`, is entered with `nix develop` and is not a `nix build` package. macOS and Windows packages are not this ticket's acceptance.
- The built Tauri artifacts include the website build, so running one opens the empty page. That run is not the acceptance test.
- The agent may open pull requests. It must not merge to `main` and must not push `main`. You merge.
- The new repo is created with this glossary, ADR, and plan. They are not committed to the legacy history.
- The wasm32 crate is a flake-check placeholder. KAM-41 removes it and adds the real core. This ticket does not generate TypeScript types or render a fixture chat list. No Telegram.

## Still proposed

None.

## Inherited, not re-opened

From KAM-39: Foldkit on Effect, no React, Effect linters, Foldkit agent docs and help tooling, npm via `buildNpmPackage` and `importNpmLock`, Tauri 2, Linux and wasm32 are the release targets, no Convex, no Clerk, no worker.

## Not this ticket

KAM-41 owns the Rust core, generated types, and the fixture chat list. Login, chats, history, send, and media are later tickets. The old messenger trait is not ported.

## Unresolved technical parameters

None left open as product choices. Implementation settled these, pending the desktop build:

- Web app: `web/`. Desktop crate: `desktop/`. wasm32 placeholder: `crates/wasm-check`, removed by KAM-41.
- Rust packaging follows the old repo: crane, fenix, and `craneLib.cargoClippy` with `--all-targets -- --deny warnings`. The desktop uses `cargo tauri build --no-bundle` through crane. Deb and AppImage are withdrawn and are not outputs.
- Checks, on `x86_64-linux` and `aarch64-linux`: `checks.website`, `checks.wasm32`, `checks.desktop`, `checks.clippy`, `checks.typescript` (`tsc --strict`, Foldkit oxlint, and `@effect/eslint-plugin`). A pull request cannot merge unless the `check` workflow is green. The ruleset that requires that status is applied when the new repo is created.

## Review decisions

The deb was withdrawn after review confirmed its executable requires a Nix-store loader and cannot run on an ordinary Debian/Ubuntu installation. No distro package is required for this ticket. Final desktop and WASM outputs no longer retain Cargo artifact archives. Generated root `node_modules/` entries are ignored and removed from tracking without deleting the installed dependencies.

## Verification

- Local `nix flake check --accept-flake-config --keep-going` passed all seven checks: website, desktop, wasm32, Clippy (all targets, deny warnings), TypeScript (strict compiler, Foldkit/Effect oxlint, Effect ESLint, tests), Nix formatting (Alejandra), and Nix linting (Statix).
- Nix checks cover repository-owned `.nix` files and exclude the read-only vendored `web/repos` tree. `nix fmt -- flake.nix` uses the pinned Alejandra formatter. The existing CI invocation of `nix flake check` includes both new gates.
- `nix build .#website .#desktop --accept-flake-config --print-out-paths` passed after removing the deb:
  - Website: `/nix/store/56gv0h34jr6ld8qmgnadjc1yi06wjg65-crm-chat-website-0.1.0`.
  - Desktop: `/nix/store/hxcgx147dniinbci1rzf0q3ph7ly906j-crm-chat-0.1.0`.
- `nix develop --accept-flake-config -c true` passed with the current flake.
- The Effect ESLint plugin runs using the documented TypeScript 6 API alias (`typescript` → `@typescript/typescript6`); `@typescript/native` supplies TypeScript 7's `tsc`. Both lint and strict checking passed. The plugin is now included in the Nix check.
- Local npm strict checking, both lint pipelines, the single test, and production build passed.
- AppImage is withdrawn and absent from the flake, Tauri targets, and CI.
- aarch64-linux has only been evaluated, not built. GitHub-hosted CI, cache upload/restore, and required-status enforcement are not yet verified.
- Cutover has not started. Nothing has been renamed, moved, archived, or deleted.

## CI

In scope. `.github/workflows/check.yml` uses Determinate's Nix installer and `cachix/cachix-action` for `nickcomua`, pulling `nix-community` as well. The flake `nixConfig` trusts `cache.nixos.org`, `nix-community.cachix.org`, and `nickcomua.cachix.org`. The job runs `nix flake check` (website, wasm32, clippy, strict TypeScript, Foldkit oxlint, `@effect/eslint-plugin`), builds the website and the Tauri package, and enters the dev shell. The new repo's ruleset requires this `check` status before merge, in addition to blocking direct pushes to `main`. macOS is not a required runner.

## Cutover and build order

1. Rename GitHub `crm-chat` to `crm-chat-legacy`.
2. Move `~/Documents/crm-chat` to `~/Documents/crm-chat-legacy` and retarget the orca worktrees. Delete nothing.
3. Create the new public repo at `~/Documents/crm-chat` with empty history, and copy this interview record into it.
4. Forbid direct pushes to `main`, and require the `check` status before a pull request can merge.
5. Archive `crm-chat-legacy`, then make it private. GitHub's API rejects a visibility change while archived, so the end state is reached by unarchive, make private, re-archive.
6. `nix build` the website and the Tauri Nix package. `nix develop` enters the dev shell. `nix flake check` runs clippy and the strict TypeScript check.

Making the legacy repo private erases its stars. `nickcomua/crm-chat-legacy` did not exist on GitHub when this was written. The old repo was public, default branch `main`.

The Documents checkout, the boot worktree, and the kam-39 worktree are three colocated jj repos, not one shared jj workspace. The move keeps each `.jj`. Retarget the git worktree pointers. Do not initialize a new jj repo in the legacy checkouts.

