"""Offline site integrity checks. No network or browser is required."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1] / "dashboard"
# Static and dynamic relative module specifiers; build query strings are ignored.
IMPORT = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}/[^"'?#]+)(?:[?#][^"']*)?["']""")

class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.links, self.scripts = [], [], []
        self.active = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if a.get("id"):
            self.ids.append(a["id"])
        for key in ("src", "href"):
            if a.get(key):
                self.links.append(a[key])
        if tag == "script" and not a.get("src"):
            self.active = "" if a.get("type", "") not in ("application/json",) else None

    def handle_data(self, data):
        if self.active is not None:
            self.active += data

    def handle_endtag(self, tag):
        if tag == "script" and self.active is not None:
            self.scripts.append(self.active)
            self.active = None

def imports(source, base, pending, name):
    for spec in IMPORT.findall(source):
        target = (base / unquote(spec)).resolve()
        assert target.is_file(), f"missing module import in {name}: {spec}"
        pending.append(target)

def main(root=ROOT):
    count, pending, modules = 0, [], set()
    for file in root.glob("*.html"):
        if file.name == "template.html":
            continue
        page = Page()
        page.feed(file.read_text())
        assert len(page.ids) == len(set(page.ids)), f"duplicate ids: {file.name}"
        for link in page.links:
            url = urlsplit(link)
            if url.scheme or url.netloc or not url.path:
                continue
            target = (file.parent / unquote(url.path)).resolve()
            assert target.exists(), f"missing local resource in {file.name}: {link}"
            if target.suffix == ".mjs":
                pending.append(target)
        for script in page.scripts:
            imports(script, file.parent, pending, file.name)
            with tempfile.NamedTemporaryFile(mode="w", suffix=".mjs") as tmp:
                tmp.write(script)
                tmp.flush()
                subprocess.run(["node", "--check", tmp.name], check=True, capture_output=True)
        count += 1
    assert count, f"no pages in {root}"
    while pending:
        module = pending.pop()
        if module not in modules:
            modules.add(module)
            imports(module.read_text(), module.parent, pending, module.name)
    extra = "" if root == ROOT else f" and {len(modules)} imported modules in {root}"
    print(f"Validated local resources, unique IDs, and scripts in {count} pages{extra}")

if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT)
