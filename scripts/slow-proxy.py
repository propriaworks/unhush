#!/usr/bin/env python3
"""Reverse proxy that holds real transcription / formatting requests, for testing how Unhush
behaves when a custom server is slow: the bar's cancel (x) and fifo "cancel", the "loading model"
hint, and timeout retries.

Only requests that do real work are held: POSTs to /v1/audio/transcriptions and
/v1/chat/completions, except the warm-ups (customModelService.ts uploads 'warmup.wav' and asks
the LLM for max_tokens 1; keep is_warmup() in step if those change). Health checks, warm-ups and
everything else pass straight through, so the app keeps believing the server is up and ready
rather than skipping the step. While a request is held, the proxy watches the client socket and
prints CLIENT ABORTED if the app hangs up, which is what a cancel should do; a held request that
was aborted is never forwarded.

Usage: run one proxy per server, then point that server's "Server URL" in Settings at it (and
back again afterwards):

  scripts/slow-proxy.py --listen 19000 --upstream http://localhost:8000 --delay 30    # transcription
  scripts/slow-proxy.py --listen 19434 --upstream http://localhost:11434 --delay 30   # formatting

  http://127.0.0.1:19000 / http://127.0.0.1:19434 in Settings

Choosing --delay: over 2.5s to see the cancel button; under the app's 90s request timeouts
(TRANSCRIPTION_TIMEOUT_MS, llmApi.ts) to cancel before it gives up, or over 90s to test the
transcription timeout-and-retry path. Responses are buffered, not streamed. Listens on
127.0.0.1 only. Stop it with Ctrl+C.
"""
import argparse
import http.client
import select
import socket
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DELAYED_PATHS = ("/v1/audio/transcriptions", "/v1/chat/completions")
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
              "proxy-authorization", "proxy-authenticate", "host", "content-length"}


def is_warmup(body: bytes) -> bool:
    return b'filename="warmup.wav"' in body or b'"max_tokens": 1,' in body \
        or b'"max_tokens":1,' in body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} {fmt % args}", flush=True)

    def client_gone(self) -> bool:
        """True if the client closed its end (readable with no data = EOF)."""
        readable, _, _ = select.select([self.connection], [], [], 0)
        if not readable:
            return False
        try:
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except OSError:
            return True

    def hold(self, seconds: float) -> bool:
        """Sleep up to `seconds`; False (and a log line) if the client hangs up meanwhile."""
        t0 = time.time()
        print(f"{time.strftime('%H:%M:%S')}   holding {self.path} for {seconds:.0f}s", flush=True)
        while time.time() - t0 < seconds:
            if self.client_gone():
                print(f"{time.strftime('%H:%M:%S')}   CLIENT ABORTED {self.path} after "
                      f"{time.time() - t0:.1f}s -- request never forwarded", flush=True)
                return False
            time.sleep(0.1)
        return True

    def forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        path_only = urllib.parse.urlsplit(self.path).path
        if self.command == "POST" and path_only in DELAYED_PATHS:
            if is_warmup(body):
                print(f"{time.strftime('%H:%M:%S')}   warm-up, passing through", flush=True)
            elif not self.hold(ARGS.delay):
                self.close_connection = True
                return

        up = urllib.parse.urlsplit(ARGS.upstream)
        conn = http.client.HTTPConnection(up.hostname, up.port, timeout=300)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        if body:
            headers["Content-Length"] = str(len(body))
        conn.request(self.command, self.path, body=body or None, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        self.send_response(resp.status, resp.reason)
        for k, v in resp.getheaders():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        conn.close()

    do_GET = do_POST = do_DELETE = do_HEAD = forward


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listen", type=int, required=True, help="local port")
    ap.add_argument("--upstream", required=True, help="real server, e.g. http://192.168.1.2:9000")
    ap.add_argument("--delay", type=float, default=20, help="seconds to hold real requests")
    ARGS = ap.parse_args()
    print(f"proxy 127.0.0.1:{ARGS.listen} -> {ARGS.upstream}, delaying {', '.join(DELAYED_PATHS)} "
          f"by {ARGS.delay:.0f}s", flush=True)
    ThreadingHTTPServer(("127.0.0.1", ARGS.listen), Handler).serve_forever()
