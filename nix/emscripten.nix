{
  stdenv,
  lib,
  fetchurl,
  python311,
  nodejs,
  zlib,
  libxml2,
  ncurses,
  autoPatchelfHook,
}: let
  version = "3.1.1";
  # emsdk 3.1.1's linux SDK is this emscripten-releases build. The bundle
  # stamps emscripten-version.txt as 3.1.1-git; TDLib's example/web scripts
  # require the spaced token " 3.1.1 " from `emcc --check`. The binaries are
  # that release, so the installed version file says 3.1.1.
  # The bundled Node 14.18.2 segfaults on this glibc. Emscripten only needs a
  # working Node for its JS tools, so the pin uses nixpkgs Node.
  releasesHash = "5ee64de9809592480da01372880ea11debd6c740";
in
  stdenv.mkDerivation {
    pname = "emscripten";
    inherit version;

    src = fetchurl {
      url = "https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/${releasesHash}/wasm-binaries.tbz2";
      hash = "sha256-upTF7KusvtyJZlp0LDfEwTLHOa6kaqZv10TLcrJgyHA=";
    };

    nativeBuildInputs = [autoPatchelfHook];
    buildInputs = [
      stdenv.cc.cc.lib
      zlib
      libxml2
      ncurses
    ];

    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;

    installPhase = ''
          runHook preInstall
          mkdir -p $out
          tar -xjf $src -C $out --strip-components=1
          printf '3.1.1\n' > $out/emscripten/emscripten-version.txt
          cat > $out/emscripten/.emscripten <<EOF
      LLVM_ROOT = '$out/bin'
      BINARYEN_ROOT = '$out'
      NODE_JS = '${nodejs}/bin/node'
      EMSCRIPTEN_ROOT = '$out/emscripten'
      EOF
          mkdir -p $out/nix-support
          printf '%s\n' \
            "export EMSDK_PYTHON=${python311}/bin/python3" \
            "export EM_CONFIG=$out/emscripten/.emscripten" \
            "export PATH=$out/emscripten:$out/bin:${python311}/bin:${nodejs}/bin:\$PATH" \
            > $out/nix-support/setup-hook
          runHook postInstall
    '';

    meta = {
      description = "Emscripten 3.1.1, the emsdk release TDLib's web example requires";
      homepage = "https://emscripten.org/";
      license = lib.licenses.mit;
      platforms = ["x86_64-linux"];
    };
  }
