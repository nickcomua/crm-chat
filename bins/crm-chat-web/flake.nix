{
  description = "CRM Chat Web - Bun + Vite + React development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";

    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
    bun2nix.inputs.systems.follows = "systems";
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

  outputs =
    inputs:
    let
      eachSystem = inputs.nixpkgs.lib.genAttrs (import inputs.systems);

      pkgsFor = eachSystem (
        system:
        import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
          overlays = [ inputs.bun2nix.overlays.default ];
        }
      );
    in
    {
      packages = eachSystem (system:
        let
          pkgs = pkgsFor.${system};

          # Combined source: crm-chat-web + convex-backend side by side
          # so that file:../convex-backend resolves during bun install
          combinedSrc = pkgs.runCommand "crm-chat-web-combined-src" {} ''
            mkdir -p $out/crm-chat-web $out/convex-backend
            cp -r ${pkgs.lib.cleanSource ./.}/. $out/crm-chat-web/
            cp -r ${pkgs.lib.cleanSource ../convex-backend}/. $out/convex-backend/
          '';

          # Build crm-chat-web static files using bun2nix
          # Environment variables are injected at runtime, not build time
          crm-chat-web = pkgs.stdenv.mkDerivation {
            pname = "crm-chat-web";
            version = "0.0.0";
            src = combinedSrc;

            nativeBuildInputs = [
              pkgs.bun2nix.hook
            ];

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = ./bun.nix;
            };

            bunRoot = "crm-chat-web";

            # Use hoisted linker so node_modules/.bin works correctly
            bunInstallFlags =
              if pkgs.stdenv.hostPlatform.isDarwin
              then [ "--linker=hoisted" "--backend=copyfile" ]
              else [ "--linker=hoisted" ];

            # Run vite build only; tsc type-checking is handled by the lint check
            buildPhase = ''
              cd crm-chat-web
              node_modules/.bin/vite build
            '';

            installPhase = ''
              mkdir -p $out
              cp -r dist/. $out/
            '';
          };

          # Entrypoint script that injects runtime env vars and starts nginx
          entrypoint = pkgs.writeShellScript "entrypoint.sh" ''
            #!/bin/sh
            set -e

            # Create necessary temporary directories for nginx
            mkdir -p /tmp/client_body /tmp/proxy /tmp/fastcgi /tmp/uwsgi /tmp/scgi

            # Copy static files to a writable location
            mkdir -p /tmp/www
            cp -r /var/www/* /tmp/www/

            # Generate env-config.js with runtime environment variables
            cat > /tmp/www/env-config.js <<EOF
            window.import = window.import || {};
            window.import.meta = window.import.meta || {};
            window.import.meta.env = {
              VITE_CLERK_PUBLISHABLE_KEY: "''${VITE_CLERK_PUBLISHABLE_KEY:-}",
              VITE_CONVEX_URL: "''${VITE_CONVEX_URL:-}",
              VITE_SENTRY_DSN: "''${VITE_SENTRY_DSN:-}",
              VITE_SENTRY_ENVIRONMENT: "''${VITE_SENTRY_ENVIRONMENT:-production}"
            };
            EOF

            # Start nginx with error log to stderr
            exec ${pkgs.nginx}/bin/nginx -c /etc/nginx/nginx.conf -e /dev/stderr -g "daemon off;"
          '';

          # nginx config for serving crm-chat-web
          nginxConfContent = ''
            user nobody nobody;
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
              client_body_temp_path /tmp/client_body;
              proxy_temp_path /tmp/proxy;
              fastcgi_temp_path /tmp/fastcgi;
              uwsgi_temp_path /tmp/uwsgi;
              scgi_temp_path /tmp/scgi;
              server {
                listen 80;
                root /tmp/www;
                index index.html;
                location / {
                  try_files $uri $uri/ /index.html;
                }
              }
            }
          '';

          # Docker image with nginx and runtime env var support
          crm-chat-web-img = pkgs.dockerTools.buildLayeredImage {
            name = "nick395/crm-chat-web";
            tag = "latest";
            contents = [
              pkgs.nginx
              pkgs.fakeNss
              pkgs.coreutils
              pkgs.bash
              (pkgs.writeTextDir "etc/nginx/nginx.conf" nginxConfContent)
              (pkgs.runCommand "www" {} ''
                mkdir -p $out/var/www
                cp -r ${crm-chat-web}/* $out/var/www/
              '')
            ];

            config = {
              Cmd = [ "${entrypoint}" ];
              ExposedPorts = {
                "80/tcp" = {};
              };
              Env = [
                "VITE_CLERK_PUBLISHABLE_KEY="
                "VITE_CONVEX_URL="
                "VITE_SENTRY_DSN="
                "VITE_SENTRY_ENVIRONMENT=production"
              ];
              WorkingDir = "/tmp/www";
            };
          };
        in
        {
          default = crm-chat-web;
          inherit crm-chat-web crm-chat-web-img;
        }
      );

      checks = eachSystem (system:
        let
          pkgs = pkgsFor.${system};
          combinedSrc = pkgs.runCommand "crm-chat-web-combined-src" {} ''
            mkdir -p $out/crm-chat-web $out/convex-backend
            cp -r ${pkgs.lib.cleanSource ./.}/. $out/crm-chat-web/
            cp -r ${pkgs.lib.cleanSource ../convex-backend}/. $out/convex-backend/
          '';

          # Fetch biome binary from GitHub releases to match the exact version
          # in package.json. bun2nix only installs platform-specific optional
          # deps for the host, so cross-platform builds need this.
          biomeVersion = "2.4.4";
          biomeBinSrc = {
            "aarch64-darwin" = pkgs.fetchurl {
              url = "https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${biomeVersion}/biome-darwin-arm64";
              hash = "sha256-6JARsXFKIOvUtoMyG6cYTOKnmij07j0zvadKTqdJBio=";
            };
            "x86_64-darwin" = pkgs.fetchurl {
              url = "https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${biomeVersion}/biome-darwin-x64";
              hash = "sha256-T60NUBXrtr5SuJOY7Q6Qch7gI59M3qDDRyV6CihujYQ=";
            };
            "x86_64-linux" = pkgs.fetchurl {
              url = "https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${biomeVersion}/biome-linux-x64";
              hash = "sha256-ulBzAX7AOnAOW5JwskVN99vsalEkYRu3hbaK5xdQbUU=";
            };
            "aarch64-linux" = pkgs.fetchurl {
              url = "https://github.com/biomejs/biome/releases/download/%40biomejs/biome%40${biomeVersion}/biome-linux-arm64";
              hash = "sha256-cIz6oB0SsrsWScW32X894koXQfvPzwpGHF+b5Idcdgs=";
            };
          }.${system};
          biome = pkgs.stdenv.mkDerivation {
            pname = "biome";
            version = biomeVersion;
            src = biomeBinSrc;
            dontUnpack = true;
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.stdenv.cc.cc.lib ];
            installPhase = ''
              mkdir -p $out/bin
              cp $src $out/bin/biome
              chmod +x $out/bin/biome
            '';
          };
        in
        {
          crm-chat-web-lint = pkgs.stdenv.mkDerivation {
            pname = "crm-chat-web-lint";
            version = "0.0.0";
            src = combinedSrc;

            nativeBuildInputs = [
              pkgs.bun2nix.hook
              biome
            ];

            bunDeps = pkgs.bun2nix.fetchBunDeps {
              bunNix = ./bun.nix;
            };

            bunRoot = "crm-chat-web";
            dontUseBunBuild = true;

            bunInstallFlags =
              if pkgs.stdenv.hostPlatform.isDarwin
              then [ "--linker=hoisted" "--backend=copyfile" ]
              else [ "--linker=hoisted" ];

            # Symlink node_modules into convex-backend so tsc can resolve
            # "convex/server" etc. from the backend source files.
            # Patch ultracite: its !!**/build exclusion matches the nix sandbox
            # /build/ root on Linux, causing biome to ignore all files. Remove
            # those patterns and create .git so VCS integration can find a root.
            buildPhase = ''
              cd crm-chat-web
              ln -s "$(pwd)/node_modules" ../convex-backend/node_modules
              sed -i '/\/build/d' node_modules/ultracite/config/biome/core/biome.jsonc
              mkdir -p .git
              node_modules/.bin/eslint .
              biome check
              node_modules/.bin/tsc -b
            '';

            installPhase = ''
              touch $out
            '';

            doCheck = false;
          };
        }
      );

      devShells = eachSystem (system:
        let
          pkgs = pkgsFor.${system};
        in
        {
          default = pkgs.mkShell {
            buildInputs = with pkgs; [
              bun
              bun2nix
            ];
          };
        }
      );
    };
}
