#!/usr/bin/env python3
"""Serve a crm-chat website build.

Nix store files are dated 1970-01-01. Python's SimpleHTTPRequestHandler sends
that as Last-Modified and answers If-Modified-Since with 304, so a browser
keeps the previous index.html after the site is redeployed. This server never
date-revalidates. Hashed files inside the assets directory are immutable.
A /assets/ directory URL falls back to index.html and stays no-store.
Every other path is no-store. /runtime/telegram-app answers loopback clients
only.

CRM_CHAT_SERVE_LEGACY=1 restores the old SimpleHTTPRequestHandler behavior so
the redeploy check can show the 304.
"""

import http.server
import ipaddress
import json
import os
import re
import sys
from urllib.parse import unquote
from urllib.parse import urlsplit

ROOT = ""
LEGACY = os.environ.get("CRM_CHAT_SERVE_LEGACY") == "1"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
}


def favicon_bytes():
    # 16x16 32-bit ICO, solid #3390ec. Browsers request /favicon.ico even when
    # the built site has not copied one into the output yet.
    width = 16
    height = 16
    xor = bytearray()
    for _row in range(height):
        for _column in range(width):
            xor.extend(b"\xec\x90\x33\xff")
    mask_row = ((width + 31) // 32) * 4
    mask = bytes(mask_row * height)
    header = (
        b"\x28\x00\x00\x00"
        + width.to_bytes(4, "little")
        + (height * 2).to_bytes(4, "little")
        + b"\x01\x00\x20\x00\x00\x00\x00\x00"
        + (len(xor) + len(mask)).to_bytes(4, "little")
        + b"\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
    )
    image = header + bytes(xor) + mask
    entry = (
        bytes((width, height, 0, 0))
        + b"\x01\x00\x20\x00"
        + len(image).to_bytes(4, "little")
        + (6 + 16).to_bytes(4, "little")
    )
    return b"\x00\x00\x01\x00\x01\x00" + entry + image


FAVICON = favicon_bytes()


def cache_control(target):
    assets = os.path.join(live_root(), "assets") + os.sep
    if target.startswith(assets):
        return "public, max-age=31536000, immutable"
    return "no-store"


def is_loopback(host):
    try:
        return ipaddress.ip_address(host.removeprefix("::ffff:")).is_loopback
    except ValueError:
        return False


def credentials():
    api_id = os.environ.get("TG_ID")
    api_hash = os.environ.get("TG_HASH")
    if (
        api_id
        and api_hash
        and re.fullmatch(r"[1-9]\d*", api_id)
        and re.fullmatch(r"[a-fA-F\d]{32}", api_hash)
    ):
        return json.dumps({"apiId": api_id, "apiHash": api_hash}).encode()
    return None


def live_root():
    # ROOT may be a symlink. Resolve it per request so ln -sfn redeploys.
    return os.path.realpath(ROOT)


def file_for(url_path):
    root = live_root()
    name = unquote(urlsplit(url_path).path)
    relative = name.lstrip("/")
    candidate = os.path.realpath(os.path.join(root, relative))
    inside = candidate == root or candidate.startswith(root + os.sep)
    if inside and os.path.isfile(candidate):
        return candidate
    base = os.path.basename(name.rstrip("/"))
    index = os.path.join(root, "index.html")
    if inside and "." not in base and os.path.isfile(index):
        return index
    return None


def write_runtime(handler):
    body = credentials() if is_loopback(handler.client_address[0]) else None
    if body is None:
        handler.send_response(404)
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(
            "%s %s\n" % (self.client_address[0], fmt % args)
        )

    def do_HEAD(self):
        self.respond(head=True)

    def do_GET(self):
        self.respond(head=False)

    def respond(self, head):
        path = urlsplit(self.path).path
        if path == "/runtime/telegram-app":
            if head:
                body = credentials() if is_loopback(self.client_address[0]) else None
                code = 200 if body is not None else 404
                self.send_response(code)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", "0" if body is None else str(len(body)))
                if body is not None:
                    self.send_header("Content-Type", "application/json")
                self.end_headers()
                return
            write_runtime(self)
            return
        # If-Modified-Since is ignored on purpose. A 1970 Last-Modified would
        # otherwise 304 after a redeploy and the browser would keep the old page.
        target = file_for(self.path)
        if target is None and path == "/favicon.ico":
            self.send_response(200)
            self.send_header("Content-Type", "image/x-icon")
            self.send_header("Content-Length", str(len(FAVICON)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if head:
                return
            self.wfile.write(FAVICON)
            return
        if target is None:
            self.send_response(404)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = os.path.getsize(target)
        ext = os.path.splitext(target)[1]
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache_control(target))
        self.end_headers()
        if head:
            return
        with open(target, "rb") as handle:
            while True:
                chunk = handle.read(64 * 1024)
                if chunk == b"":
                    break
                self.wfile.write(chunk)


class LegacyHandler(http.server.SimpleHTTPRequestHandler):
    """The demo server that was not in the repo: date revalidation plus no-cache."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "%s %s\n" % (self.client_address[0], fmt % args)
        )

    def end_headers(self):
        path = urlsplit(self.path).path
        if path.startswith("/assets/"):
            self.send_header(
                "Cache-Control", "public, max-age=31536000, immutable"
            )
        else:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/runtime/telegram-app":
            write_runtime(self)
            return
        relative = unquote(path).lstrip("/")
        candidate = os.path.join(live_root(), relative)
        base = os.path.basename(path.rstrip("/"))
        if not os.path.exists(candidate) and "." not in base:
            self.path = "/index.html"
        super().do_GET()


def serve(root, port):
    global ROOT
    ROOT = root
    if not os.path.isdir(root):
        sys.stderr.write("website-serve: root is not a directory\n")
        return 1
    handler = LegacyHandler if LEGACY else Handler
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    bound = server.server_address[1]
    sys.stdout.write("serving website on http://127.0.0.1:%s/\n" % bound)
    sys.stdout.flush()
    server.serve_forever()
    return 0


def main(argv):
    if len(argv) != 3:
        sys.stderr.write("usage: website_serve.py ROOT PORT\n")
        return 2
    try:
        port = int(argv[2])
    except ValueError:
        sys.stderr.write("website-serve: port must be an integer\n")
        return 2
    return serve(argv[1], port)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
