#!/usr/bin/env python3
"""Build a separate Pages copy of the existing board; original files stay untouched."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def build_pages_board(site_url, published_evidence=None):
    config = json.loads((ROOT/'config.json').read_text())
    source = (Path(config['apps_root'])/'idea-weaver-board').resolve()
    if published_evidence is not None:
        evidence = json.loads(Path(published_evidence).read_text())
        if evidence.get('repository') != 'dporpatonelis-crypto/Browser-vr' or not evidence.get('head'):
            raise ValueError('Χρειάζεται επαληθευμένη δημοσιευμένη έκδοση του πίνακα.')
        base = (ROOT/'site/apps/investigation').resolve()
        verified = set()
        for item in evidence.get('files', []):
            path = (ROOT/item['path']).resolve()
            if not path.is_relative_to(base) or not path.is_file():
                raise ValueError('Λείπει αρχείο του δημοσιευμένου πίνακα.')
            content = path.read_bytes()
            sha = hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()
            if sha != item['sha']:
                raise ValueError('Το αντίγραφο του δημοσιευμένου πίνακα δεν συμφωνεί με το GitHub.')
            verified.add(path)
        entry = base/'index.html'
        if entry not in verified or base/'provenance.json' not in verified:
            raise ValueError('Ελλιπές αποδεικτικό του δημοσιευμένου πίνακα.')
        import re
        for url in re.findall(r'(?:src|href)="([^"]+)"', entry.read_text()):
            prefix = urlsplit(site_url).path.rstrip('/')+'/apps/investigation/'
            if url.startswith(prefix) and (base/url.removeprefix(prefix)).resolve() not in verified:
                raise ValueError('Δεν επαληθεύτηκε το συνδεδεμένο build asset.')
        return base
    output = ROOT/'storage/pages-app-builds/idea-weaver-board'
    build_directory = ROOT/'storage/pages-board-builder'
    base = urlsplit(site_url).path.rstrip('/')+'/apps/investigation/'
    original_app = (source/'src/App.tsx').read_text()
    if '<BrowserRouter>' not in original_app:
        raise ValueError('Ο τρόπος δρομολόγησης του αρχικού πίνακα χρειάζεται νέο έλεγχο.')
    digest = hashlib.sha256(base.encode())
    for path in sorted((source/'src').rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(source)).encode())
            digest.update(path.read_bytes())
    for name in ['package.json', 'index.html', 'tailwind.config.ts', 'postcss.config.js']:
        digest.update((source/name).read_bytes())
    wanted = digest.hexdigest()
    stamp = output/'.source-hash'
    if stamp.is_file() and stamp.read_text().strip() == wanted:
        return output
    build_directory.mkdir(parents=True, exist_ok=True)
    modules = build_directory/'node_modules'
    if not modules.exists():
        modules.symlink_to(source/'node_modules', target_is_directory=True)
    # This transform changes only the generated build's hosting prefix.
    # Module loading, lesson schema, board behavior and original source are unchanged.
    configuration = '''import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react-swc';
export default defineConfig({
  root: __SOURCE__, base: __BASE__, publicDir: false,
  resolve: {alias: {'@': __SRC__}},
  plugins: [{name: 'mission-control-pages-prefix', enforce: 'pre', transform(code,id) {
    if (id.replaceAll('\\\\','/').endsWith('/src/App.tsx'))
      return code.replace('<BrowserRouter>', '<BrowserRouter basename={import.meta.env.BASE_URL}>');
  }}, react()]
});
'''.replace('__SOURCE__', json.dumps(str(source))).replace('__BASE__', json.dumps(base)).replace('__SRC__', json.dumps(str(source/'src')))
    vite_config = build_directory/'vite.config.mjs'
    vite_config.write_text(configuration)
    subprocess.run([shutil.which('node') or 'node', str(source/'node_modules/vite/bin/vite.js'),
                    'build', '--config', str(vite_config), '--outDir', str(output), '--emptyOutDir'], cwd=source, check=True)
    stamp.write_text(wanted+'\n')
    (output/'provenance.json').write_text(json.dumps({
        'original_repository': 'https://github.com/dporpatonelis-crypto/idea-weaver-board',
        'source_sha256': wanted, 'adaptation': 'Hosting prefix for the separate Pages build only.',
        'original_source_modified': False,
    }, ensure_ascii=False, indent=2)+'\n')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--site-url', default='https://dporpatonelis-crypto.github.io/Browser-vr/')
    parser.add_argument('--reuse-published-evidence', type=Path,
                        help='Keep the unchanged pinned public board when refreshing only its lesson catalogue.')
    args = parser.parse_args()
    print(build_pages_board(args.site_url, args.reuse_published_evidence))
