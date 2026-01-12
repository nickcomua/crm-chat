{ pkgs, system }:

let
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

  source = sources.${system} or (throw "Unsupported system: ${system}");

in
pkgs.stdenv.mkDerivation {
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
    # license = licenses.bsl11;
    platforms = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
  };
}
