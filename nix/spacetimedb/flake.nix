{
  description = "SpacetimeDB CLI";
  version = "1.10.0";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
          version = "1.10.0";
  
          sources = {
            "aarch64-darwin" = {
              url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-aarch64-apple-darwin.tar.gz";
              hash = "sha256-H2VI4BsVFjUtj5qg0PSAKbfiJc313x8ly+oPA2ab+dw=";
            };
            "x86_64-darwin" = {
              url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-x86_64-apple-darwin.tar.gz";
              hash = "sha256-wFL/Xc+tFv0HX6AvnBqY08cBpigB9kqDdPYQpC8cUDY=";
            };
            "x86_64-linux" = {
              url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-x86_64-unknown-linux-gnu.tar.gz";
              hash = "sha256-372G3pPzYKfSUAjZuv2iHA6HLZqQY1UoP6kF5vj49qU=";
            };
            "aarch64-linux" = {
              url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-aarch64-unknown-linux-gnu.tar.gz";
              hash = "sha256-G17ZMMPxMZ0RrF471PYClDvn4sP8H/QrJ/SXiWZ7UdA=";
            };
          };
        # version = "1.11.3";

        # sources = {
        #   "aarch64-darwin" = {
        #     url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-aarch64-apple-darwin.tar.gz";
        #     hash = "sha256-PJERjabPKiY+NzQ4mwKt4JEYyveJu4S4axxtscYd+QQ=";
        #   };
        #   "x86_64-darwin" = {
        #     url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-x86_64-apple-darwin.tar.gz";
        #     hash = "sha256-XSHiuPsLmuT9c1yGXQF1qlHF4tVTNUFVLuLYVBl5ll4=";
        #   };
        #   "x86_64-linux" = {
        #     url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-x86_64-unknown-linux-gnu.tar.gz";
        #     hash = "sha256-i1otsjmB+jf7HM2ZkVw8zL9McLZ2VzlRgWjA69HXkI4=";
        #   };
        #   "aarch64-linux" = {
        #     url = "https://github.com/clockworklabs/SpacetimeDB/releases/download/v${version}/spacetime-aarch64-unknown-linux-gnu.tar.gz";
        #     hash = "sha256-ALrDOs1tEtg81o7+zcO5I760FBQMncQkA+wO5GPwVDU=";
        #   };
        # };

        source = sources.${system} or (throw "Unsupported system: ${system}");

        spacetimedb = pkgs.stdenv.mkDerivation {
          pname = "spacetimedb";
          inherit version;

          src = pkgs.fetchurl {
            inherit (source) url hash;
          };

          nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.autoPatchelfHook
          ];

          buildInputs = pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.stdenv.cc.cc.lib
            pkgs.zlib
          ];

          unpackPhase = ''
            mkdir source
            tar -C source -xzf $src
          '';

          sourceRoot = "source";

          installPhase = ''
            mkdir -p $out/bin
            if [ -f spacetime ]; then
              cp spacetime $out/bin/spacetime
            elif [ -f spacetimedb-cli ]; then
              cp spacetimedb-cli $out/bin/spacetime
            else
              echo "ERROR: No spacetime CLI binary found in archive"
              exit 1
            fi

            if [ -f spacetimedb-standalone ]; then
              cp spacetimedb-standalone $out/bin/
            fi
            chmod +x $out/bin/*
          '';

          meta = with pkgs.lib; {
            description = "SpacetimeDB CLI";
            homepage = "https://spacetimedb.com";
            platforms = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
          };
        };
      in
      {
        packages = {
          default = spacetimedb;
          spacetimedb = spacetimedb;
        };
      }
    );
}
