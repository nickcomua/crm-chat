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

    devenv-root = {
      url = "file+file:///dev/null";
      flake = false;
    };

    nix2container = {
      url = "github:nlewo/nix2container";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    mk-shell-bin.url = "github:rrbutani/nix-mk-shell-bin";

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
    devenv-root,
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
              pkgs.dbus
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
            inherit (crm-chat-web-app.checks.${system}) crm-chat-web-lint crm-chat-convex-backend-lint;
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
              config,
              ...
            }: let
              # Shorthand for allocated port values
              restatePorts = config.processes.restate.ports;
              backendPorts = config.processes.backend.ports;
              dashboardPorts = config.processes.dashboard.ports;
              workerPorts = config.processes.crm-worker.ports;
            in {
              devenv.root = let
                devenvRoot = builtins.readFile devenv-root.outPath;
              in
                pkgs.lib.mkIf (devenvRoot != "") devenvRoot;

              # Rust toolchain (replaces fenix in dev shell)
              languages.rust = {
                enable = true;
                channel = "stable";
                components = ["rustc" "cargo" "clippy" "rustfmt" "rust-analyzer" "rust-src"];
                targets = ["wasm32-unknown-unknown"];
              };

              # Secrets are loaded at runtime via secretspec (not baked into Nix store)
              dotenv.disableHint = true;

              # Environment variables
              env.LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";

              # Convex backend (ports resolved at runtime by devenv)
              env.PORT = toString backendPorts.api.value;
              env.SITE_PROXY_PORT = toString backendPorts.site.value;
              env.DASHBOARD_PORT = toString dashboardPorts.http.value;
              env.CONVEX_SELF_HOSTED_URL = "http://127.0.0.1:${toString backendPorts.api.value}";
              env.CONVEX_URL = "http://127.0.0.1:${toString backendPorts.api.value}";
              env.VITE_CONVEX_URL = "http://127.0.0.1:${toString backendPorts.api.value}";

              # Restate (ports resolved at runtime by devenv)
              env.RESTATE_INGRESS_PORT = toString restatePorts.ingress.value;
              env.RESTATE_ADMIN_PORT = toString restatePorts.admin.value;
              env.RESTATE_ADMIN_URL = "http://localhost:${toString restatePorts.admin.value}";
              env.RESTATE_INGRESS_URL = "http://localhost:${toString restatePorts.ingress.value}";

              # CRM Worker (Restate callback port)
              env.RESTATE_SERVICE_PORT = toString workerPorts.service.value;
              env.RESTATE_SERVICE_URL = "http://host.docker.internal:${toString workerPorts.service.value}";

              enterShell = ''
                export PATH="$HOME/.local/bin:$PATH"
                export LD_LIBRARY_PATH="${pkgs.openssl.out}/lib:${pkgs.sqlite.out}/lib:${pkgs.dbus.lib}/lib:''${LD_LIBRARY_PATH:-}"

                # Allow Docker containers to reach host ports (needed for Restate -> crm-worker callback).
                # The default iptables INPUT chain rejects non-whitelisted traffic, which blocks
                # host.docker.internal from Docker bridge networks.
                _docker_subnet=$(docker network inspect crm-chat_default -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || echo "172.18.0.0/16")
                if ! sudo iptables -C INPUT -s "$_docker_subnet" -j ACCEPT 2>/dev/null; then
                  sudo iptables -I INPUT -s "$_docker_subnet" -j ACCEPT \
                    && echo "Firewall: allowed Docker subnet $_docker_subnet -> host"
                fi
              '';

              # --- Docker Compose services (each container is a separate devenv process) ---
              # Ports are auto-allocated so multiple devs/agents can run on the same machine.

              processes.restate = {
                exec = ''
                  fuser -k "${toString restatePorts.ingress.value}/tcp" 2>/dev/null || true
                  fuser -k "${toString restatePorts.admin.value}/tcp" 2>/dev/null || true
                  docker compose up -d restate
                  echo "Waiting for Restate to become healthy..."
                  until curl -sf http://localhost:${toString restatePorts.ingress.value}/restate/health > /dev/null 2>&1; do
                    sleep 2
                  done
                  echo "Restate is healthy."
                  exec docker compose logs -f restate
                '';
                ports = {
                  ingress.allocate = 8080;
                  admin.allocate = 9070;
                };
                ready = {
                  http.get = {
                    host = "localhost";
                    port = restatePorts.ingress.value;
                    path = "/restate/health";
                  };
                  initial_delay = 5;
                  period = 3;
                };
              };

              processes.backend = {
                exec = ''
                  fuser -k "${toString backendPorts.api.value}/tcp" 2>/dev/null || true
                  fuser -k "${toString backendPorts.site.value}/tcp" 2>/dev/null || true
                  docker compose up -d backend

                  echo "Waiting for Convex backend to become healthy..."
                  until curl -sf http://localhost:${toString backendPorts.api.value}/version > /dev/null 2>&1; do
                    sleep 2
                  done
                  echo "Convex backend is healthy."

                  # Generate admin key and persist it
                  ADMIN_KEY=$(docker compose exec -T backend ./generate_admin_key.sh 2>/dev/null | tail -1)
                  mkdir -p "$DEVENV_STATE"
                  echo "$ADMIN_KEY" > "$DEVENV_STATE/admin_key"
                  echo "Admin key generated and saved to $DEVENV_STATE/admin_key"

                  exec docker compose logs -f backend
                '';
                ports = {
                  api.allocate = 3210;
                  site.allocate = 3211;
                };
                ready = {
                  exec = "test -f $DEVENV_STATE/admin_key";
                  initial_delay = 5;
                  period = 3;
                };
              };

              processes.dashboard = {
                exec = ''
                  fuser -k "${toString dashboardPorts.http.value}/tcp" 2>/dev/null || true
                  export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat "$DEVENV_STATE/admin_key")
                  docker compose up -d dashboard
                  exec docker compose logs -f dashboard
                '';
                ports.http.allocate = 6791;
                after = ["devenv:processes:backend"];
              };

              # Convex backend dev mode (hot-reload for convex functions)
              processes.convex-backend = {
                exec = ''
                  export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat "$DEVENV_STATE/admin_key")
                  bun install

                  # Run inside secretspec so CLERK_JWT_ISSUER_DOMAIN is available
                  # for both the env-set command and the convex dev subprocess
                  exec secretspec run --profile convex_backend -- sh -c '
                    if [ -n "$CLERK_JWT_ISSUER_DOMAIN" ]; then
                      bun -b convex env set CLERK_JWT_ISSUER_DOMAIN "$CLERK_JWT_ISSUER_DOMAIN" 2>/dev/null || true
                    fi
                    exec bun -b convex dev
                  '
                '';
                cwd = "${config.devenv.root}/bins/convex-backend";
                after = ["devenv:processes:backend"];
              };

              # CRM Worker (Rust service that connects to Telegram/Convex/Restate)
              processes.crm-worker = {
                exec = ''
                  fuser -k "${toString workerPorts.service.value}/tcp" 2>/dev/null || true
                  export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat "$DEVENV_STATE/admin_key")
                  exec secretspec run --profile crm_worker -- cargo watch -x 'run -p crm-worker'
                '';
                ports.service.allocate = 9080;
                after = ["devenv:processes:backend" "devenv:processes:restate"];
              };

              # Frontend dev server (React + Vite)
              processes.crm-chat-web = {
                exec = ''
                  fuser -k "${toString (config.processes.crm-chat-web.ports.http.value)}/tcp" 2>/dev/null || true
                  bun install
                  exec secretspec run --profile crm_chat_web -- bun -b vite --host 0.0.0.0
                '';
                cwd = "${config.devenv.root}/bins/crm-chat-web";
                ports.http.allocate = 5173;
                after = ["devenv:processes:backend"];
              };

              # Inherit from child flake dev shells
              inputsFrom = [
                crm-chat-web-app.devShells.${system}.default
              ];

              packages = with pkgs; [
                secretspec
                openssl
                dbus.dev
                taplo
                cargo-hakari
                cargo-audit
                cargo-watch
                cargo-sweep
                cargo-nextest
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
