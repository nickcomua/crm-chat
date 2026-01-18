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

    # spacetimedb.url = "github:clockworklabs/SpacetimeDB/refs/tags/v1.10.0";

    advisory-db = {
      url = "github:rustsec/advisory-db";
      flake = false;
    };

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
    # spacetimedb,
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

        # spacetimedbPkg =
        #   if pkgs.stdenv.isDarwin
        #   then import ./nix/spacetimedb.nix {inherit pkgs system;}
        #   else spacetimedb.packages.${system}.spacetime;

        spacetimedbPkg = import ./nix/spacetimedb.nix {inherit pkgs system;};

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
        src = craneLib.cleanCargoSource ./.;

        # Common arguments can be set here to avoid repeating them later
        commonArgs = {
          inherit src;
          strictDeps = true;

          nativeBuildInputs = [
            spacetimedbPkg
            pkgs.lld
            pkgs.rustfmt
            pkgs.pkg-config
          #   pkgs.gtk4.dev
          #   pkgs.gtk3.dev
          #   pkgs.llvmPackages.libclang
          #   pkgs.lld
          ];

          buildInputs =
            [
              
              pkgs.openssl
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

           # needed for spacetimedb-lib to build
           SPACETIMEDB_NIX_BUILD_GIT_COMMIT = self.rev or "development";
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

              (craneLib.fileset.commonCargoSources ./bins/sdb_server)
              (craneLib.fileset.commonCargoSources ./libs/sdb_api)

              (craneLib.fileset.commonCargoSources ./libs/messanger-interface)
              (craneLib.fileset.commonCargoSources ./libs/messanger-telegram)
              (craneLib.fileset.commonCargoSources crate)
            ];
          };

        # Build telegram-subscriber binary
        telegram-subscriber = craneLib.buildPackage (
          individualCrateArgs
          // {
            pname = "telegram-subscriber";
            cargoExtraArgs = "-p telegram-subscriber";
            src = fileSetForCrate ./bins/telegram-subscriber;
          }
        );
        crm-chat-web = crm-chat-web-app.packages.${system}.crm-chat-web;
        crm-chat-web-img = crm-chat-web-app.packages.${system}.crm-chat-web-img;

      in {
        checks = {
          inherit telegram-subscriber crm-chat-web;
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
          inherit telegram-subscriber spacetimedbPkg crm-chat-web crm-chat-web-img;

          telegram-subscriber-img = pkgs.dockerTools.buildLayeredImage {
            name = "nick395/telegram-subscriber";
            tag = "latest";
            contents = [telegram-subscriber pkgs.cacert];

            config = {
              Cmd = ["/bin/telegram-subscriber"];
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
            cargo-nextest
            biome
            pkg-config
            llvmPackages.libclang
            pkgs.lld
            sqlite
            sccache
          ] ++ [
            spacetimedbPkg
          ];
        };
      }
    );
}
