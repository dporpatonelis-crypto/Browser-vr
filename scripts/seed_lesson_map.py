#!/usr/bin/env python3
"""Import the teacher's existing pilot into private storage, without publishing it.

Usage: python3 scripts/seed_lesson_map.py --source /absolute/path/eikona-talanta-loukas
The existing HTML is copied verbatim. Re-running never replaces a teacher map.
"""
import argparse
import json
import mimetypes
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import EvaluationStore
from lesson_canvas import CanvasStore


def seed(source, storage=None):
    source = Path(source).resolve()
    registry_file = ROOT/'public/data/scenario-registry.json'
    if not registry_file.exists():
        registry_file = ROOT/'site/data/scenario-registry.json'
    registry = json.loads(registry_file.read_text())
    js = "import fs from 'node:fs';const m=await import(process.argv[1]);const r=JSON.parse(fs.readFileSync(process.argv[2]));console.log(JSON.stringify({workspace_id:m.LM_WORKSPACE_ID,canvas_id:m.LM_PILOT_ID,workspace:m.lmNewWorkspace(r),canvas:m.lmNewCanvas('Κατ’ εικόνα → Τάλαντα → Άγιος Λουκάς → Καθ’ ομοίωση',m.LM_PILOT_SCENARIO)}));"
    initial = json.loads(subprocess.check_output(['node','--input-type=module','-e',js,(ROOT/'public/lesson-map-domain.mjs').as_uri(),str(registry_file)], text=True))
    store = CanvasStore(EvaluationStore(storage or ROOT/'storage/evaluations'))
    if any(r['document_id']==initial['canvas_id'] for r in store.read()):
        return {'ok':True,'created':False,'message':'Ο υπάρχων χάρτης διατηρήθηκε.'}
    doc = initial['canvas']
    content = json.loads((source/'lesson.json').read_text())
    def mid(): return str(uuid.uuid4())
    def material(kind,label,**kwargs):
        return {'id':mid(),'type':kind,'label':label,'text':'','url':'','asset_id':'','activity_id':'','source_scenario_id':'','page_start':1,'page_end':1,**kwargs}
    def asset(path):
        mime=mimetypes.guess_type(path.name)[0]
        row=store.upload(mid(),path.name,mime,path.read_bytes())
        return row['id']
    by_id = {b['id']:b for b in doc['buildings']}
    for name,title in [('creation-worksheet.txt','Δημιουργία του ανθρώπου · διδακτική απόδοση'),('parable-user.txt','Η παραβολή των ταλάντων · Μτ 25, 14–30')]:
        text=(source/'sources'/name).read_text()
        by_id['text']['materials'].append(material('text',title,text=text))
    for name,title in [('02-eikona-focus-v1.jpg','Κατ’ εικόνα · λογική και ελευθερία'),('04-loukas-focus-v1.jpg','Άγιος Λουκάς ο Ιατρός · γνώση, πίστη, προσφορά'),('05-omoiosi-focus-v1.jpg','Καθ’ ομοίωση · αρετές και χάρη')]:
        by_id['images']['materials'].append(material('image',title,asset_id=asset(source/'assets'/name)))
    map_material=material('image','Η διαδρομή από το κατ’ εικόνα στο καθ’ ομοίωση',asset_id=asset(source/'assets/01-panorama-v1.jpg'))
    by_id['mindmap']['materials'].append(map_material)
    for x,word in [(.225,'Ελευθερία'),(.485,'Ευθύνη'),(.748,'Προσφορά')]:
        doc['annotations'].append({'id':mid(),'kind':'relation','material_id':map_material['id'],
            'points':[{'x':max(0,x-.095),'y':.62},{'x':min(1,x+.095),'y':.62}],'verb':word,'phrase':''})
    html = source.parent/'eikona-talanta-loukas.html'
    by_id['html']['materials'].append(material('html',content['title'],asset_id=asset(html),
        activity_id='8bfbb79428634d24ccbb',source_scenario_id=doc['scenario_id']))
    by_id['synthesis']['materials'].append(material('text','Το ερώτημα της σύνθεσης',text=content['finalQuestion']))
    doc['connections']=[
        {'id':mid(),'from':'text','to':'images','verb':'φανερώνει','phrase':'Η λογική και η ελευθερία είναι δώρα που καλούμαστε να καλλιεργήσουμε.','visible':True},
        {'id':mid(),'from':'mindmap','to':'html','verb':'καλλιεργεί','phrase':'Από τα χαρίσματα και την ευθύνη περνάμε στην προσφορά προς τον άλλον.','visible':True},
        {'id':mid(),'from':'html','to':'synthesis','verb':'εφαρμόζεται στη ζωή','phrase':'Ο άγιος Λουκάς αξιοποιεί τη γνώση της ιατρικής ως έμπρακτη προσφορά.','visible':True}]
    canvas,_=store.save({'request_id':mid(),'document_id':initial['canvas_id'],'kind':'canvas','document':doc},registry)
    if not any(r['document_id']==initial['workspace_id'] for r in store.read()):
        store.save({'request_id':mid(),'document_id':initial['workspace_id'],'kind':'workspace','document':initial['workspace']},registry)
    return {'ok':True,'created':True,'canvas_id':canvas['document_id'],'private_assets':len(list(store.assets.glob('*.json')))}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--storage',type=Path)
    args=parser.parse_args()
    print(json.dumps(seed(args.source,args.storage),ensure_ascii=False))
