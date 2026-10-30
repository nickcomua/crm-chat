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
        cargoFiles =
          pkgs.lib.fileset.difference
          (craneLib.fileset.commonCargoSources ./.)
          (pkgs.lib.fileset.maybeMissing ./integration);
        src = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset = cargoFiles;
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
            cargoFiles
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
                pkgs.makeWrapper
                pkgs.patchelf
              ];
            buildPhaseCargoCommand = ''
              mkdir -p web/dist
              cp -a ${website}/. web/dist/
              jq 'del(.build.beforeBuildCommand)' desktop/tauri.conf.json > desktop/tauri.conf.json.new
              mv desktop/tauri.conf.json.new desktop/tauri.conf.json
              cargo tauri build --no-bundle
            '';
            installPhaseCommand = ''
              mkdir -p $out/bin
              install -Dm755 target/release/crm-chat-desktop $out/bin/.crm-chat-desktop-unwrapped
              patchelf --set-rpath "${
                pkgs.lib.makeLibraryPath [
                  pkgs.webkitgtk_4_1
                  pkgs.gtk3
                  pkgs.glib
                  pkgs.cairo
                  pkgs.gdk-pixbuf
                  pkgs.pango
                  pkgs.dbus
                  pkgs.libsoup_3
                  pkgs.librsvg
                ]
              }" $out/bin/.crm-chat-desktop-unwrapped
              makeWrapper $out/bin/.crm-chat-desktop-unwrapped $out/bin/crm-chat-desktop \
                --prefix XDG_DATA_DIRS : "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}" \
                --prefix GIO_EXTRA_MODULES : "${pkgs.glib-networking}/lib/gio/modules"
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
                cargoFiles
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
        integrationNodeModules = pkgs.importNpmLock.buildNodeModules {
          npmRoot = ./web;
          inherit (pkgs) nodejs;
        };
        integrationTest = pkgs.writeShellScript "crm-chat-integration-test" ''
          set -euo pipefail
          export PATH=${
            pkgs.lib.makeBinPath [
              rustToolchain
              pkgs.nodejs
              pkgs.pkg-config
              pkgs.gcc
            ]
          }:$PATH
          export PKG_CONFIG_PATH=${pkgs.openssl.dev}/lib/pkgconfig
          export CRM_CHAT_INVOCATION_DIR="$PWD"
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          export CRM_CHAT_WEB_CHECK=${./integration/web-check.cjs}
          export CRM_CHAT_NODE_MODULES=${integrationNodeModules}
          export CRM_CHAT_DESKTOP_MANIFEST=${./integration/desktop}/Cargo.toml
          exec ${pkgs.bash}/bin/bash ${./integration/run.sh}
        '';
        loginTestAccount = pkgs.writeShellScript "crm-chat-login-test-account" ''
          set -euo pipefail
          export PATH=${
            pkgs.lib.makeBinPath [
              rustToolchain
              pkgs.nodejs
              pkgs.pkg-config
              pkgs.gcc
              pkgs.coreutils
            ]
          }:$PATH
          export PKG_CONFIG_PATH=${pkgs.openssl.dev}/lib/pkgconfig
          export CRM_CHAT_INVOCATION_DIR="$PWD"
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          export CRM_CHAT_DESKTOP_MANIFEST=${./integration/desktop}/Cargo.toml
          export CRM_CHAT_SECRET_STATE=${./integration/secret-state.cjs}
          exec ${pkgs.bash}/bin/bash ${./integration/login.sh} "$@"
        '';
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
          desktop-starts =
            pkgs.runCommand "crm-chat-desktop-starts" {
              nativeBuildInputs = [
                pkgs.xvfb-run
                pkgs.glibc
              ];
            } ''
              elf=${desktop}/bin/.crm-chat-desktop-unwrapped
              if ldd "$elf" | grep -q 'not found'; then
                echo "desktop binary is missing runtime libraries" >&2
                ldd "$elf" >&2
                exit 1
              fi
              export HOME=$TMPDIR/home
              export XDG_RUNTIME_DIR=$TMPDIR/runtime
              export XDG_CONFIG_HOME=$TMPDIR/config
              export XDG_DATA_HOME=$TMPDIR/data
              export XDG_CACHE_HOME=$TMPDIR/cache
              mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
              chmod 700 "$XDG_RUNTIME_DIR"
              set +e
              xvfb-run -a timeout 8s ${desktop}/bin/crm-chat-desktop >"$TMPDIR/desktop.log" 2>&1
              code=$?
              set -e
              if grep -q 'error while loading shared libraries' "$TMPDIR/desktop.log"; then
                cat "$TMPDIR/desktop.log" >&2
                exit 1
              fi
              if [ "$code" != 0 ] && [ "$code" != 124 ]; then
                echo "desktop exited $code" >&2
                cat "$TMPDIR/desktop.log" >&2
                exit 1
              fi
              touch $out
            '';
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
        apps.integration-test = {
          type = "app";
          program = "${integrationTest}";
        };
        apps.login-test-account = {
          type = "app";
          program = "${loginTestAccount}";
        };
      }
    );
  in {
    formatter = nixpkgs.lib.mapAttrs (_: v: v.formatter) perSystem;
    packages = nixpkgs.lib.mapAttrs (_: v: v.packages) perSystem;
    checks = nixpkgs.lib.mapAttrs (_: v: v.checks) perSystem;
    devShells = nixpkgs.lib.mapAttrs (_: v: {default = v.devShells.default;}) perSystem;
    apps = nixpkgs.lib.mapAttrs (_: v: v.apps) perSystem;
  };
}
