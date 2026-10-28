# Agent notes

The web shell is `web/`. Read `web/FOLDKIT.md` and `web/AGENTS.md` before changing it.

Effect skills live in `.agents/skills/`. Foldkit skills link into the ignored local source at `web/repos/foldkit`. A fresh clone must obtain Foldkit's source at the tag matching `web/package.json` before those links can be used. That source is a local reference, not a submodule or application dependency.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `web/node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the guide doesn't cover, search through the source code in `web/node_modules/effect/src`.
