{
  description = "Build a cargo project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

    crane.url = "github:ipetkov/crane";

    flake-utils.url = "github:numtide/flake-utils";

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
    # sccache,
    crm-chat-web,
    # spacetimedb,
    ...
  } @ inputs:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
          # overlays = [ sccache.overlays.default ];
        };

        # spacetimedbPkg =
        #   if pkgs.stdenv.isDarwin
        #   then import ./nix/spacetimedb.nix {inherit pkgs system;}
        #   else spacetimedb.packages.${system}.spacetime;

        spacetimedbPkg = import ./nix/spacetimedb.nix {inherit pkgs system;};

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
            pkgs.lld
            spacetimedbPkg
          ];

          buildInputs =
            [
              pkgs.openssl
              # Add additional build inputs here
              pkgs.gtk3
              # pkgs.webkitgtk_4_1
              pkgs.libsoup_3
              pkgs.cairo
              pkgs.lld
              pkgs.sqlite
            ]
            ++ lib.optionals pkgs.stdenv.isDarwin [
              # Additional darwin specific inputs can be set here
              pkgs.libiconv
            ];

          SPACETIMEDB_NIX_BUILD_GIT_COMMIT = self.rev or "development";
          XDG_CONFIG_HOME = "/tmp/config";
          XDG_DATA_HOME = "/tmp/data";
        };

        # Dependency caching is disabled only for Darwin-to-Linux remote builds
        # to avoid a known source builder permission bug in crane.
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;
        # cargoArtifacts = null;

        # Build telegram-subscriber binary
        telegram-subscriber = craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
            cargoExtraArgs = "-p telegram-subscriber";
          }
        );

        # Build crm-chat-web static files
        crm-chat-web = (pkgs.lib.makeOverridable (
          {
            VITE_CLERK_PUBLISHABLE_KEY ? "",
            VITE_SPACETIMEDB_HOST ? "",
            VITE_SPACETIMEDB_MODULE ? "",
            ...
          }:
            pkgs.stdenv.mkDerivation {
              name = "crm-chat-web";
              src = ./bins/crm-chat-web;
              nativeBuildInputs = [pkgs.bun];

              # Pass variables to build environment
              inherit VITE_CLERK_PUBLISHABLE_KEY VITE_SPACETIMEDB_HOST VITE_SPACETIMEDB_MODULE;

              buildPhase = ''
                export HOME=$(mktemp -d)

                # Inject variables (must be set via --argstr or environment)
                export VITE_CLERK_PUBLISHABLE_KEY="${VITE_CLERK_PUBLISHABLE_KEY}"
                export VITE_SPACETIMEDB_HOST="${VITE_SPACETIMEDB_HOST}"
                export VITE_SPACETIMEDB_MODULE="${VITE_SPACETIMEDB_MODULE}"

                bun install --frozen-lockfile
                bun run build
              '';

              installPhase = ''
                mkdir -p $out
                cp -r dist/* $out/
              '';
            }
        )) {};

        # nginx config for serving crm-chat-web
        nginxConf = pkgs.writeText "nginx.conf" ''
          worker_processes 1;
          error_log /dev/stderr;
          pid /tmp/nginx.pid;
          events { worker_connections 1024; }
          http {
            include ${pkgs.nginx}/conf/mime.types;
            default_type application/octet-stream;
            access_log /dev/stdout;
            sendfile on;
            keepalive_timeout 65;
            server {
              listen 80;
              root /var/www;
              index index.html;
              location / {
                try_files $uri $uri/ /index.html;
              }
            }
          }
        '';

      in {
        packages = {
          default = telegram-subscriber;
          inherit telegram-subscriber crm-chat-web spacetimedbPkg;
          spacetimedb = spacetimedbPkg;

          telegram-subscriber-img = pkgs.dockerTools.streamLayeredImage {
            name = "nick395/telegram-subscriber";
            tag = "latest";
            contents = [telegram-subscriber pkgs.cacert];

            config = {
              Cmd = ["/bin/telegram-subscriber"];
            };
          };

          crm-chat-web-img = (pkgs.lib.makeOverridable ({ ... } @ args:
            pkgs.dockerTools.streamLayeredImage {
              name = "nick395/crm-chat-web";
              tag = "latest";
              contents = [
                pkgs.nginx
                pkgs.fakeNss
                (pkgs.writeTextDir "etc/nginx/nginx.conf" (builtins.readFile nginxConf))
                (pkgs.runCommand "www" {} ''
                  mkdir -p $out/var/www
                  cp -r ${(crm-chat-web.override args)}/* $out/var/www/
                '')
              ];

              config = {
                Cmd = ["${pkgs.nginx}/bin/nginx" "-c" "/etc/nginx/nginx.conf" "-g" "daemon off;"];
                ExposedPorts = {
                  "80/tcp" = {};
                };
              };
            }
          )) {};
        };

        devShells.default = craneLib.devShell {
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
          RUSTC_WRAPPER = "${pkgs.sccache}/bin/sccache";
          SCCACHE_LOCAL_RW_MODE="READ_WRITE";
          shellHook = ''
            export PATH="$HOME/.local/bin:$PATH"
            export PATH="$HOME/.opencode/bin:$PATH"
          '';
          
          # Inherit from all child flake dev shells
          # inputsFrom = [
          #   crm-chat-web.devShells.${system}.default
          # ];

          # Extra inputs (only used for interactive development)
          # can be added here; cargo and rustc are provided by default.
          packages = with pkgs; [
            cargo-audit
            cargo-watch
            gtk3
            gtk4
            # webkitgtk_4_1
            biome
            # spacetimedb - temporarily removed due to hash mismatch in nixpkgs
            # Install via: brew install clockworklabs/tap/spacetime
            pkg-config
            llvmPackages.libclang
            libsoup_3
            pkgs.lld
            cairo
            sqlite
            pkgs.sccache
          ] ++ [
            spacetimedbPkg
          ];
        };
      }
    );
}
