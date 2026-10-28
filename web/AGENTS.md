# Agent Development Notes

This is a Foldkit app. Read [`FOLDKIT.md`](./FOLDKIT.md) before writing any code in this project. It covers the architecture, the APIs, and the conventions the project is built on.

Foldkit owns `FOLDKIT.md` and replaces it whole on upgrade. This file is yours. Anything you want an agent to know about this project goes below, where an upgrade won't touch it.

`FOLDKIT.md` reads the line below to decide whether it has already offered to vendor the Foldkit source. Leave it in place.

subtree_prompted: true

## Project Notes

This directory is the web shell. The page is an empty Foldkit view. Vocabulary is in the repo-root `GLOSSARY.md`. The confirmed design is `docs/plans/boot-shells.md`.

Foldkit source at `repos/foldkit` is an optional ignored local reference, pinned to the installed release; it is not a submodule and is not tracked by the project. The three Foldkit skills are copied into the repo-root `.agents/skills/` as real files. If source inspection is needed, obtain the matching release from `https://github.com/foldkit/foldkit`. Application imports remain npm package imports.

# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` completely, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the guide doesn't cover, search through the source code in `node_modules/effect/src`.
