{
  stdenv,
  lib,
  fetchurl,
  cmake,
  gperf,
  ninja,
  python311,
  pkg-config,
  emscripten,
  opensslWasm,
  tdlibSrc,
}:
stdenv.mkDerivation {
  pname = "tdlib-wasm";
  version = "1.8.69";

  src = tdlibSrc;

  # emscripten 3.1.1's zlib port. TDLib's wasm flags pass -s USE_ZLIB=1, and
  # the port fetcher names the cache file from the first dot in the URL leaf
  # (v1.2.11.zip -> zlib.2.11.zip).
  zlibPort = fetchurl {
    url = "https://github.com/madler/zlib/archive/v1.2.11.zip";
    hash = "sha256-9cxKuRDbmbK9u6Oeu9wiX/wqoEtAV7woF/G5S2l4z8M=";
  };

  nativeBuildInputs = [
    cmake
    gperf
    ninja
    python311
    pkg-config
    emscripten
  ];

  dontConfigure = true;

  # CMake 4 rejects projects that do not opt into a policy floor. TDLib 1.8.69
  # and emscripten 3.1.1's toolchain predate that requirement.
  CMAKE_POLICY_VERSION_MINIMUM = "3.5";

  buildPhase = ''
        runHook preBuild
        export HOME=$TMPDIR
        export EM_CACHE=$TMPDIR/emscripten-cache
        export CMAKE_BUILD_PARALLEL_LEVEL=''${NIX_BUILD_CORES:-4}
        cd example/web
        # OpenSSL comes from nix/openssl-wasm.nix. example/web/build-tdlib.sh
        # reads ./build/crypto and does not delete that directory.
        mkdir -p build
        ln -s ${opensslWasm} build/crypto
        chmod +x build-tdlib.sh
        # CMake 4's FindThreads probes emscripten 3.1.1 and fails. The C++17 flag
        # probe also fails in the sandbox even though em++ accepts -std=c++17, so
        # that result is set directly. The native generate step does not set
        # CMAKE_MODULE_PATH and does not receive these cache values.
        mkdir -p $TMPDIR/cmake
        cat > $TMPDIR/cmake/FindThreads.cmake <<'EOF'
    set(Threads_FOUND TRUE)
    set(CMAKE_THREAD_LIBS_INIT "")
    set(CMAKE_USE_PTHREADS_INIT 1)
    set(CMAKE_HAVE_LIBC_PTHREAD 1)
    if(NOT TARGET Threads::Threads)
      add_library(Threads::Threads INTERFACE IMPORTED)
    endif()
    EOF
        # option(TD_ENABLE_LTO) in TDLib's CMakeLists has no default, so CMake
        # leaves it OFF. example/web/build-tdlib.sh does not pass it either.
        # -DTD_ENABLE_LTO=OFF matches that official web build. Ninja replaces
        # Unix Makefiles. BUILD_TESTING=OFF skips test/; td_wasm does not link it.
        sed -i \
          "s|eval emcmake cmake -DCMAKE_BUILD_TYPE=MinSizeRel|eval env -u CC -u CXX -u CFLAGS -u CXXFLAGS -u LDFLAGS -u CMAKE_INCLUDE_PATH -u CMAKE_LIBRARY_PATH -u CMAKE_PREFIX_PATH emcmake cmake -G Ninja -DCMAKE_TOOLCHAIN_FILE=${emscripten}/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_MODULE_PATH=\$TMPDIR/cmake -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY -DHAVE_STD17=TRUE -DCMAKE_CXX_FLAGS=-std=c++17 -DTD_ENABLE_LTO=OFF -DBUILD_TESTING=OFF -DCMAKE_BUILD_TYPE=MinSizeRel|" \
          build-tdlib.sh
        sed -i 's|cmake -DTD_GENERATE_SOURCE_FILES=ON|cmake -G Ninja -DTD_GENERATE_SOURCE_FILES=ON|' build-tdlib.sh
        mkdir -p $EM_CACHE/ports/zlib
        cp $zlibPort $EM_CACHE/ports/zlib.2.11.zip
        python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' $zlibPort $EM_CACHE/ports/zlib
        printf '%s\n' 'https://github.com/madler/zlib/archive/v1.2.11.zip' > $EM_CACHE/ports/zlib/.emscripten_url
        ./build-tdlib.sh || {
          echo '--- wasm CMakeError.log ---'
          cat build/wasm/CMakeFiles/CMakeError.log || true
          echo '--- wasm configure log (errors) ---'
          grep -n -E 'error:|FAILED|exit code|fatal' build/wasm/CMakeFiles/CMakeConfigureLog.yaml | head -40 || true
          exit 1
        }
        runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cd $NIX_BUILD_TOP/source
    js=$(find example/web/build/wasm -name td_wasm.js -print -quit)
    wasm=$(find example/web/build/wasm -name td_wasm.wasm -print -quit)
    test -n "$js"
    test -n "$wasm"
    mkdir -p $out
    cp "$js" "$wasm" $out/
    emcc --check > $out/emscripten-version.txt 2>&1
    grep -q IDBFS $out/td_wasm.js
    grep -q ' 3.1.1 ' $out/emscripten-version.txt
    runHook postInstall
  '';

  meta = {
    description = "TDLib 1.8.69 compiled to WebAssembly with emscripten 3.1.1";
    homepage = "https://core.telegram.org/tdlib";
    license = lib.licenses.boost;
    platforms = ["x86_64-linux"];
  };
}
