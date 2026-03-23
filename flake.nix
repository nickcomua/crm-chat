{
  description = "Build a cargo project";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";

    crane.url = "https://flakehub.com/f/ipetkov/crane/0";

    flake-utils.url = "https://flakehub.com/f/numtide/flake-utils/0";

    fenix = {
      url = "https://flakehub.com/f/nix-community/fenix/0";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    devenv.url = "github:cachix/devenv";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    advisory-db = {
      url = "github:rustsec/advisory-db";
      flake = false;
    };

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Child flakes
    crm-chat-web-app = {
      url = "path:./bins/crm-chat-web";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  nixConfig = {
    extra-substituters = [
      "https://cache.nixos.org"
      "https://nix-community.cachix.org"
      "https://nickcomua.cachix.org"
      "https://devenv.cachix.org"
    ];
    extra-trusted-public-keys = [
      "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      "nickcomua.cachix.org-1:stcsazuAJ0uhVu6i4yXinhDenHEwKngOtystEXf++so="
      "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw="
    ];
  };

  outputs = {
    self,
    nixpkgs,
    crane,
    flake-utils,
    fenix,
    devenv,
    advisory-db,
    bun2nix,
    crm-chat-web-app,
    ...
  } @ inputs:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [bun2nix.overlays.default];
          #   config.allowUnfree = true;
        };
        # pkgs = nixpkgs.legacyPackages.${system};

        inherit (pkgs) lib;

        # Use fenix to get a complete Rust toolchain with clippy and rustfmt
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

        # Pre-fetch convex-backend node_modules (needed by convex-typegen build.rs
        # to resolve npm imports like convex-helpers when parsing TypeScript)
        convexBackendNodeModules = pkgs.stdenv.mkDerivation {
          pname = "convex-backend-node-modules";
          version = "0.0.0";
          src = pkgs.runCommand "convex-backend-pkg-src" {} ''
            mkdir -p $out
            cp ${./bins/convex-backend/package.json} $out/package.json
            cp ${./bins/convex-backend/bun.lock} $out/bun.lock
          '';
          nativeBuildInputs = [pkgs.bun2nix.hook];
          bunDeps = pkgs.bun2nix.fetchBunDeps {
            bunNix = ./bins/convex-backend/bun.nix;
          };
          dontUseBunBuild = true;
          bunInstallFlags =
            if pkgs.stdenv.hostPlatform.isDarwin
            then ["--backend=copyfile"]
            else [];
          installPhase = ''
            mkdir -p $out
            cp -r node_modules $out/
          '';
        };

        # Include standard Cargo sources plus .ts/.js files needed by convex-backend build.rs
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            (craneLib.fileset.commonCargoSources ./.)
            (lib.fileset.fileFilter (file: file.hasExt "ts" || file.hasExt "js") ./bins/convex-backend/convex)
          ];
        };

        # Common arguments can be set here to avoid repeating them later
        commonArgs = {
          inherit src;
          strictDeps = true;

          preConfigure = ''
            # Link node_modules for convex-backend (convex-typegen build.rs resolves npm imports)
            ln -s ${convexBackendNodeModules}/node_modules bins/convex-backend/node_modules

            # Bun needs a writable HOME for its module compilation cache
            export HOME=$(mktemp -d)
          '';

          nativeBuildInputs = [
            pkgs.lld
            pkgs.rustfmt
            pkgs.pkg-config
            pkgs.perl # Required by openssl-sys vendored build
            pkgs.bun # Required by convex-typegen build.rs to parse TypeScript
            #   pkgs.gtk4.dev
            #   pkgs.gtk3.dev
            #   pkgs.llvmPackages.libclang
            #   pkgs.lld
          ];

          buildInputs =
            [
              pkgs.openssl
              pkgs.cacert
              pkgs.sqlite
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              # Additional darwin specific inputs can be set here
              pkgs.libiconv
            ];

          SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        };

        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        individualCrateArgs =
          commonArgs
          // {
            inherit cargoArtifacts;
            inherit (craneLib.crateNameFromCargoToml {inherit src;}) version;
            # NB: we disable tests since we'll run them all via cargo-nextest
            doCheck = false;
          };

        fileSetForCrate = crate:
          lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./Cargo.toml
              ./Cargo.lock
              (craneLib.fileset.commonCargoSources ./libs/hack)

              (craneLib.fileset.commonCargoSources ./bins/convex-backend)
              # Include .ts/.js files needed by convex-backend build.rs (convex-typegen)
              (lib.fileset.fileFilter (file: file.hasExt "ts" || file.hasExt "js") ./bins/convex-backend/convex)

              (craneLib.fileset.commonCargoSources ./libs/messanger-interface)
              (craneLib.fileset.commonCargoSources ./libs/messanger-telegram)
              (craneLib.fileset.commonCargoSources ./tests/e2e-telegram)
              (craneLib.fileset.commonCargoSources crate)
            ];
          };

        # Build crm-worker binary
        crm-worker = craneLib.buildPackage (
          individualCrateArgs
          // {
            pname = "crm-worker";
            cargoExtraArgs = "-p crm-worker";
            src = fileSetForCrate ./bins/crm-worker;
            nativeBuildInputs = (commonArgs.nativeBuildInputs or []) ++ [pkgs.makeWrapper];
            postFixup = ''
              ${lib.optionalString pkgs.stdenv.isLinux ''
                patchelf --add-rpath ${pkgs.sqlite.out}/lib $out/bin/crm-worker
              ''}
              wrapProgram $out/bin/crm-worker \
                --set SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            '';
          }
        );
        inherit (crm-chat-web-app.packages.${system}) crm-chat-web crm-chat-web-img;
      in {
        checks =
          {
            inherit crm-worker;
            # crm-chat-web build requires convex-backend generated types outside sandbox
            inherit (crm-chat-web-app.checks.${system}) crm-chat-web-lint;
            crm-chat-clippy = craneLib.cargoClippy (
              commonArgs
              // {
                inherit cargoArtifacts;
                cargoClippyExtraArgs = "--all-targets -- --deny warnings";
              }
            );

            crm-chat-doc = craneLib.cargoDoc (
              commonArgs
              // {
                inherit cargoArtifacts;
                # This can be commented out or tweaked as necessary, e.g. set to
                # `--deny rustdoc::broken-intra-doc-links` to only enforce that lint
                env.RUSTDOCFLAGS = "--deny warnings";
              }
            );

            crm-chat-fmt = craneLib.cargoFmt {
              inherit src;
            };

            crm-chat-audit = craneLib.cargoAudit {
              inherit src advisory-db;
            };

            crm-chat-deny = craneLib.cargoDeny {
              inherit src;
            };

            crm-chat-nextest = craneLib.cargoNextest (
              commonArgs
              // {
                inherit cargoArtifacts;
                # Exclude convex-backend: its integration tests need Docker (run locally)
                cargoExtraArgs = "--workspace --exclude convex-backend";
                partitions = 1;
                partitionType = "count";
                cargoNextestPartitionsExtraArgs = "--no-tests=pass";
                # Set LD_LIBRARY_PATH so test binaries can find libsqlite3.so at runtime
                preCheck = ''
                  export LD_LIBRARY_PATH="${pkgs.sqlite.out}/lib:$LD_LIBRARY_PATH"
                '';
                # __noChroot = true;
                # TG_API_ID_1 = builtins.getEnv "TG_API_ID_1";
                # TG_API_HASH_1 = builtins.getEnv "TG_API_HASH_1";
                # TG_API_ID_2 = builtins.getEnv "TG_API_ID_2";
                # TG_API_HASH_2 = builtins.getEnv "TG_API_HASH_2";

                # TG_SESSION_FILE_1 = let path = builtins.getEnv "TG_SESSION_FILE_1"; in
                #   if path != "" then builtins.path { path = path; name = "tg_session_1"; } else "";
                # TG_SESSION_FILE_2 = let path = builtins.getEnv "TG_SESSION_FILE_2"; in
                #   if path != "" then builtins.path { path = path; name = "tg_session_2"; } else "";
              }
            );
          }
          // {
            # Check that all Nix files are formatted with alejandra
            crm-chat-nix-fmt =
              pkgs.runCommand "crm-chat-nix-fmt" {
                nativeBuildInputs = [pkgs.alejandra];
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.fileFilter (file: file.hasExt "nix") ./.;
                };
              } ''
                alejandra --check $src
                touch $out
              '';

            # Lint Nix files with statix
            crm-chat-statix =
              pkgs.runCommand "crm-chat-statix" {
                nativeBuildInputs = [pkgs.statix];
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.fileFilter (file: file.hasExt "nix") ./.;
                };
              } ''
                statix check $src
                touch $out
              '';

            crm-chat-hakari = craneLib.mkCargoDerivation {
              inherit src;
              pname = "crm-chat-hakari";
              cargoArtifacts = null;
              doInstallCargoArtifacts = false;

              buildPhaseCargoCommand = ''
                cargo hakari generate --diff  # workspace-hack Cargo.toml is up-to-date
                cargo hakari manage-deps --dry-run  # all workspace crates depend on workspace-hack
                cargo hakari verify
              '';

              nativeBuildInputs = [
                pkgs.cargo-hakari
              ];
            };
          };
        packages = {
          inherit crm-worker crm-chat-web crm-chat-web-img;

          crm-worker-img = pkgs.dockerTools.buildLayeredImage {
            name = "nick395/crm-worker";
            tag = "latest";
            contents = [crm-worker];

            config = {
              Cmd = ["/bin/crm-worker"];
            };
          };
        };
        formatter = pkgs.alejandra;
        devShells.default = devenv.lib.mkShell {
          inherit inputs pkgs;
          modules = [
            ({
              pkgs,
              lib,
              ...
            }: {
              devenv.root = lib.mkForce (builtins.getEnv "PWD");

              # Rust toolchain (replaces fenix in dev shell)
              languages.rust = {
                enable = true;
                channel = "stable";
                components = ["rustc" "cargo" "clippy" "rustfmt" "rust-analyzer" "rust-src"];
                targets = ["wasm32-unknown-unknown"];
              };

              # Environment variables
              env.LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";

              enterShell = ''
                export PATH="$HOME/.local/bin:$PATH"
                export LD_LIBRARY_PATH="${pkgs.openssl.out}/lib:${pkgs.sqlite.out}/lib:''${LD_LIBRARY_PATH:-}"
              '';

              # Inherit from child flake dev shells
              inputsFrom = [
                crm-chat-web-app.devShells.${system}.default
              ];

              packages = with pkgs; [
                openssl
                bun
                taplo
                cargo-hakari
                cargo-audit
                cargo-watch
                cargo-sweep
                cargo-nextest
                biome
                pkg-config
                llvmPackages.libclang
                lld
                sqlite
                alejandra
                statix
              ];

              cachix = {
                enable = true;
                pull = ["nickcomua"];
                push = "nickcomua";
              };
            })
          ];
        };
      }
    );
}
