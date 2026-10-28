{
  description = "CRM Chat web shell and desktop shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    crane.url = "https://flakehub.com/f/ipetkov/crane/0";

    fenix = {
      url = "https://flakehub.com/f/nix-community/fenix/0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.nixos.org"
      "https://nix-community.cachix.org"
      "https://nickcomua.cachix.org"
    ];
    extra-trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "nickcomua.cachix.org-1:stcsazuAJ0uhVu6i4yXinhDenHEwKngOtystEXf++so="
    ];
  };

  outputs = {
    self,
    nixpkgs,
    crane,
    fenix,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
    ];
    perSystem = nixpkgs.lib.genAttrs systems (
      system: let
        pkgs = import nixpkgs {inherit system;};
        rustToolchain = fenix.packages.${system}.combine [
          (fenix.packages.${system}.latest.withComponents [
            "cargo"
            "clippy"
            "rust-src"
            "rustc"
            "rustfmt"
          ])
          fenix.packages.${system}.targets.wasm32-unknown-unknown.latest.rust-std
        ];
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        nixSrc = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset =
            pkgs.lib.fileset.difference
            (pkgs.lib.fileset.fileFilter (file: file.hasExt "nix") ./.)
            (pkgs.lib.fileset.maybeMissing ./web/repos);
        };
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = craneLib.fileset.commonCargoSources ./.;
        };
        commonArgs = {
          inherit src;
          pname = "crm-chat";
          version = "0.1.0";
          strictDeps = true;
          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.perl
          ];
          buildInputs = [
            pkgs.webkitgtk_4_1
            pkgs.openssl
            pkgs.glib-networking
            pkgs.librsvg
          ];
        };
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;
        appSrc = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = pkgs.lib.fileset.unions [
            (craneLib.fileset.commonCargoSources ./.)
            ./desktop/tauri.conf.json
            ./desktop/capabilities
            ./desktop/icons
          ];
        };

        website = pkgs.buildNpmPackage {
          pname = "crm-chat-website";
          version = "0.1.0";
          src = pkgs.lib.fileset.toSource {
            root = ./web;
            fileset = pkgs.lib.fileset.difference ./web (pkgs.lib.fileset.maybeMissing ./web/repos);
          };
          npmDeps = pkgs.importNpmLock {npmRoot = ./web;};
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmFlags = [
            "--include=dev"
            "--legacy-peer-deps"
          ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r dist/. $out/
            runHook postInstall
          '';
        };

        desktop = craneLib.mkCargoDerivation (
          commonArgs
          // {
            pname = "crm-chat";
            version = "0.1.0";
            src = appSrc;
            inherit cargoArtifacts;
            doInstallCargoArtifacts = false;
            nativeBuildInputs =
              commonArgs.nativeBuildInputs
              ++ [
                pkgs.cargo-tauri
                pkgs.jq
              ];
            buildPhaseCargoCommand = ''
              mkdir -p web/dist
              cp -a ${website}/. web/dist/
              jq 'del(.build.beforeBuildCommand)' desktop/tauri.conf.json > desktop/tauri.conf.json.new
              mv desktop/tauri.conf.json.new desktop/tauri.conf.json
              cargo tauri build --no-bundle
            '';
            installPhaseCommand = ''
              install -Dm755 target/release/crm-chat-desktop "$out/bin/crm-chat-desktop"
            '';
          }
        );

        wasm32 = craneLib.mkCargoDerivation (
          commonArgs
          // {
            pname = "crm-chat-core-wasm32";
            version = "0.1.0";
            doInstallCargoArtifacts = false;
            cargoArtifacts = craneLib.buildDepsOnly (
              commonArgs
              // {
                CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
                cargoExtraArgs = "-p crm-chat-core";
              }
            );
            buildPhaseCargoCommand = ''
              cargo build -p crm-chat-core --locked --target wasm32-unknown-unknown
            '';
            installPhaseCommand = ''
              mkdir -p $out
              touch $out/checked
            '';
          }
        );
        coreTypes = craneLib.mkCargoDerivation (
          commonArgs
          // {
            pname = "crm-chat-core-types";
            version = "0.1.0";
            inherit cargoArtifacts;
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                (craneLib.fileset.commonCargoSources ./.)
                ./web/src/generated/core.ts
              ];
            };
            doInstallCargoArtifacts = false;
            buildPhaseCargoCommand = ''
              cargo test -p crm-chat-core --locked
            '';
            installPhaseCommand = ''
              mkdir -p $out
              touch $out/checked
            '';
          }
        );
      in {
        formatter = pkgs.alejandra;
        packages = {
          inherit website wasm32;
          inherit desktop;
          default = desktop;
        };
        checks = {
          nix-fmt =
            pkgs.runCommand "crm-chat-nix-fmt" {
              nativeBuildInputs = [pkgs.alejandra];
              src = nixSrc;
            } ''
              alejandra --check $src
              touch $out
            '';
          nix-lint =
            pkgs.runCommand "crm-chat-nix-lint" {
              nativeBuildInputs = [pkgs.statix];
              src = nixSrc;
            } ''
              statix check $src
              touch $out
            '';
          inherit website wasm32 coreTypes;
          inherit desktop;
          clippy = craneLib.cargoClippy (
            commonArgs
            // {
              inherit cargoArtifacts;
              src = appSrc;
              TAURI_CONFIG = builtins.toJSON {build.frontendDist = "${website}";};
              cargoClippyExtraArgs = "--all-targets -- --deny warnings";
            }
          );
          typescript = website.overrideAttrs {
            pname = "crm-chat-typescript";
            buildPhase = ''
              npm run typecheck
              npm run lint
              npm run lint:eslint
              npm test
            '';
            installPhase = ''
              mkdir -p $out
              echo ok > $out/ok
            '';
          };
        };
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.nodejs
            pkgs.secretspec
            pkgs.cargo-tauri
            pkgs.pkg-config
            pkgs.webkitgtk_4_1
            pkgs.openssl
            pkgs.importNpmLock.hooks.linkNodeModulesHook
          ];
          npmDeps = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./web;
            inherit (pkgs) nodejs;
          };
        };
      }
    );
  in {
    formatter = nixpkgs.lib.mapAttrs (_: v: v.formatter) perSystem;
    packages = nixpkgs.lib.mapAttrs (_: v: v.packages) perSystem;
    checks = nixpkgs.lib.mapAttrs (_: v: v.checks) perSystem;
    devShells = nixpkgs.lib.mapAttrs (_: v: {default = v.devShells.default;}) perSystem;
  };
}
