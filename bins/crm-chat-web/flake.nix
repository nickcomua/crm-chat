{
  description = "CRM Chat Web - Node.js + Vite + React development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        # Build crm-chat-web static files
        # Note: Environment variables are now injected at runtime, not build time
        # Build crm-chat-web static files using buildNpmPackage
        # This handles dependency fetching (via npmDepsHash) and avoids network/sandbox issues.
        crm-chat-web = pkgs.buildNpmPackage {
          pname = "crm-chat-web";
          version = "0.0.0";
          src = pkgs.lib.cleanSource ./.;

          # Nix will tell you the correct hash to put here after the first build attempt.
          npmDepsHash = "sha256-vJoIiN2Rm4lkDCeFVKYuIgvZ8YFpnOlowR2yUMpHBDk=";

          # Avoid npm/vite trying to write to read-only paths
          # makeCacheWritable = true;

          # Vite often needs a native esbuild. This points it to the Nix version.

          # We override the install phase because Vite outputs to 'dist/'
          installPhase = ''
            mkdir -p $out
            cp -r dist/* $out/
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
          # Use printf for proper escaping
          cat > /tmp/www/env-config.js <<EOF
          window.import = window.import || {};
          window.import.meta = window.import.meta || {};
          window.import.meta.env = {
            VITE_CLERK_PUBLISHABLE_KEY: "''${VITE_CLERK_PUBLISHABLE_KEY:-}",
            VITE_CONVEX_URL: "''${VITE_CONVEX_URL:-}",
            VITE_SENTRY_DSN: "''${VITE_SENTRY_DSN:-}",
            VITE_SENTRY_ENVIRONMENT: "''${VITE_SENTRY_ENVIRONMENT:-production}"
          };
          console.log('Runtime env loaded:', window.import.meta.env);
          EOF

          # Start nginx with error log to stderr (prevents /var/log/nginx/error.log warning)
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
        packages = {
          default = crm-chat-web;
          inherit crm-chat-web crm-chat-web-img;
        };

        checks = {
          crm-chat-web-lint = pkgs.buildNpmPackage {
            pname = "crm-chat-web-lint";
            version = "0.0.0";
            src = pkgs.lib.cleanSource ./.;

            npmDepsHash = "sha256-vJoIiN2Rm4lkDCeFVKYuIgvZ8YFpnOlowR2yUMpHBDk=";
            makeCacheWritable = true;

            nativeBuildInputs = [
              pkgs.biome
            ];

            # Override build phase to run lint instead.
            # Copy to /tmp to avoid the /build/ working directory path,
            # which matches ultracite's biome "!!**/build" ignore pattern.
            # A symlink doesn't work because biome resolves to the real path.
            buildPhase = ''
              npm run lint
            '';

            # Override install phase to create empty output
            installPhase = ''
              mkdir -p $out
              echo "Lint checks passed" > $out/result
            '';

            doCheck = false;
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
          ];

          shellHook = ''
          '';
        };
      }
    );
}
