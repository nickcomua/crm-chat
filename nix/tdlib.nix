{
  lib,
  stdenv,
  fetchFromGitHub,
  cmake,
  gperf,
  openssl,
  zlib,
  pkg-config,
}:
stdenv.mkDerivation {
  pname = "tdlib";
  # TDLib's latest git tag is v1.8.0 (2021-12-29). That client cannot speak to
  # current Telegram. The version string in CMakeLists.txt on master is the
  # release TDLib itself publishes. Pin that commit.
  version = "1.8.69";

  src = fetchFromGitHub {
    owner = "tdlib";
    repo = "td";
    rev = "4c6377aa7386c39217878a9a56d581922ad37ca4";
    hash = "sha256-lyk5T+onHxF3ifGzJWvuX7lrbgoxradRQhCqfjxKevU=";
  };

  nativeBuildInputs = [
    cmake
    gperf
    pkg-config
  ];
  buildInputs = [
    openssl
    zlib
  ];

  cmakeFlags = [
    "-DCMAKE_BUILD_TYPE=Release"
    "-DTD_ENABLE_LTO=OFF"
    "-DTD_ENABLE_JNI=OFF"
    "-DTD_ENABLE_DOTNET=OFF"
  ];

  meta = {
    description = "Cross-platform library for building Telegram clients";
    homepage = "https://core.telegram.org/tdlib";
    license = lib.licenses.boost;
    platforms = lib.platforms.linux;
  };
}
