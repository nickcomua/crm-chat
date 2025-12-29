{
  description = "Build a cargo project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    crane.url = "github:ipetkov/crane";

    flake-utils.url = "github:numtide/flake-utils";

    # spacetimedb.url = "github:clockworklabs/SpacetimeDB/refs/tags/v1.11.1";

    advisory-db = {
      url = "github:rustsec/advisory-db";
      flake = false;
    };

    # Child flakes
    crm-chat-web = {
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
    advisory-db,
    crm-chat-web,
    ...
  } @ inputs:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        inherit (pkgs) lib;

        craneLib = crane.mkLib pkgs;
        src = craneLib.cleanCargoSource ./.;

        # Common arguments can be set here to avoid repeating them later
        commonArgs = {
          inherit src;
          strictDeps = true;

          nativeBuildInputs = [
            pkgs.pkg-config
            pkgs.gtk4.dev
            pkgs.gtk3.dev
            pkgs.llvmPackages.libclang
          ];

          buildInputs =
            [
              # Add additional build inputs here
              pkgs.gtk3
              pkgs.webkitgtk_4_1
              pkgs.libsoup_3
              pkgs.cairo
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              # Additional darwin specific inputs can be set here
              pkgs.libiconv
            ];

          # Additional environment variables can be set directly
          # MY_CUSTOM_VAR = "some value";
        };

        # Build *just* the cargo dependencies, so we can reuse
        # all of that work (e.g. via cachix) when running in CI
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        # Build the actual crate itself, reusing the dependency
        # artifacts from above.
        chat-scope = craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
          }
        );
      in {
        checks = {
          # Build the crate as part of `nix flake check` for convenience
          inherit chat-scope;

          # Run clippy (and deny all warnings) on the crate source,
          # again, reusing the dependency artifacts from above.
          #
          # Note that this is done as a separate derivation so that
          # we can block the CI if there are issues here, but not
          # prevent downstream consumers from building our crate by itself.
          chat-scope-clippy = craneLib.cargoClippy (
            commonArgs
            // {
              inherit cargoArtifacts;
              cargoClippyExtraArgs = "--all-targets -- --deny warnings";
            }
          );

          chat-scope-doc = craneLib.cargoDoc (
            commonArgs
            // {
              inherit cargoArtifacts;
              # This can be commented out or tweaked as necessary, e.g. set to
              # `--deny rustdoc::broken-intra-doc-links` to only enforce that lint
              env.RUSTDOCFLAGS = "--deny warnings";
            }
          );

          # Check formatting
          chat-scope-fmt = craneLib.cargoFmt {
            inherit src;
          };

          chat-scope-toml-fmt = craneLib.taploFmt {
            src = pkgs.lib.sources.sourceFilesBySuffices src [".toml"];
            # taplo arguments can be further customized below as needed
            # taploExtraArgs = "--config ./taplo.toml";
          };

          # Audit dependencies
          chat-scope-audit = craneLib.cargoAudit {
            inherit src advisory-db;
          };

          # Audit licenses
          chat-scope-deny = craneLib.cargoDeny {
            inherit src;
          };

          # Run tests with cargo-nextest
          # Consider setting `doCheck = false` on `chat-scope` if you do not want
          # the tests to run twice
          chat-scope-nextest = craneLib.cargoNextest (
            commonArgs
            // {
              inherit cargoArtifacts;
              partitions = 1;
              partitionType = "count";
              cargoNextestPartitionsExtraArgs = "--no-tests=pass";
            }
          );
        };

        packages = {
          default = chat-scope;
          chat-scope-img = pkgs.dockerTools.streamLayeredImage {
            name = "nick395/chat-scope";
            tag = "latest";
            contents = [chat-scope];

            config = {
              Cmd = ["/bin/chat-scope"];
            };
          };
        };

        apps.default = {
          type = "app";
          program = "${chat-scope}/bin/crm-chat";
          meta.description = "CRM Chat application";
        };

        devShells.default = craneLib.devShell {
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";

          shellHook = ''
            export PATH="$HOME/.local/bin:$PATH"
            export PATH=/home/nick/.opencode/bin:$PATH
          '';
          
          # Inherit from chat-scope and all child flake dev shells
          inputsFrom = [
            chat-scope
            crm-chat-web.devShells.${system}.default
          ];

          # Extra inputs (only used for interactive development)
          # can be added here; cargo and rustc are provided by default.
          packages = with pkgs; [
            cargo-audit
            cargo-watch
            openssl
            gtk3.dev
            gtk4.dev
            webkitgtk_4_1
            biome
            # spacetimedb.packages.${system}.spacetime
            spacetimedb
            pkg-config
            llvmPackages.libclang
            libsoup_3
            cairo
          ];
        };
      }
    );
}
