#!/usr/bin/env python3
"""The 1970 Last-Modified bug, then the server that does not date-revalidate."""

import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

SERVER = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).with_name("website_serve.py"))
EPOCH = 1
IMS = "Thu, 01 Jan 1970 00:00:01 GMT"


def write_site(root, name):
    assets = root / "assets"
    tdlib = root / "tdlib"
    assets.mkdir(parents=True)
    tdlib.mkdir()
    (root / "index.html").write_text(
        '<!doctype html><script type="module" src="/assets/index-%s.js"></script>\n' % name,
        encoding="utf-8",
    )
    (assets / ("index-%s.js" % name)).write_text("/* %s */\n" % name, encoding="utf-8")
    (tdlib / "td_wasm.js").write_text("// %s\n" % name, encoding="utf-8")
    (tdlib / "td_wasm.wasm").write_bytes(b"\0asm" + name.encode())
    for path in root.rglob("*"):
        if path.is_file():
            os.utime(path, (EPOCH, EPOCH))


def start(root, legacy):
    env = os.environ.copy()
    env["TG_ID"] = "1"
    env["TG_HASH"] = "a" * 32
    if legacy:
        env["CRM_CHAT_SERVE_LEGACY"] = "1"
    else:
        env.pop("CRM_CHAT_SERVE_LEGACY", None)
    proc = subprocess.Popen(
        [sys.executable, str(SERVER), str(root), "0"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    line = proc.stdout.readline().strip()
    if not line.startswith("serving website on "):
        err = proc.stderr.read()
        proc.kill()
        raise SystemExit("server did not start: %s %s" % (line, err))
    return proc, line.removeprefix("serving website on ").rstrip("/")


def fetch(url, ims=None):
    request = urllib.request.Request(url)
    if ims is not None:
        request.add_header("If-Modified-Since", ims)
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def expect(condition, message):
    if not condition:
        raise SystemExit("FAIL " + message)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        old = work / "old"
        new = work / "new"
        link = work / "root"
        write_site(old, "OLD")
        write_site(new, "NEW")
        link.symlink_to(old, target_is_directory=True)

        legacy, base = start(link, True)
        try:
            status, headers, body = fetch(base + "/")
            expect(status == 200, "legacy first status %s" % status)
            expect(b"index-OLD.js" in body, "legacy first body")
            expect("Last-Modified" in headers, "legacy missing Last-Modified")
            status, _, body = fetch(base + "/", headers["Last-Modified"])
            expect(status == 304, "legacy revalidation status %s" % status)
            expect(body == b"", "legacy 304 had a body")
            link.unlink()
            link.symlink_to(new, target_is_directory=True)
            status, _, body = fetch(base + "/", IMS)
            expect(status == 304, "legacy redeploy status %s" % status)
            print("legacy redeploy: 304")
        finally:
            legacy.kill()
            legacy.wait(timeout=5)

        link.unlink()
        link.symlink_to(old, target_is_directory=True)
        fresh, base = start(link, False)
        try:
            status, headers, body = fetch(base + "/")
            expect(status == 200 and b"index-OLD.js" in body, "new server first body")
            expect("Last-Modified" not in headers, "new server sent Last-Modified")
            expect(headers.get("Cache-Control") == "no-store", "index cache %s" % headers.get("Cache-Control"))
            link.unlink()
            link.symlink_to(new, target_is_directory=True)
            status, headers, body = fetch(base + "/", IMS)
            expect(status == 200, "redeploy status %s" % status)
            expect(b"index-NEW.js" in body, "redeploy kept the previous bundle")
            expect(headers.get("Cache-Control") == "no-store", "redeploy cache")
            print("new redeploy: 200")
            for path in ("/tdlib/td_wasm.js", "/tdlib/td_wasm.wasm"):
                status, headers, _ = fetch(base + path, IMS)
                expect(status == 200, "%s status %s" % (path, status))
                expect(headers.get("Cache-Control") == "no-store", "%s cache" % path)
            status, headers, body = fetch(base + "/assets/index-NEW.js", IMS)
            expect(status == 200 and body.startswith(b"/* NEW */"), "asset body")
            expect(
                headers.get("Cache-Control") == "public, max-age=31536000, immutable",
                "asset cache %s" % headers.get("Cache-Control"),
            )
            status, headers, body = fetch(base + "/runtime/telegram-app")
            expect(status == 200, "runtime status %s" % status)
            expect(headers.get("Cache-Control") == "no-store", "runtime cache")
            expect(b"apiId" in body and b"apiHash" in body, "runtime shape")
        finally:
            fresh.kill()
            fresh.wait(timeout=5)
    print("PASS")


if __name__ == "__main__":
    main()
