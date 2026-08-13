#!/usr/bin/env python3
"""Inject data/analyzed.json into dashboard/template.html -> dashboard/index.html."""
import json
import os

BASE = os.path.join(os.path.dirname(__file__), "..")


def read_optional(*path):
    try:
        with open(os.path.join(BASE, *path)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def main():
    with open(os.path.join(BASE, "data", "analyzed.json")) as f:
        data = json.load(f)
    with open(os.path.join(BASE, "dashboard", "template.html")) as f:
        tpl = f.read()
    # </script> inside JSON strings would close the data block early.
    enc = lambda obj: json.dumps(obj, separators=(",", ":")).replace("</", "<\\/")
    out = (tpl.replace("/*__DATA__*/", enc(data))
              .replace("/*__SIGNALS__*/", enc(read_optional("data", "signals", "latest.json")))
              .replace("/*__PAPER__*/", enc(read_optional("dashboard", "data", "paper.json"))))
    out_path = os.path.join(BASE, "dashboard", "index.html")
    with open(out_path, "w") as f:
        f.write(out)
    print(f"Wrote {out_path} ({os.path.getsize(out_path)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
