"""Compatibility launcher: all application behavior lives in the Node.js server."""
import os
from pathlib import Path
import shutil
import sys

if __name__ == "__main__":
    node = shutil.which("node")
    if not node:
        sys.exit("Install Node.js 24 or later, run npm ci, then run npm start.")
    project = Path(__file__).resolve().parent
    os.chdir(project)
    os.execv(node, [node, str(project / "server.js")])
