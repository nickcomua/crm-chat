{
  stdenv,
  lib,
  fetchurl,
  perl,
  emscripten,
}:
stdenv.mkDerivation {
  pname = "openssl-wasm";
  version = "1.1.0l";

  src = fetchurl {
    url = "https://github.com/openssl/openssl/archive/refs/tags/OpenSSL_1_1_0l.tar.gz";
    hash = "sha256-4qzwz1jZv/K0Ly3ArueTQMj/4sXkXTykUz3V1PV3Wx0=";
  };

  # Same Configure line as TDLib example/web/build-openssl.sh. emmake -j uses
  # the Nix build cores instead of that script's fixed -j 4, and the result is
  # its own store path so a TDLib rebuild does not repeat it.
  nativeBuildInputs = [
    perl
    emscripten
  ];

  dontStrip = true;

  preConfigure = ''
    export HOME=$TMPDIR
    export EM_CACHE=$TMPDIR/emscripten-cache
    mkdir -p "$EM_CACHE"
    sed -i "1s|.*|#!${perl}/bin/perl|" Configure
  '';

  configurePhase = ''
    runHook preConfigure
    emconfigure ./Configure linux-generic32 no-shared no-threads no-dso no-engine no-unit-test no-ui
    sed -i.bak 's/CROSS_COMPILE=.*/CROSS_COMPILE=/g' Makefile
    sed -i.bak 's/-ldl //g' Makefile
    sed -i.bak 's/-O3/-Os/g' Makefile
    runHook postConfigure
  '';

  buildPhase = ''
    runHook preBuild
    emmake make depend
    emmake make -j ''${NIX_BUILD_CORES:-1}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib $out/include
    cp libcrypto.a libssl.a $out/lib/
    cp -r include/. $out/include/
    test -s $out/lib/libcrypto.a
    test -s $out/lib/libssl.a
    test -s $out/include/openssl/opensslconf.h
    runHook postInstall
  '';

  meta = {
    description = "OpenSSL 1.1.0l built with emscripten 3.1.1 for TDLib's web example";
    homepage = "https://www.openssl.org/";
    license = lib.licenses.openssl;
    platforms = ["x86_64-linux"];
  };
}
