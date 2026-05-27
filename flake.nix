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
            ./secretspec.toml
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
              ./secretspec.toml
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
              pkgs.runCommand "crm-chat-nix-fmt"
              {
                nativeBuildInputs = [pkgs.alejandra];
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.fileFilter (file: file.hasExt "nix") ./.;
                };
              }
              ''
                alejandra --check $src
                touch $out
              '';

            # Lint Nix files with statix
            crm-chat-statix =
              pkgs.runCommand "crm-chat-statix"
              {
                nativeBuildInputs = [pkgs.statix];
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.fileFilter (file: file.hasExt "nix") ./.;
                };
              }
              ''
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
            (
              {
                pkgs,
                config,
                ...
              }: let
                # Shorthand for devenv-allocated port values.
                backendPorts = config.processes.backend.ports;
                dashboardPorts = config.processes.dashboard.ports;
                webPorts = config.processes.crm-chat-web.ports;

                bunZshCompletion = pkgs.runCommand "bun-zsh-completion" {} ''
                  mkdir -p $out/share/zsh/site-functions
                  cp ${
                    pkgs.fetchurl {
                      url = "https://raw.githubusercontent.com/oven-sh/bun/refs/heads/main/completions/bun.zsh";
                      sha256 = "1avm6cvmvzd87s6kbgfagkrwjfa6341rz61fksiby3nr02j53wi4";
                    }
                  } $out/share/zsh/site-functions/_bun
                '';

                cleanupDockerCompose = ''
                  docker compose \
                    --project-directory "${config.devenv.root}" \
                    -f "${config.devenv.root}/docker-compose.yml" \
                    down --remove-orphans >/dev/null 2>&1 || true

                  docker ps -a \
                    --filter "label=com.docker.compose.project" \
                    --filter "label=com.docker.compose.service=dashboard" \
                    --format '{{.Label "com.docker.compose.project"}}' \
                    | sort -u \
                    | while IFS= read -r project; do
                      case "$project" in
                        crm-chat-*) ;;
                        *) continue ;;
                      esac

                      if [ -z "$(docker ps -q \
                        --filter "label=com.docker.compose.project=$project" \
                        --filter "label=com.docker.compose.service=backend" \
                        --filter "status=running")" ]; then
                        docker compose \
                          --project-directory "${config.devenv.root}" \
                          -f "${config.devenv.root}/docker-compose.yml" \
                          -p "$project" \
                          down --remove-orphans >/dev/null 2>&1 || true
                      fi
                    done
                '';

                # Helper: every process's exec begins with this so its stdout
                # and stderr are tee'd to a per-service file under
                # `<devenv-root>/.devenv/state/logs/<name>.log`.
                logTo = name: ''
                  mkdir -p "$DEVENV_STATE/logs"
                  exec > >(tee -a "$DEVENV_STATE/logs/${name}.log") 2>&1
                '';
              in {
                devenv.root = let
                  devenvRoot = builtins.readFile devenv-root.outPath;
                in
                  if devenvRoot != ""
                  then devenvRoot
                  else self.outPath;

                languages.rust = {
                  enable = true;
                  channel = "stable";
                  components = [
                    "rustc"
                    "cargo"
                    "clippy"
                    "rustfmt"
                    "rust-analyzer"
                    "rust-src"
                  ];
                  targets = ["wasm32-unknown-unknown"];
                };

                dotenv.disableHint = true;

                # ── Process env ──────────────────────────────────────────
                env = {
                  LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";

                  # Port 8080 (process-compose HTTP API) would clash across
                  # parallel devenv sessions — we only need the per-session
                  # unix socket.
                  PC_NO_SERVER = "1";

                  # Anchor secretspec to the repo-root .env so `secretspec run`
                  # finds secrets regardless of CWD (without this the default
                  # dotenv provider resolves `.env` against the subprocess'
                  # CWD and misses the root file from `bins/<sub>/`).
                  SECRETSPEC_PROVIDER = "dotenv:${config.devenv.root}/.env";

                  # Deterministic, per-workspace docker-compose project name so
                  # multiple `jj workspace`s running `devenv up` concurrently
                  # don't collide on container names (e.g. `crm-chat-backend-1`).
                  # Derived from the workspace root path so two workspaces with
                  # the same basename still get distinct project names.
                  COMPOSE_PROJECT_NAME = "crm-chat-${
                    builtins.substring 0 8 (builtins.hashString "sha256" config.devenv.root)
                  }";

                  # Ports + derived URLs exposed to every process.
                  PORT = toString backendPorts.api.value;
                  SITE_PROXY_PORT = toString backendPorts.site.value;
                  DASHBOARD_PORT = toString dashboardPorts.http.value;
                  WEB_PORT = toString webPorts.http.value;
                  CONVEX_URL = "http://127.0.0.1:${toString backendPorts.api.value}";
                  CONVEX_SITE_URL = "http://127.0.0.1:${toString backendPorts.site.value}";
                  CONVEX_SELF_HOSTED_URL = "http://127.0.0.1:${toString backendPorts.api.value}";
                  VITE_CONVEX_URL = "http://127.0.0.1:${toString backendPorts.api.value}";
                };

                process.manager.before = cleanupDockerCompose;

                process.manager.after = cleanupDockerCompose;

                enterShell = ''
                  export PATH="$HOME/.local/bin:$PATH"
                  export LD_LIBRARY_PATH="${pkgs.openssl.out}/lib:${pkgs.sqlite.out}/lib:${pkgs.dbus.lib}/lib:''${LD_LIBRARY_PATH:-}"
                  export BUN_ZSH_COMPLETION_DIR="${bunZshCompletion}/share/zsh/site-functions"

                  # Mirror devenv-allocated values into .env so dotenv-only
                  # tools (convex CLI, docker compose, editors) see the same
                  # ports / URLs as the shell. CONVEX_SELF_HOSTED_ADMIN_KEY is
                  # managed separately by processes.backend at runtime.
                  #
                  # An flock around the whole upsert block serializes concurrent
                  # enterShell runs against the same .env. Without it, running
                  # the root dev shell from N subprocesses at once races the
                  # awk-then-mv rewrite on `.env.tmp` and destroys the file —
                  # both awk invocations open `.env.tmp` with `>` (truncate),
                  # one mv wins, and the OTHER awk's partial output silently
                  # replaces the full file on the next mv. The lock file lives
                  # next to the .env it guards.
                  _upsert_env() {
                    local file="$1" key="$2" value="$3"
                    if [ ! -f "$file" ]; then
                      printf '%s=%s\n' "$key" "$value" > "$file"; return
                    fi
                    if grep -Eq "^[[:space:]]*''${key}=" "$file"; then
                      awk -v k="$key" -v v="$value" '
                        BEGIN { FS = OFS = "="; replaced = 0 }
                        !replaced && $0 !~ /^[[:space:]]*#/ && $1 == k { print k "=" v; replaced = 1; next }
                        { print }
                      ' "$file" > "$file.tmp.$$" && mv "$file.tmp.$$" "$file"
                    else
                      [ -s "$file" ] && [ "$(tail -c 1 "$file" | od -An -c | tr -d ' ')" != "\n" ] && printf '\n' >> "$file"
                      printf '%s=%s\n' "$key" "$value" >> "$file"
                    fi
                  }
                  _ENV_FILE="${config.devenv.root}/.env"
                  (
                    flock 9
                    _upsert_env "$_ENV_FILE" PORT                     "$PORT"
                    _upsert_env "$_ENV_FILE" SITE_PROXY_PORT          "$SITE_PROXY_PORT"
                    _upsert_env "$_ENV_FILE" DASHBOARD_PORT           "$DASHBOARD_PORT"
                    _upsert_env "$_ENV_FILE" WEB_PORT                 "$WEB_PORT"
                    _upsert_env "$_ENV_FILE" CONVEX_URL               "$CONVEX_URL"
                    _upsert_env "$_ENV_FILE" CONVEX_SITE_URL          "$CONVEX_SITE_URL"
                    _upsert_env "$_ENV_FILE" CONVEX_SELF_HOSTED_URL   "$CONVEX_SELF_HOSTED_URL"
                    _upsert_env "$_ENV_FILE" VITE_CONVEX_URL          "$VITE_CONVEX_URL"
                    _upsert_env "$_ENV_FILE" TEST_BASE_URL            "http://localhost:$WEB_PORT"
                  ) 9> "$_ENV_FILE.lock"
                  unset -f _upsert_env
                  unset _ENV_FILE
                '';

                # ── Processes ─────────────────────────────────────────────

                processes = {
                  backend = {
                    exec = ''
                      ${logTo "backend"}
                      trap 'docker compose stop backend' EXIT INT TERM
                      # Invalidate any admin_key left over from a prior devenv
                      # session: the `ready` gate below keys off this file, and a
                      # stale value would let dependents (convex-backend, worker)
                      # race ahead of the freshly (re)started backend. The cached
                      # key is still recovered from .env via key_valid() below if
                      # it's still valid against this backend.
                      rm -f "$DEVENV_STATE/admin_key"
                      docker compose up -d backend

                      echo "Waiting for Convex backend to become healthy on port $PORT..."
                      until curl -sf "http://localhost:$PORT/version" >/dev/null 2>&1; do sleep 2; done
                      echo "Convex backend is healthy."

                      # Reuse existing admin key if still valid; otherwise mint a new one.
                      STATE_KEY_FILE="$DEVENV_STATE/admin_key"
                      ENV_FILE="${config.devenv.root}/.env"
                      mkdir -p "$DEVENV_STATE"

                      key_valid() {
                        [ -z "$1" ] && return 1
                        [ "$(curl -s -o /dev/null -w '%{http_code}' \
                               -H "Authorization: Convex $1" \
                               "http://localhost:$PORT/api/shapes2" 2>/dev/null)" = "200" ]
                      }

                      CURRENT_KEY=""
                      [ -s "$STATE_KEY_FILE" ] && CURRENT_KEY=$(cat "$STATE_KEY_FILE")
                      if ! key_valid "$CURRENT_KEY"; then
                        CURRENT_KEY=$(awk -F= '/^CONVEX_SELF_HOSTED_ADMIN_KEY=/{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE" 2>/dev/null)
                      fi
                      if key_valid "$CURRENT_KEY"; then
                        echo "Reusing existing CONVEX_SELF_HOSTED_ADMIN_KEY."
                        ADMIN_KEY="$CURRENT_KEY"
                      else
                        echo "Generating new CONVEX_SELF_HOSTED_ADMIN_KEY."
                        ADMIN_KEY=$(docker compose exec -T backend ./generate_admin_key.sh 2>/dev/null | tail -1)
                      fi

                      echo "$ADMIN_KEY" > "$STATE_KEY_FILE"
                      # Upsert admin key into .env.
                      if grep -Eq '^CONVEX_SELF_HOSTED_ADMIN_KEY=' "$ENV_FILE" 2>/dev/null; then
                        awk -v v="$ADMIN_KEY" '
                          /^CONVEX_SELF_HOSTED_ADMIN_KEY=/{print "CONVEX_SELF_HOSTED_ADMIN_KEY="v; next} {print}
                        ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
                      else
                        printf 'CONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$ADMIN_KEY" >> "$ENV_FILE"
                      fi
                      echo "Admin key ready (state: $STATE_KEY_FILE, env: $ENV_FILE)."

                      docker compose logs -f backend
                    '';
                    ports = {
                      api.allocate = 3210;
                      site.allocate = 3211;
                    };
                    ready = {
                      # Combined check: (1) backend container is accepting HTTP
                      # on $PORT, and (2) *this session's* admin_key has been
                      # written (stale files from prior sessions are removed at
                      # the top of exec). Without the HTTP probe, dependents
                      # raced the backend into ~30 "Connection refused" retries.
                      exec = ''curl -sf "http://localhost:$PORT/version" >/dev/null 2>&1 && [ -s "$DEVENV_STATE/admin_key" ]'';
                      initial_delay = 5;
                      period = 3;
                    };
                  };

                  dashboard = {
                    exec = ''
                      ${logTo "dashboard"}
                      trap 'docker compose stop dashboard' EXIT INT TERM
                      export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat "$DEVENV_STATE/admin_key")
                      docker compose up -d dashboard
                      docker compose logs -f dashboard
                    '';
                    ports.http.allocate = 6791;
                    after = ["devenv:processes:backend"];
                  };

                  # Convex functions hot-reload. All env comes from the
                  # convex_backend secretspec profile (CONVEX_SELF_HOSTED_URL,
                  # CLERK_JWT_ISSUER_DOMAIN etc. — declared in secretspec.toml,
                  # sourced from the single root .env via the provider set by
                  # env.SECRETSPEC_PROVIDER above).
                  convex-backend = {
                    exec = ''
                      ${logTo "convex-backend"}
                      export CONVEX_SELF_HOSTED_ADMIN_KEY=$(cat "$DEVENV_STATE/admin_key")
                      bun install
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

                  # Rust worker: subscribes to Convex, drives Telegram.
                  # Explicit `-w` paths + debounce so transient writes under
                  # `.devenv/state/` and `target/` in a fresh jj workspace can't
                  # trap cargo-watch in a restart loop during the cold build.
                  crm-worker = {
                    exec = ''
                      ${logTo "crm-worker"}
                      exec secretspec run --profile crm_worker -- \
                        cargo watch \
                          --delay 2 \
                          -w Cargo.toml -w Cargo.lock \
                          -w bins -w libs \
                          -x 'run -p crm-worker'
                    '';
                    after = ["devenv:processes:backend"];
                  };

                  # Vite dev server.
                  crm-chat-web = {
                    exec = ''
                      ${logTo "crm-chat-web"}
                      # Guard: on process-compose restarts WEB_PORT was observed
                      # to expand empty, which made vite crash with
                      # `CACError: option --port <port> value is missing` and
                      # silently crash-loop. Fail loudly instead.
                      if [ -z "''${WEB_PORT:-}" ]; then
                        echo "crm-chat-web: WEB_PORT is unset/empty — check env.WEB_PORT in flake.nix" >&2
                        exit 1
                      fi
                      bun install
                      exec bun dev --port "$WEB_PORT"
                    '';
                    cwd = "${config.devenv.root}/bins/crm-chat-web";
                    ports.http.allocate = 5173;
                    after = ["devenv:processes:backend"];
                  };
                };

                # Inherit from child flake dev shells
                inputsFrom = [
                  crm-chat-web-app.devShells.${system}.default
                ];

                packages = with pkgs; [
                  secretspec
                  openssl
                  dbus.dev
                  tombi
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
                  nixd
                  nil
                ];

                cachix = {
                  enable = true;
                  pull = ["nickcomua"];
                  push = "nickcomua";
                };
              }
            )
          ];
        };
      }
    );
}
