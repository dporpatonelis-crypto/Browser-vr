#!/usr/bin/env python3
"""Stage only the reviewed repository files; source caches and records stay local."""
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    '.gitignore', 'README.md', 'index.html', 'config.example.json', 'pedagogical-overrides.json',
    'server.py', 'start.command', '.github/workflows/pages.yml',
    'docs/publishing.md', 'docs/integration-contract.md',
    'cloud/Code.gs', 'cloud/appsscript.json',
    'scripts/build_registry.py', 'scripts/prepare_apps.py', 'scripts/start.py',
    'scripts/export_site.py', 'scripts/build_cloud.py', 'scripts/prepare_repository.py',
    'scripts/build_pages_board.py',
    'public/index.html', 'public/styles.css', 'public/icon.svg', 'public/app.mjs', 'public/domain.mjs',
    'public/data/pedagogical-models.json', 'tests/domain.test.mjs', 'tests/cloud.test.mjs',
    'tests/test_publication.py', 'tests/test_mission_control.py', 'storage/.gitkeep',
]


def prepare_repository(output=ROOT/'storage/github-repository'):
    output = Path(output)
    if output.resolve() != (ROOT/'storage/github-repository').resolve():
        raise ValueError('Η προετοιμασία γράφει μόνο στον δικό της προσωρινό φάκελο.')
    if output.exists():
        shutil.rmtree(output)
    for name in FILES:
        target = output/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT/name, target)
    shutil.copytree(ROOT/'site', output/'site')
    (output/'.nojekyll').touch()
    return output


if __name__ == '__main__':
    print(prepare_repository())
