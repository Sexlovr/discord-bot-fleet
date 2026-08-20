#!/usr/bin/env python3
"""Start Next.js dev server as a fully-detached daemon.

Uses start_new_session=True (setsid) + redirected stdio so the process
survives the parent bash session's exit.
"""
import os
import sys
import time
import subprocess
import signal
from pathlib import Path

PROJECT = "/home/z/my-project"
LOG = "/tmp/next.log"
PIDFILE = "/tmp/next.pid"

# Kill any existing next processes
try:
    subprocess.run(["pkill", "-9", "-f", "next dev"], capture_output=True)
    subprocess.run(["pkill", "-9", "-f", "next-server"], capture_output=True)
except Exception:
    pass
time.sleep(1)

# Open log file
log_fp = open(LOG, "wb", buffering=0)

# Detach into a new session + new process group
proc = subprocess.Popen(
    ["npx", "next", "dev"],
    cwd=PROJECT,
    stdout=log_fp,
    stderr=subprocess.STDOUT,
    stdin=subprocess.DEVNULL,
    start_new_session=True,  # setsid — fully detach from controlling terminal
    close_fds=True,
)

# Write pidfile
Path(PIDFILE).write_text(str(proc.pid))

print(f"Next.js started as PID {proc.pid}, log at {LOG}")
print(f"Waiting for server to be ready...")

# Wait for HTTP 200
import urllib.request
for i in range(40):
    time.sleep(1)
    try:
        req = urllib.request.urlopen("http://localhost:3000/", timeout=2)
        if req.status == 200:
            print(f"Ready after {i+1}s")
            sys.exit(0)
    except Exception:
        pass

print("Server did not become ready in 40s", file=sys.stderr)
sys.exit(1)
