{
  description = "Build a cargo project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    crane.url = "github:ipetkov/crane";

    flake-utils.url = "github:numtide/flake-utils";

    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    advisory-db = {
      url = "github:rustsec/advisory-db";
      flake = false;
    };

    # Swagger UI fetched below via pkgs.fetchurl to preserve zip format

    # sccache = {
    #   url = "github:mozilla/sccache";
    #   inputs.nixpkgs.follows = "nixpkgs";
    # };

    # Child flakes
    crm-chat-web-app = {
      url = "path:./bins/crm-chat-web";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };

  };

  outputs = {
    self,
    nixpkgs,
    crane,
    flake-utils,
    fenix,
    advisory-db,
    # sccache,
    crm-chat-web-app,
    ...
  } @ inputs:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
        #   config.allowUnfree = true;
        #   # overlays = [ sccache.overlays.default ];
        };
        # pkgs = nixpkgs.legacyPackages.${system};

        # Pre-fetch swagger-ui zip for utoipa-swagger-ui (preserves zip format for build.rs)
        swaggerUiZipRaw = pkgs.fetchurl {
          url = "https://github.com/swagger-api/swagger-ui/archive/refs/tags/v5.17.14.zip";
          sha256 = "sha256-SBJE0IEgl7Efuu73n3HZQrFxYX+cn5UU5jrL4T5xzNw=";
        };
        # Wrap in a derivation with proper permissions
        swaggerUiZip = pkgs.runCommand "swagger-ui-zip" {} ''
          mkdir -p $out
          cp ${swaggerUiZipRaw} $out/v5.17.14.zip
          chmod 644 $out/v5.17.14.zip
        '';

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
        # Include standard Cargo sources plus .ts files needed by convex-backend build.rs
        src = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            (craneLib.fileset.commonCargoSources ./.)
            (lib.fileset.fileFilter (file: file.hasExt "ts") ./bins/convex-backend/convex)
          ];
        };

        # Common arguments can be set here to avoid repeating them later
        commonArgs = {
          inherit src;
          strictDeps = true;

          # Copy swagger-ui zip to a writable location before build
          preConfigure = ''
            export SWAGGER_UI_ZIP_DIR=$(mktemp -d)
            cp ${swaggerUiZip}/v5.17.14.zip $SWAGGER_UI_ZIP_DIR/
            chmod 644 $SWAGGER_UI_ZIP_DIR/v5.17.14.zip
            export SWAGGER_UI_DOWNLOAD_URL="file://$SWAGGER_UI_ZIP_DIR/v5.17.14.zip"
          '';

          nativeBuildInputs = [
            pkgs.lld
            pkgs.rustfmt
            pkgs.pkg-config
            pkgs.perl # Required by openssl-sys vendored build
            pkgs.curl # Required for utoipa-swagger-ui to download Swagger UI assets
          #   pkgs.gtk4.dev
          #   pkgs.gtk3.dev
          #   pkgs.llvmPackages.libclang
          #   pkgs.lld
          ];

          buildInputs =
            [

              pkgs.openssl
              pkgs.cacert # Required for utoipa-swagger-ui to download over HTTPS
              # pkgs.pkg-config
              # Add additional build inputs here
              # pkgs.gtk3
              # pkgs.webkitgtk_4_1
              # pkgs.libsoup_3
              # pkgs.cairo

              pkgs.sqlite
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              # Additional darwin specific inputs can be set here
              pkgs.libiconv
            ];

           # Required for curl to verify SSL certificates during build
           SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
           # Note: SWAGGER_UI_DOWNLOAD_URL is set dynamically in preConfigure above
        };

        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        individualCrateArgs = commonArgs // {
          inherit cargoArtifacts;
          inherit (craneLib.crateNameFromCargoToml { inherit src; }) version;
          # NB: we disable tests since we'll run them all via cargo-nextest
          doCheck = false;
        };

        fileSetForCrate =
          crate:
          lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./Cargo.toml
              ./Cargo.lock
              (craneLib.fileset.commonCargoSources ./libs/hack)

              (craneLib.fileset.commonCargoSources ./bins/es-proxy)
              (craneLib.fileset.commonCargoSources ./bins/convex-backend)
              # Include .ts files needed by convex-backend build.rs (convex-typegen)
              (lib.fileset.fileFilter (file: file.hasExt "ts") ./bins/convex-backend/convex)

              (craneLib.fileset.commonCargoSources ./libs/messanger-interface)
              (craneLib.fileset.commonCargoSources ./libs/messanger-telegram)
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
          }
        );
        crm-chat-web = crm-chat-web-app.packages.${system}.crm-chat-web;
        crm-chat-web-img = crm-chat-web-app.packages.${system}.crm-chat-web-img;

      in {
        checks = {
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

          # crm-chat-toml-fmt = craneLib.taploFmt {
          #   src = pkgs.lib.sources.sourceFilesBySuffices src [ ".toml" ];
          #   # taplo arguments can be further customized below as needed
          #   taploExtraArgs = "--config ./taplo.toml";
          # };

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

        } // {
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
            contents = [crm-worker pkgs.cacert];

            config = {
              Cmd = ["/bin/crm-worker"];
            };
          };

        };

        devShells.default = craneLib.devShell {
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
          RUSTC_WRAPPER = "${pkgs.sccache}/bin/sccache";
          SCCACHE_CACHE_SIZE="20G";
          SCCACHE_LOCAL_RW_MODE="READ_WRITE";
          shellHook = ''
            export PATH="$HOME/.local/bin:$PATH"
            export PATH="$HOME/.opencode/bin:$PATH"
            export LD_LIBRARY_PATH="${pkgs.openssl.out}/lib:${pkgs.sqlite.out}/lib:$LD_LIBRARY_PATH"
          '';
          checks = self.checks.${system};
          # Inherit from all child flake dev shells
          inputsFrom = [
            crm-chat-web-app.devShells.${system}.default
          ];

          # Extra inputs (only used for interactive development)
          # cargo, rustc, clippy, rustfmt are provided by the fenix toolchain
          packages = with pkgs; [
            openssl

            taplo
            cargo-hakari
            cargo-audit
            cargo-watch
            cargo-sweep
            cargo-nextest
            biome
            pkg-config
            llvmPackages.libclang
            pkgs.lld
            sqlite
            sccache
          ];
        };
      }
    );
}
