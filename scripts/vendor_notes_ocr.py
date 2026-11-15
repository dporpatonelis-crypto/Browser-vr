"""Pin browser OCR distributions; no lesson content is sent to these URLs."""
import base64
import hashlib
import io
import json
import tarfile
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
    ('tesseract.js', '7.0.0', 'https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz', 'exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA=='),
    ('tesseract.js-core', '7.0.0', 'https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz', 'WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw=='),
    ('ell', '1.0.0', 'https://registry.npmjs.org/@tesseract.js-data/ell/-/ell-1.0.0.tgz', 'cCdWHcxHupC9YltWAoscqnw1QAIo4ENgaXNNVXfN+FBvSncnx3lgnNcyRdCvGSi31buwr7vPY156WHu2Yubg4A=='),
    ('eng', '1.0.0', 'https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz', 'mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg=='),
]


def vendor():
    target = ROOT / 'public/vendor/notes-ocr'
    manifest = []
    for name, version, url, digest in PACKAGES:
        payload = urlopen(url, timeout=60).read()
        if base64.b64encode(hashlib.sha512(payload).digest()).decode() != digest:
            raise ValueError('Upstream integrity mismatch: ' + name)
        files = []
        with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
            for member in archive.getmembers():
                path = Path(member.name)
                relative = None
                if not member.isfile():
                    continue
                if name == 'tesseract.js' and path.name in ('tesseract.esm.min.js', 'worker.min.js') and path.parent.name == 'dist':
                    relative = Path(path.name)
                elif name == 'tesseract.js-core' and path.name.startswith('tesseract-core') and path.suffix in ('.js', '.wasm'):
                    relative = Path('core') / path.name
                elif name in ('ell', 'eng') and '4.0.0_best_int' in path.parts and path.name == name + '.traineddata.gz':
                    relative = Path('lang') / path.name
                elif path.name.upper().startswith('LICENSE'):
                    relative = Path('licenses') / (name + '-' + path.name)
                if relative:
                    data = archive.extractfile(member).read()
                    destination = target / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    files.append({'path': str(relative), 'sha256': hashlib.sha256(data).hexdigest()})
        manifest.append({'package': name, 'version': version, 'url': url, 'integrity': 'sha512-' + digest, 'files': files})
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print('Pinned OCR assets:', sum(len(p['files']) for p in manifest))


if __name__ == '__main__':
    vendor()
