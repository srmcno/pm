"""Offline site integrity checks. No network or browser is required."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1] / "dashboard"

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

def main():
    count = 0
    for file in ROOT.glob("*.html"):
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
        for script in page.scripts:
            with tempfile.NamedTemporaryFile(mode="w", suffix=".mjs") as tmp:
                tmp.write(script)
                tmp.flush()
                subprocess.run(["node", "--check", tmp.name], check=True, capture_output=True)
        count += 1
    print(f"Validated local resources, unique IDs, and scripts in {count} pages")

if __name__ == "__main__":
    main()
