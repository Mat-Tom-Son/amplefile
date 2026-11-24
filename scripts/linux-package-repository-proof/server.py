# A stand-in for the two GitHub hosts dnf talks to, for the package
# repository proof (README.md beside this file). It answers on one HTTPS port
# for every name, the way the real hosts do:
#
#   raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH
#       the file at PATH in the proof repository's branch commit, read with
#       `git show`, as text/plain; a folder or a missing file is a 404 (no
#       directory listing). The ref served is the first line of SERVE_REF_FILE,
#       so a test can point it at a tampered commit.
#   github.com/OWNER/REPO/releases/download/TAG/FILE
#       a 302 to release-assets.githubusercontent.com/TAG/FILE
#   release-assets.githubusercontent.com/TAG/FILE
#       RELEASES/TAG/FILE as application/octet-stream
#
# Usage: python3 server.py CERT KEY GIT_DIR SERVE_REF_FILE RELEASES_DIR OWNER REPO BRANCH
import http.server
import os
import re
import ssl
import subprocess
import sys
import urllib.parse

CERT, KEY, GIT_DIR, SERVE_REF_FILE, RELEASES, OWNER, REPO, BRANCH = sys.argv[1:9]


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.headers.get("Host", "-"), fmt % args))

    def send_bytes(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def not_found(self):
        self.send_bytes(404, b"404: Not Found", "text/plain; charset=utf-8")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if ".." in path.split("/"):
            return self.not_found()
        if host == "raw.githubusercontent.com":
            prefix = "/%s/%s/%s/" % (OWNER, REPO, BRANCH)
            if not path.startswith(prefix):
                return self.not_found()
            inner = path[len(prefix):]
            ref = open(SERVE_REF_FILE).read().split()[0]
            kind = subprocess.run(["git", "-C", GIT_DIR, "cat-file", "-t", "%s:%s" % (ref, inner)], capture_output=True, text=True)
            if kind.returncode != 0 or kind.stdout.strip() != "blob":
                return self.not_found()
            body = subprocess.run(["git", "-C", GIT_DIR, "show", "%s:%s" % (ref, inner)], capture_output=True, check=True).stdout
            return self.send_bytes(200, body, "text/plain; charset=utf-8")
        if host == "github.com":
            match = re.fullmatch(r"/%s/%s/releases/download/([^/]+)/([^/]+)" % (re.escape(OWNER), re.escape(REPO)), path)
            if not match:
                return self.not_found()
            self.send_response(302)
            self.send_header("Location", "https://release-assets.githubusercontent.com/%s/%s" % (urllib.parse.quote(match.group(1)), urllib.parse.quote(match.group(2))))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if host == "release-assets.githubusercontent.com":
            match = re.fullmatch(r"/([^/]+)/([^/]+)", path)
            file = match and os.path.join(RELEASES, match.group(1), match.group(2))
            if not file or not os.path.isfile(file):
                return self.not_found()
            with open(file, "rb") as handle:
                return self.send_bytes(200, handle.read(), "application/octet-stream")
        return self.not_found()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server.socket = context.wrap_socket(server.socket, server_side=True)
print("serving", flush=True)
server.serve_forever()
