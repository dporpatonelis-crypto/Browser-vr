/* Exercise the working map and its real private package on an isolated local service. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium, devices} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = process.env.LESSON_MAP_TEST_URL || 'http://127.0.0.1:8798';
const inputs = path.resolve(process.env.PLANET_MAP_FIXTURES || 'storage/imports/b-lykeiou-planets');
const output = path.resolve(process.env.PLANET_MAP_REVIEW || 'storage/review');
const bundlePath = path.resolve(process.env.PLANET_MAP_PACKAGE || 'storage/publish/b-lykeiou-christianity.lessonmap.json');
const ids = JSON.parse(fs.readFileSync(path.join(inputs, 'ids.json')));
const latest = rows => rows.filter(row => !rows.some(newer => newer.previous_version_id === row.id));
const checks = [];
const pageErrors = [];
const activityWarnings = [];

function check(name, condition = true) {
  assert.ok(condition, name);
  checks.push(name);
  console.log('PASS', name);
}

function recordError(error) {
  // Interactive Sculpture still plays its browser scenario without the
  // optional WebXR feature, which is restricted inside our sandbox.
  if (error.stack?.includes('/Interactive-sculpture/?scenario=slides-discovery') &&
      error.message.includes('XRSystem') && error.message.includes('disallowed by permissions policy')) {
    activityWarnings.push(error.message);
    return;
  }
  pageErrors.push(error.message);
  console.error(error.message);
}

async function importFromFile(page) {
  await page.locator('[data-action="import"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#lm-transfer-file').click();
  await (await chooser).setFiles(bundlePath);
}

const returnToMap = page => page.locator('[data-action="home"]').click();
const closeDialog = page => page.locator('dialog[open] .lm-close').last().click();
const openCity = (page, key) => page.locator('.lm-planet[data-planet-artwork="' + key + '"] [data-open-lesson]').click();
const openWorkshop = page => page.locator('[data-open-building="html"]').click();
const viewer = page => page.frameLocator('dialog[open] .lm-html-frame');

(async () => {
  fs.mkdirSync(output, {recursive: true});
  const browser = await chromium.launch({headless: true, channel: 'chrome'});
  try {
    const context = await browser.newContext({viewport: {width: 1620, height: 1080}});
    const page = await context.newPage();
    page.on('pageerror', recordError);
    const snapshot = async () => (await page.request.get(base + '/api/lesson-maps')).json();
    const before = await snapshot();
    const known = new Map(latest(before.versions).map(row => [row.document_id, row.document]));
    assert.ok(!known.has(ids.workspace), 'Start with the saved A and B Gymnasium baseline only.');
    await page.goto(base + '/#map');
    await page.locator('.lm-island').first().waitFor();
    await importFromFile(page);
    await page.locator('dialog[open]').getByRole('button', {name: 'Μεταφορά', exact: true}).click();
    await page.getByText('Αποθηκεύτηκε ιδιωτικά.', {exact: false}).waitFor();
    const saved = await snapshot();
    const current = new Map(latest(saved.versions).map(row => [row.document_id, row.document]));
    const workspace = current.get(ids.workspace);
    check('the native file picker imports one workspace and four cities', current.size === known.size + 5 &&
      workspace.grade === 'Β΄ Λυκείου' && workspace.visual_theme === 'planets');
    for (const [id, doc] of known) assert.deepEqual(current.get(id), doc);
    check('all pre-existing maps and cities are preserved');
    check('exactly four illustrated planets and six workshop activities were saved', workspace.themes.length === 4 &&
      workspace.lessons.length === 4 && workspace.lessons.reduce((n, city) => n +
        current.get(city.canvas_id).buildings.find(b => b.id === 'html').materials.length, 0) === 6);

    await importFromFile(page);
    await page.getByText('Οι χάρτες υπάρχουν ήδη στον ιδιωτικό χώρο και διατηρήθηκαν.', {exact: true}).waitFor();
    check('reimport adds no versions', (await snapshot()).versions.length === saved.versions.length);

    await page.locator('[data-map-grade]').selectOption('Β΄ Λυκείου');
    await page.waitForFunction(() => [...document.querySelectorAll('.lm-planet .lm-sprite')].filter(img => img.naturalWidth > 0).length === 4);
    check('grade picker opens four distinct illustrated planets', await page.locator('.lm-planet').count() === 4);
    await page.locator('[data-action="zoom-in"]').click();
    const position = await page.locator('.lm-world').evaluate(el => el.style.transform);
    await openCity(page, 'search');
    check('a city opens directly into the five buildings', await page.locator('.lm-building').count() === 5);
    await openWorkshop(page);
    await viewer(page).locator('#scenario-select').waitFor({state: 'attached', timeout: 18000});
    await viewer(page).getByText(/snapshot · 6 ευρήματα/).waitFor({state: 'attached', timeout: 18000});
    check('Interactive Sculpture opens with the six-discovery scenario',
      await viewer(page).locator('#scenario-select').inputValue() === 'slides-discovery');
    await page.locator('dialog[open] [data-next]').click();
    check('Revelation offers an authenticated Drive download and identifies its exact unit',
      await page.locator('dialog[open]').getByRole('link', {name: /Λήψη από το Drive/}).count() === 1 &&
      (await page.locator('dialog[open] .lm-empty').innerText()).includes('Οντολογικός χάρτης της Αποκάλυψης'));
    await closeDialog(page);
    await returnToMap(page);
    check('the overview preserves its zoom and position', await page.locator('.lm-world').evaluate(el => el.style.transform) === position);
    await page.locator('[aria-label="Προβολή όλου του χάρτη"]').click();
    await page.screenshot({path: path.join(output, 'christianity-map-local.png'), fullPage: true});

    await openCity(page, 'creation');
    await openWorkshop(page);
    await viewer(page).locator('#activity-select option').nth(4).waitFor({state: 'attached', timeout: 18000});
    check('Creation loads its five existing activities', await viewer(page).locator('#activity-select option').count() === 5);
    await viewer(page).locator('#activity-select').selectOption('creation-image-for-everyone');
    await viewer(page).getByRole('heading', {name: 'Η εικόνα αφορά όλη την ανθρωπότητα', exact: true}).waitFor();
    check('Creation changes to the selected exercise');
    await page.locator('dialog[open] [data-next]').click();
    check('the second Creation unit keeps its own title and download instructions',
      (await page.locator('dialog[open] .lm-empty').innerText()).includes('Ο άνθρωπος: δώρο και κλήση'));
    await closeDialog(page);
    await returnToMap(page);

    await openCity(page, 'trinity');
    await page.waitForFunction(() => [...document.querySelectorAll('.lm-building .lm-sprite')].filter(img => img.naturalWidth > 0).length === 5);
    check('the Trinity city takes its planet palette', await page.locator('.lesson-map').getAttribute('data-planet-surface') === 'trinity');
    await page.screenshot({path: path.join(output, 'christianity-city-local.png'), fullPage: true});
    await openWorkshop(page);
    await viewer(page).locator('#activity-select option').nth(4).waitFor({state: 'attached', timeout: 18000});
    check('the Trinity opens the advanced unit directly', (await page.locator('.lm-html-frame').getAttribute('src')).endsWith('#unit=advanced') &&
      await viewer(page).locator('#activity-select option').count() === 5);
    await closeDialog(page);
    await page.locator('[data-action="atlas"]').click();
    check('the atlas displays a proposed Trinity–Divine Economy relation', await page.locator('.lm-atlas-relation.proposed').count() === 1);
    await page.locator('[data-atlas-open="' + ids.economy + '"]').first().click();
    check('the relation opens the existing lesson in its three maps', (await page.locator('.lm-shared-notice').innerText()).includes('3 χάρτες'));

    await page.locator('[data-map-grade]').selectOption('Β΄ Λυκείου');
    await openCity(page, 'judgement');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.locator('[data-open-building="html"]').waitFor();
    check('a saved city route reloads with the correct planet', await page.locator('.lesson-map').getAttribute('data-planet-surface') === 'judgement');
    await openWorkshop(page);
    await viewer(page).getByRole('heading', {name: 'Μέλλουσα Κρίση', exact: true}).waitFor({timeout: 18000});
    const sandbox = (await page.locator('.lm-html-frame').getAttribute('sandbox')).split(' ');
    check('the actual Judgement HTML opens in the isolated viewer', sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'));
    await viewer(page).locator('#open-interpretation').click();
    check('Judgement can open the interpretation activity', await viewer(page).locator('#interpretation-dialog').isVisible());
    await closeDialog(page);

    await page.locator('[data-node-select="html"]').click();
    await page.locator('[data-remove-entry]').click();
    await returnToMap(page);
    check('removing the last activity hides that planet', await page.locator('.lm-planet').count() === 3);
    await page.locator('[data-action="undo"]').click();
    check('undo restores its city and artwork', await page.locator('.lm-planet').count() === 4);
    await page.locator('[data-action="mode"]').click();
    await openCity(page, 'trinity');
    check('presentation shows the populated workshop and hides teacher tools',
      await page.locator('.lm-building').count() === 1 && await page.locator('[data-action="atlas"]').count() === 0);
    await context.close();

    const touch = await browser.newContext({...devices['Pixel 7']});
    const mobile = await touch.newPage();
    mobile.on('pageerror', recordError);
    await mobile.goto(base + '/#map/' + ids.workspace);
    const cityButton = mobile.getByRole('navigation', {name: 'Γρήγορη επιλογή πόλης'})
      .getByRole('button', {name: 'Αγία Τριάδα και βίωμα', exact: true});
    await cityButton.waitFor();
    check('Pixel 7 touch view fits its viewport', await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await cityButton.tap();
    check('touch navigation opens the city and its workshop', await mobile.locator('[data-open-building="html"]').count() === 1);
    await mobile.screenshot({path: path.join(output, 'christianity-touch-local.png'), fullPage: true});
    await touch.close();
    check('no unexpected browser errors', pageErrors.length === 0);
    fs.writeFileSync(path.join(output, 'christianity-browser.json'), JSON.stringify({checks, pageErrors, activityWarnings}, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
