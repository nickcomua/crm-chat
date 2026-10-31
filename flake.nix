{
  description = "CRM Chat web shell and desktop shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    crane.url = "https://flakehub.com/f/ipetkov/crane/0";

    fenix = {
      url = "https://flakehub.com/f/nix-community/fenix/0";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # PR #9 base, nick/kam-43-tdlib. The web test logs in on this website,
    # then redeploys the current one on the same origin.
    prBase.url = "github:nickcomua/crm-chat/d4770a4e547d610cc5868908c24071f275ded4cf";
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
    prBase,
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
        tdlib = pkgs.callPackage ./nix/tdlib.nix {};
        emscripten = pkgs.callPackage ./nix/emscripten.nix {};
        opensslWasm = pkgs.callPackage ./nix/openssl-wasm.nix {inherit emscripten;};
        tdlibWasm = pkgs.callPackage ./nix/tdlib-wasm.nix {
          inherit emscripten opensslWasm;
          tdlibSrc = tdlib.src;
        };
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        nixSrc = pkgs.lib.fileset.toSource {
          root = ./.;
          fileset =
            pkgs.lib.fileset.difference
            (pkgs.lib.fileset.fileFilter (file: file.hasExt "nix") ./.)
            (pkgs.lib.fileset.maybeMissing ./web/repos);
        };
        cargoFiles = pkgs.lib.fileset.unions [
          (pkgs.lib.fileset.difference
            (craneLib.fileset.commonCargoSources ./.)
            (pkgs.lib.fileset.maybeMissing ./integration))
          ./integration/desktop/Cargo.toml
          ./integration/desktop/src
          ./third_party/tdlib-rs/tdlib-rs/tl
        ];
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
            tdlib
          ];
          buildInputs = [
            pkgs.webkitgtk_4_1
            pkgs.openssl
            pkgs.glib-networking
            pkgs.librsvg
            tdlib
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
            fileset = pkgs.lib.fileset.unions [
              ./web/package.json
              ./web/package-lock.json
              ./web/index.html
              ./web/preview.html
              ./web/tsconfig.json
              ./web/vite.config.ts
              ./web/vitest.config.ts
              ./web/eslint.config.js
              ./web/.oxlintrc.json
              ./web/.oxlintrc.effect.json
              ./web/.oxfmtrc.json
              ./web/src
              ./web/public
            ];
          };
          npmDeps = pkgs.importNpmLock {npmRoot = ./web;};
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          npmFlags = [
            "--include=dev"
            "--legacy-peer-deps"
          ];
          preBuild = pkgs.lib.optionalString (system == "x86_64-linux") ''
            mkdir -p public/tdlib
            cp ${tdlibWasm}/td_wasm.js ${tdlibWasm}/td_wasm.wasm public/tdlib/
          '';
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
                  tdlib
                  pkgs.openssl
                  pkgs.zlib
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
        # One cargo test builds both packages. coreTypes and telegramTests are
        # the same derivation so flake check does not compile the workspace twice.
        cargoTests = craneLib.mkCargoDerivation (
          commonArgs
          // {
            pname = "crm-chat-cargo-tests";
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
              export LD_LIBRARY_PATH=${tdlib}/lib:${pkgs.lib.makeLibraryPath [pkgs.openssl pkgs.zlib]}
              cargo test -p crm-chat-core -p crm-chat-telegram --locked
              # Offline half of the desktop integration test. Credentials and
              # saved accounts stay in the integration-test app (network, BWS).
              cargo test -p crm-chat-integration-desktop --locked
              cargo run -p crm-chat-integration-desktop --locked -- shape
            '';
            installPhaseCommand = ''
              mkdir -p $out
              touch $out/checked
            '';
          }
        );
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
          export CRM_CHAT_TDLIB=${tdlib}
          export PKG_CONFIG_PATH=${tdlib}/lib/pkgconfig:${pkgs.openssl.dev}/lib/pkgconfig:${pkgs.zlib.dev}/lib/pkgconfig
          export LD_LIBRARY_PATH=${tdlib}/lib:${pkgs.lib.makeLibraryPath [pkgs.openssl pkgs.zlib]}
          export CRM_CHAT_INVOCATION_DIR="$PWD"
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          exec ${pkgs.bash}/bin/bash ${./integration/run.sh}
        '';
        integrationTestWeb = pkgs.writeShellScript "crm-chat-integration-test-web" ''
          set -euo pipefail
          export PATH=${
            pkgs.lib.makeBinPath [
              pkgs.nodejs
              pkgs.zbar
            ]
          }:$PATH
          export CRM_CHAT_WEBSITE=${website}
          export CRM_CHAT_WEBSITE_PREVIOUS=${
            if system == "x86_64-linux"
            then prBase.packages.${system}.website
            else website
          }
          export CRM_CHAT_WEBSITE_SERVE=${./integration/website_serve.py}
          export CRM_CHAT_PYTHON=${pkgs.python3}/bin/python3
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          export PLAYWRIGHT_CORE=${pkgs.playwright-driver}/index.mjs
          browsers=${pkgs.playwright-driver.browsers}
          playwright_chrome=
          for candidate in "$browsers"/chromium-*/chrome-linux64/chrome "$browsers"/chromium-*/chrome-linux/chrome; do
            if [ -x "$candidate" ]; then
              playwright_chrome=$candidate
              break
            fi
          done
          if [ -z "$playwright_chrome" ]; then
            echo "integration-test-web: Playwright Chromium is missing from the nix package" >&2
            exit 1
          fi
          system_chrome=$(command -v chromium || true)
          if [ -z "$system_chrome" ] || [ ! -x "$system_chrome" ]; then
            echo "integration-test-web: system chromium is not on PATH" >&2
            exit 1
          fi
          if ! command -v secretspec >/dev/null 2>&1; then
            echo "integration-test-web: secretspec is not on PATH" >&2
            exit 1
          fi
          if ! command -v bws >/dev/null 2>&1; then
            echo "integration-test-web: bws is not on PATH" >&2
            exit 1
          fi
          if ! command -v zbarimg >/dev/null 2>&1; then
            echo "integration-test-web: zbarimg is not on PATH" >&2
            exit 1
          fi
          export CRM_CHAT_PLAYWRIGHT_CHROMIUM="$playwright_chrome"
          export CRM_CHAT_SYSTEM_CHROMIUM="$system_chrome"
          export LD_LIBRARY_PATH=${tdlib}/lib:${pkgs.lib.makeLibraryPath [pkgs.openssl pkgs.zlib]}
          export CRM_CHAT_INTEGRATION_BIN="''${XDG_CACHE_HOME:-$HOME/.cache}/crm-chat/integration-target/release/crm-chat-integration-desktop"
          exec secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope app -- \
            ${pkgs.bash}/bin/bash -c ${pkgs.lib.escapeShellArg ''
            set -euo pipefail
            run() {
              echo "integration-test-web: $1"
              CRM_CHAT_CHROMIUM_NAME=$1 \
              CHROMIUM=$2 \
              CRM_CHAT_WEB_SHOTS="$HOME/.local/state/kam-t3/shots/fix-web-connect/$1" \
                ${pkgs.nodejs}/bin/node ${./integration/web-login.mjs}
            }
            run playwright "$CRM_CHAT_PLAYWRIGHT_CHROMIUM"
            run system "$CRM_CHAT_SYSTEM_CHROMIUM"
          ''}
        '';
        loginTestAccount = pkgs.writeShellScript "crm-chat-login-test-account" ''
          set -euo pipefail
          export PATH=${
            pkgs.lib.makeBinPath [
              rustToolchain
              pkgs.pkg-config
              pkgs.gcc
              pkgs.coreutils
              pkgs.util-linux
            ]
          }:$PATH
          export CRM_CHAT_TDLIB=${tdlib}
          export PKG_CONFIG_PATH=${tdlib}/lib/pkgconfig:${pkgs.openssl.dev}/lib/pkgconfig:${pkgs.zlib.dev}/lib/pkgconfig
          export LD_LIBRARY_PATH=${tdlib}/lib:${pkgs.lib.makeLibraryPath [pkgs.openssl pkgs.zlib]}
          export CRM_CHAT_INVOCATION_DIR="$PWD"
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          exec ${pkgs.bash}/bin/bash ${./integration/login.sh} "$@"
        '';
        websiteServe = pkgs.writeShellScript "crm-chat-website-serve" ''
          set -euo pipefail
          if [ "$#" -ne 2 ]; then
            echo "usage: website-serve ROOT PORT" >&2
            exit 1
          fi
          if ! command -v secretspec >/dev/null 2>&1; then
            echo "website-serve: secretspec is not on PATH" >&2
            exit 1
          fi
          if ! command -v bws >/dev/null 2>&1; then
            echo "website-serve: bws is not on PATH" >&2
            exit 1
          fi
          export CRM_CHAT_SECRETS=${./secretspec.toml}
          exec secretspec run -f "$CRM_CHAT_SECRETS" --provider bws --scope app -- \
            ${pkgs.python3}/bin/python3 ${./integration/website_serve.py} "$1" "$2"
        '';
        regenerateTdlibBindings = pkgs.writeShellScript "regenerate-tdlib-bindings" ''
          set -euo pipefail
          if [ ! -f third_party/tdlib-rs/tdlib-rs/tl/api.tl ]; then
            echo "regenerate-tdlib-bindings: run from the crm-chat repository" >&2
            exit 1
          fi
          cp ${tdlib.src}/td/generate/scheme/td_api.tl third_party/tdlib-rs/tdlib-rs/tl/api.tl
          echo "updated third_party/tdlib-rs/tdlib-rs/tl/api.tl from TDLib ${tdlib.version}"
        '';
        # tauri-build only checks that frontendDist exists. Clippy does not need
        # the website, which would pull the wasm TDLib build into this check.
        frontendStub = pkgs.writeTextDir "index.html" "<!doctype html><title></title>\n";
      in {
        formatter = pkgs.alejandra;
        packages =
          {
            inherit website wasm32 tdlib;
            inherit desktop;
            default = desktop;
          }
          // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            inherit emscripten tdlibWasm;
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
          website-serve =
            pkgs.runCommand "crm-chat-website-serve-test" {
              nativeBuildInputs = [pkgs.python3];
            } ''
              python3 ${./integration/website_serve_test.py} ${./integration/website_serve.py}
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
          inherit website wasm32 desktop;
          coreTypes = cargoTests;
          telegramTests = cargoTests;
          integrationOffline = cargoTests;
          integration-desktop-skip = pkgs.runCommand "crm-chat-integration-desktop-skip" {} ''
            CRM_CHAT_SECRET_GATE=env env -u TG_ID -u TG_HASH bash ${./integration/run.sh} >"$TMPDIR/skip.out"
            grep -q 'integration-test: skip (TG_ID and TG_HASH are absent)' "$TMPDIR/skip.out"
            if CRM_CHAT_SECRET_GATE=env env TG_ID=1 TG_HASH= bash ${./integration/run.sh} >"$TMPDIR/bad.out" 2>&1; then
              echo "malformed credentials should fail" >&2
              exit 1
            fi
            if grep -q 'integration-test: skip' "$TMPDIR/bad.out"; then
              echo "malformed credentials skipped" >&2
              exit 1
            fi
            touch $out
          '';
          # Same fetch for native and wasm, and the vendored scheme is that
          # commit's td_api.tl. This does not build either library.
          tdlib-pin =
            pkgs.runCommand "tdlib-pin" {
              nativeSrc = tdlib.src;
              wasmSrc = tdlibWasm.src;
              bindings = ./third_party/tdlib-rs/tdlib-rs/tl/api.tl;
            } ''
              if [ "$nativeSrc" != "$wasmSrc" ]; then
                echo "native TDLib source $nativeSrc does not match wasm source $wasmSrc" >&2
                exit 1
              fi
              cmp "$nativeSrc/td/generate/scheme/td_api.tl" "$bindings"
              touch $out
            '';
          tdlibWasm =
            if system == "x86_64-linux"
            then
              pkgs.runCommand "tdlib-wasm-check" {} ''
                test -s ${tdlibWasm}/td_wasm.js
                test -s ${tdlibWasm}/td_wasm.wasm
                od -An -tx1 -N4 ${tdlibWasm}/td_wasm.wasm | grep -q '00 61 73 6d'
                grep -q createTdwebModule ${tdlibWasm}/td_wasm.js
                grep -q IDBFS ${tdlibWasm}/td_wasm.js
                grep -q ' 3.1.1 ' ${tdlibWasm}/emscripten-version.txt
                touch $out
              ''
            else pkgs.runCommand "tdlib-wasm-skipped" {} "touch $out";
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
              TAURI_CONFIG = builtins.toJSON {build.frontendDist = "${frontendStub}";};
              cargoClippyExtraArgs = "--all-targets -- --deny warnings";
            }
          );
          typescript = website.overrideAttrs {
            pname = "crm-chat-typescript";
            # Typecheck, lint, and vitest do not read the wasm binary. Drop the
            # website preBuild so this check does not wait on tdlibWasm.
            preBuild = "";
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
            tdlib
            pkgs.importNpmLock.hooks.linkNodeModulesHook
          ];
          npmDeps = pkgs.importNpmLock.buildNodeModules {
            npmRoot = ./web;
            inherit (pkgs) nodejs;
          };
        };
        apps = {
          integration-test = {
            type = "app";
            program = "${integrationTest}";
          };
          integration-test-web = {
            type = "app";
            program = "${integrationTestWeb}";
          };
          login-test-account = {
            type = "app";
            program = "${loginTestAccount}";
          };
          regenerate-tdlib-bindings = {
            type = "app";
            program = "${regenerateTdlibBindings}";
          };
          website-serve = {
            type = "app";
            program = "${websiteServe}";
          };
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
