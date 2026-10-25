#!/usr/bin/env python3
"""Build the existing board in Mission Control storage; never replace its own dist."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare_board():
    config = json.loads((ROOT/'config.json').read_text())
    original = Path(config['apps_root'])/'idea-weaver-board'
    output = ROOT/'storage/app-builds/idea-weaver-board'
    stamp = output/'.source-hash'
    source_files = sorted(f for f in (original/'src').rglob('*') if f.is_file() and f.suffix in {'.ts','.tsx','.css','.json'})
    source_files += [original/f for f in ['package.json','index.html','vite.config.ts','tailwind.config.ts','postcss.config.js'] if (original/f).is_file()]
    digest = hashlib.sha256()
    for f in source_files:
        digest.update(str(f.relative_to(original)).encode())
        digest.update(f.read_bytes())
    wanted = digest.hexdigest()
    if stamp.is_file() and stamp.read_text().strip() == wanted and (output/'index.html').is_file():
        print('Ο Πίνακας Διερεύνησης είναι έτοιμος.')
        return
    vite = original/'node_modules/vite/bin/vite.js'
    node = shutil.which('node')
    if not node or not vite.is_file():
        raise SystemExit('Δεν βρέθηκαν οι υπάρχουσες εξαρτήσεις του Πίνακα Διερεύνησης. Το αρχικό project διατηρείται ανέπαφο.')
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([node,str(vite),'build','--outDir',str(output),'--emptyOutDir','--base','/'],cwd=original,check=True)
    stamp.write_text(wanted+'\n')
    print('Ετοιμάστηκε ξεχωριστό αντίγραφο εκτέλεσης του υπάρχοντος Πίνακα Διερεύνησης.')


if __name__=='__main__':
    prepare_board()
