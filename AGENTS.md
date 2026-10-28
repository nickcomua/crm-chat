# Agent notes

The web shell is `web/`. Read `web/FOLDKIT.md` and `web/AGENTS.md` before changing it.

Shared core and fixture chat list: `docs/plans/shared-core.md`. Confirmed design; not yet implemented.

Effect and Foldkit skills are installed as real directories in `.agents/skills/`. Foldkit's optional source reference is ignored at `web/repos/foldkit`; the skill files themselves are available in a fresh clone.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `web/node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the guide doesn't cover, search through the source code in `web/node_modules/effect/src`.
