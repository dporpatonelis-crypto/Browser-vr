#!/usr/bin/env python3
import json
import os
import sys
import webbrowser
from pathlib import Path
from urllib.request import urlopen
from prepare_apps import prepare_board

ROOT=Path(__file__).resolve().parents[1]
URL='http://127.0.0.1:8788/'
try:
    with urlopen(URL+'api/health',timeout=2) as response:
        if json.load(response).get('service')=='teaching-mission-control':
            webbrowser.open(URL)
            raise SystemExit(0)
except (OSError,ValueError):
    pass
prepare_board()
os.execv(sys.executable,[sys.executable,str(ROOT/'server.py'),'--open'])
