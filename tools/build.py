#!/usr/bin/env python3
"""Build Moni for both GNOME Shell extension systems from one source tree.

  build/esm/     GNOME 45+   (Ubuntu 24.04 = GNOME 46)  source copied as-is
  build/legacy/  GNOME 42-44 (Ubuntu 22.04 = GNOME 42)  ESM rewritten to imports.*
  dist/*.zip     installable with `gnome-extensions install`
"""
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC, BUILD, DIST = ROOT / 'src', ROOT / 'build', ROOT / 'dist'
TARGETS = {'esm': ['45', '46', '47', '48'], 'legacy': ['42', '43', '44']}
JS = ['extension.js', 'prefs.js', 'collectors.js', 'capture.js', 'clipboard.js']
# Runs as its own `gjs -m` process on every GNOME version: copied untouched.
STANDALONE = ['editor.js', 'helper.js']

SHIM = """const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
class {base} {{
    constructor() {{
        this.metadata = Me.metadata;
        this.uuid = Me.uuid;
        this.path = Me.dir.get_path();
    }}

    getSettings() {{
        return ExtensionUtils.getSettings();
    }}

    openPreferences() {{
        ExtensionUtils.openPrefs();
    }}
}}
"""

FOOTER = {
    'extension.js': '\nfunction init() {{\n    return new {cls}();\n}}\n',
    'prefs.js': '\nfunction init() {{}}\n\nfunction fillPreferencesWindow(window) {{\n'
                '    new {cls}().fillPreferencesWindow(window);\n}}\n',
}


def to_legacy(name, src):
    out, default_cls, base = [], None, None
    for line in src.splitlines():
        if m := re.match(r"import (\w+) from 'gi://(\w+)(\?[^']*)?';$", line):
            out.append(f'const {m[1]} = imports.gi.{m[2]};')
        elif m := re.match(r"import \* as (\w+) from 'resource:///org/gnome/shell/ui/(\w+)\.js';$", line):
            out.append(f'const {m[1]} = imports.ui.{m[2]};')
        elif m := re.match(r"import \{(\w+)\} from 'resource:///org/gnome/(shell|Shell)/.*/(extension|prefs)\.js';$", line):
            base = m[1]
        elif m := re.match(r"import \* as (\w+) from '\./(\w+)\.js';$", line):
            out.append(f'const {m[1]} = Me.imports.{m[2]};')
        elif line == "import Cairo from 'cairo';":
            out.append('const Cairo = imports.cairo;')
        elif line.startswith('import '):
            sys.exit(f'{name}: no legacy rule for: {line}')
        elif m := re.match(r'export default class (\w+)(.*)$', line):
            default_cls = m[1]
            out.append(f'class {m[1]}{m[2]}')
        else:
            line = re.sub(r'^export class (\w+)', r'var \1 = class \1', line)
            line = re.sub(r'^export (function|async function) ', r'\1 ', line)
            line = re.sub(r'^export (const|let) ', 'var ', line)
            if line.startswith('export '):
                sys.exit(f'{name}: no legacy rule for: {line}')
            out.append(line)
    body = '\n'.join(out) + '\n'
    if name in FOOTER:
        shim = SHIM.format(base=base)
        if name == 'prefs.js':
            shim = re.sub(r'\n\n    openPreferences\(\) \{\n.*?\n    \}', '', shim, flags=re.S)
        body = shim + '\n' + body + FOOTER[name].format(cls=default_cls)
    elif 'Me.imports' in body:
        body = 'const Me = imports.misc.extensionUtils.getCurrentExtension();\n' + body
    return body


def build(target):
    out = BUILD / target
    shutil.rmtree(out, ignore_errors=True)
    (out / 'schemas').mkdir(parents=True)
    for f in JS:
        src = (SRC / f).read_text()
        (out / f).write_text(src if target == 'esm' else to_legacy(f, src))
    for f in STANDALONE:
        shutil.copy(SRC / f, out)
    shutil.copy(SRC / 'stylesheet.css', out)
    for xml in (SRC / 'schemas').glob('*.xml'):
        shutil.copy(xml, out / 'schemas')
    subprocess.run(['glib-compile-schemas', str(out / 'schemas')], check=True)
    meta = json.loads((SRC / 'metadata.json').read_text())
    meta['shell-version'] = TARGETS[target]
    (out / 'metadata.json').write_text(json.dumps(meta, indent=2) + '\n')

    DIST.mkdir(exist_ok=True)
    zip_path = DIST / f"{meta['uuid']}.gnome{TARGETS[target][0]}-{TARGETS[target][-1]}.v{meta['version-name']}.zip"
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in sorted(out.rglob('*')):
            if p.is_file():
                z.write(p, p.relative_to(out))
    print(f'built {out.relative_to(ROOT)}  ->  {zip_path.relative_to(ROOT)}')


if __name__ == '__main__':
    for t in sys.argv[1:] or TARGETS:
        build(t)
