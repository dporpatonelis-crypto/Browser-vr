/* Isolated local service only; actual material fixtures stay outside git. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,devices}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.LESSON_MAP_TEST_URL||'http://127.0.0.1:8796';
const fixture=path.resolve(process.env.MAP_ATLAS_FIXTURES||'storage/imports/b-gymnasiou-ready');
const ids=JSON.parse(fs.readFileSync(path.join(fixture,'ids.json'))),checks=[],errors=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name);};
const latest=data=>data.versions.filter(v=>!data.versions.some(n=>n.previous_version_id===v.id));
const submit=(p,label)=>p.locator('dialog[open]').last().getByRole('button',{name:label,exact:true}).click();
const close=p=>p.locator('dialog[open] .lm-close').last().click();
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const ctx=await browser.newContext({viewport:{width:1672,height:1100}}),p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));
  const snapshot=async()=> (await p.request.get(base+'/api/lesson-maps')).json();
  const before=await snapshot(),old=new Map(latest(before).map(v=>[v.document_id,v.document]));
  await p.goto(base+'/#map');await p.locator('.lm-island').first().waitFor();check('legacy A route opens the existing five islands',await p.locator('.lm-island').count()===5);
  for(const name of ['b-jerusalem','b-mediterranean']){await p.locator('[data-action="import"]').click();await p.locator('#lm-transfer-file').setInputFiles(path.resolve('storage/publish/'+name+'.lessonmap.json'));await submit(p,'Μεταφορά');await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor({timeout:120000});}
  const initial=await snapshot(),rows=latest(initial);
  check('two maps and three cities are added once',rows.filter(r=>r.kind==='workspace').length===3&&rows.filter(r=>r.kind==='canvas').length===13);
  check('every pre-existing A document remains byte-for-byte equivalent', [...old].every(([id,doc])=>JSON.stringify(rows.find(r=>r.document_id===id).document)===JSON.stringify(doc)));
  check('asset identity index contains metadata without payload',Object.values(initial.asset_metadata).every(m=>m.sha256&&!m.base64));
  for(const name of ['b-jerusalem','b-mediterranean']){await p.locator('[data-action="import"]').click();await p.locator('#lm-transfer-file').setInputFiles(path.resolve('storage/publish/'+name+'.lessonmap.json'));await p.getByText('Οι χάρτες υπάρχουν ήδη στον ιδιωτικό χώρο και διατηρήθηκαν.',{exact:true}).waitFor();}
  check('repeat import produces no extra versions',(await snapshot()).versions.length===initial.versions.length);
  await p.locator('[data-map-grade]').selectOption('Β΄ Γυμνασίου');await p.locator('.lm-style-jerusalem').waitFor();
  check('B picker offers two maps and Jerusalem starts with two islands',await p.locator('[data-map-select] option').count()===2&&await p.locator('.lm-island').count()===2);
  await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).click();await p.locator('.lm-building').first().waitFor();
  check('shared economy has five buildings and three map memberships',await p.locator('.lm-building').count()===5&&(await p.locator('.lm-shared-notice').innerText()).includes('3 χάρτες'));
  check('shared city adopts Jerusalem sprites',await p.locator('.lm-sprite').first().getAttribute('src').then(s=>s.includes('/jerusalem/')));
  await p.locator('[data-map-select]').selectOption(ids.mediterranean);await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).click();
  check('same city adopts Mediterranean sprites with contextual route',p.url().includes('#map/'+ids.mediterranean+'/canvas/'+ids.economy)&&await p.locator('.lm-sprite').first().getAttribute('src').then(s=>s.includes('/mediterranean/')));
  await p.locator('[data-node-select="text"]').click();await p.locator('[data-action="material"]').first().click();await p.locator('[data-source="text"]').click();await p.locator('dialog[open] input[name="label"]').fill('Κοινό δοκιμαστικό κείμενο');await p.locator('dialog[open] textarea[name="text"]').fill('Δοκιμή κοινής επεξεργασίας μόνο στον απομονωμένο χώρο.');await submit(p,'Εφαρμογή');
  await p.locator('[data-action="save"]').click();await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor();
  await p.locator('[data-map-grade]').selectOption('Α΄ Γυμνασίου');await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).click();
  check('shared edit is visible from A without duplicating the city',await p.locator('[data-open-building="text"]').innerText().then(t=>t.includes('1 μέσο')));
  await p.locator('[data-action="undo"]').click();await p.locator('[data-action="save"]').click();await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor();
  await p.locator('[data-action="atlas"]').click();await p.locator('.lm-atlas').waitFor();
  check('teacher atlas shows the same city in all three maps',await p.locator('[data-atlas-focus="'+ids.economy+'"]').count()===3);
  await p.locator('[data-atlas-shared]').check();check('common-only filter hides semantic proposals',await p.locator('.lm-atlas-relation').count()===0);await p.locator('[data-atlas-shared]').uncheck();
  await p.locator('.lm-atlas-links path.same').first().waitFor();check('same-lesson and proposed relations have separate visible lines',await p.locator('.lm-atlas-links path.same').count()===2&&await p.locator('.lm-atlas-links path.proposed').count()>=1);
  await p.locator('[data-atlas-confirm]').first().click();await p.locator('[data-atlas-save]').click();await p.locator('.lm-atlas-relation.confirmed').first().waitFor();check('teacher confirmation survives private save');
  await p.locator('[data-atlas-all]').click();await p.locator('[data-atlas-search]').fill('Φιλοθέη');await p.locator('[data-atlas-focus]').filter({hasText:'Αγία Φιλοθέη'}).click();
  const phi=rows.find(r=>r.document.title==='Αγία Φιλοθέη').document_id;
  await p.locator('[data-atlas-evidence]').first().click();await p.locator('.lm-image-page img').waitFor();await p.waitForFunction(()=>document.querySelector('.lm-image-page img')?.naturalWidth>0);check('evidence opens the source image from another city');await close(p);
  await p.locator('.lm-atlas-material').filter({hasText:rows.find(r=>r.document_id===phi).document.buildings[1].materials[0].label}).locator('[data-atlas-reuse]').click();await p.locator('dialog[open] select[name="canvas_id"]').selectOption(ids.paul);await submit(p,'Προσθήκη');
  await p.locator('.lm-atlas-links path.file').first().waitFor();check('reused file gains an exact-file line without uploading another asset');
  await p.locator('[data-atlas-save]').click();await p.locator('.lm-atlas').waitFor();await close(p);
  const reused=latest(await snapshot()),source=reused.find(r=>r.document_id===phi).document.buildings[1].materials[0],paul=reused.find(r=>r.document_id===ids.paul).document;
  check('material reuse keeps immutable asset identity and a distinct placement',paul.buildings[1].materials.some(m=>m.asset_id===source.asset_id&&m.id!==source.id));
  await p.locator('[data-map-grade]').selectOption('Β΄ Γυμνασίου');await p.locator('[data-map-select]').selectOption(ids.jerusalem);await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).click();
  for(const building of ['images','html']){await p.locator('[data-node-select="'+building+'"]').click();await p.locator('[data-remove-entry]').click();}
  await p.locator('[data-action="home"]').click();check('last material removal hides shared city in Jerusalem',await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).count()===0);
  await p.locator('[data-map-select]').selectOption(ids.mediterranean);check('last material removal also hides its other map placement',await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).count()===0);
  await p.locator('[data-action="undo"]').click();check('undo restores the shared city',await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).count()===1);await p.locator('[data-action="undo"]').click();
  await p.locator('[data-action="save"]').click();await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor();await p.reload();await p.locator('.lm-style-mediterranean').waitFor();
  check('reload preserves selected map and shared references',await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).count()===1);
  await p.locator('[data-node-select]').filter({hasText:'Θεία Οικονομία'}).click();await p.locator('[data-remove-entry]').click();check('detaching a city does not delete its canonical document',latest(await snapshot()).some(r=>r.document_id===ids.economy));await p.locator('[data-action="undo"]').click();
  await p.locator('[data-action="mode"]').click();check('presentation has no teacher atlas or sharing notices',await p.locator('[data-action="atlas"],.lm-atlas,.lm-shared-notice').count()===0);
  await p.screenshot({path:path.resolve('storage/review/b-mediterranean-desktop.png'),fullPage:true});
  await p.locator('[data-action="mode"]').click();await p.getByRole('button',{name:'Θεία Οικονομία ↗',exact:true}).click();await p.locator('[data-action="save"]').click();await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor();
  const other=await ctx.newPage();other.on('pageerror',e=>errors.push(e.message));await other.goto(base+'/#canvas/'+ids.economy);await other.locator('.lm-building').first().waitFor();
  for(const [page,title] of [[p,'Αλλαγή από Β΄'],[other,'Σύγκρουση από Α΄']]){await page.locator('[data-action="title"]').click();await page.locator('dialog[open] input[name="title"]').fill(title);await submit(page,'Εφαρμογή');}
  await p.locator('[data-action="save"]').click();await p.getByText('Αποθηκεύτηκε ιδιωτικά.',{exact:false}).waitFor();await other.locator('[data-action="save"]').click();await other.getByText('Ο χάρτης άλλαξε από άλλη συσκευή.',{exact:false}).waitFor();check('concurrent A/B editing preserves the second draft and rejects overwrite',(await other.locator('.lm-plaza').innerText()).includes('Σύγκρουση από Α΄'));await other.close();
  const mobile=await browser.newContext({...devices['Pixel 7']}),mp=await mobile.newPage();mp.on('pageerror',e=>errors.push(e.message));await mp.goto(base+'/#map/'+ids.jerusalem);await mp.locator('.lm-style-jerusalem').waitFor();
  check('B map picker fits Android width',await mp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mp.locator('[data-action="atlas"]').click();await mp.locator('.lm-atlas').waitFor();check('teacher atlas fits Android width',await mp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mp.screenshot({path:path.resolve('storage/review/b-atlas-android.png'),fullPage:true});await mobile.close();
  check('no uncaught JavaScript errors',errors.length===0);
  fs.writeFileSync('storage/review/map-atlas-browser.json',JSON.stringify({checks,errors,physical_android:false},null,2));await ctx.close();
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
