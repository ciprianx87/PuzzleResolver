"""Stamp content fingerprints into index.html so browsers never mix old and new files.

GitHub Pages lets browsers cache files for about 10 minutes, and phones keep them longer. Without fingerprints a
phone can combine a cached old page with a newer script (or old modules with a new app.js) and the app stops while
starting. This rewrites the stylesheet link, the app script and an import map so that every page version asks for
exactly the file versions it was made with.

Run before committing a change to the app:   python tools/stamp.py
"""
import hashlib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent


def fingerprint(path):
    return hashlib.sha1(path.read_bytes()).hexdigest()[:10]


def main():
    html_path = ROOT / 'index.html'
    html = html_path.read_text(encoding='utf-8')
    modules = sorted((ROOT / 'js').glob('*.js'))
    imports = ',\n'.join(
        f'      "./js/{m.name}": "./js/{m.name}?v={fingerprint(m)}"' for m in modules)
    importmap = ('  <script type="importmap">\n  {\n    "imports": {\n' + imports + '\n    }\n  }\n  </script>\n')
    block = re.compile(r'  <script type="importmap">.*?</script>\n', re.S)
    if block.search(html):
        html = block.sub(lambda _: importmap, html)
    else:  # first run: the import map must come before any module script
        html = html.replace('</head>', importmap + '</head>', 1)
    css = ROOT / 'css' / 'style.css'
    html = re.sub(r'href="css/style\.css(\?v=\w+)?"', f'href="css/style.css?v={fingerprint(css)}"', html)
    app = ROOT / 'js' / 'app.js'
    html = re.sub(r'src="js/app\.js(\?v=\w+)?"', f'src="js/app.js?v={fingerprint(app)}"', html)
    html_path.write_text(html, encoding='utf-8', newline='\n')
    print(f'stamped {len(modules)} modules and the stylesheet into index.html')


if __name__ == '__main__':
    main()
