#!/usr/bin/env python3
"""Export private map documents and referenced assets for the same teacher's cloud.

The output must stay outside public/ and site/. No evaluations or plans are read.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from lesson_canvas import CanvasStore
from server import EvaluationStore


def export_transfer(storage,output):
    output=Path(output).resolve()
    if output.is_relative_to(ROOT/'public') or output.is_relative_to(ROOT/'site'):
        raise ValueError('Το ιδιωτικό πακέτο πρέπει να αποθηκευτεί εκτός δημόσιου φακέλου.')
    store=CanvasStore(EvaluationStore(storage))
    documents=[[r['document_id'],{'kind':r['kind'],'document':r['document']}] for r in store.latest()]
    needed={m['asset_id'] for _,row in documents for b in row['document'].get('buildings',[]) for m in b['materials'] if m.get('asset_id')}
    assets=[]
    for aid in sorted(needed):
        metadata,path=store.asset(aid)
        assets.append({**metadata,'base64':base64.b64encode(path.read_bytes()).decode()})
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps({'format':'lesson-map-transfer','schema_version':1,'documents':documents,'assets':assets},ensure_ascii=False))
    os.chmod(output,0o600)
    return {'documents':len(documents),'assets':len(assets),'bytes':output.stat().st_size}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--storage',type=Path,default=ROOT/'storage/evaluations')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(export_transfer(args.storage,args.output)))
