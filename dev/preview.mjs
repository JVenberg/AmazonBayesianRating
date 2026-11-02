import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const devDir = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.dirname(devDir);
const outDir = path.join(devDir, 'out');
const products = JSON.parse(fs.readFileSync(path.join(devDir, 'fixture/products.json'), 'utf8'));
const SEARCH_URL = 'https://www.amazon.com/s?k=usb+c+cable';
const CARD_SELECTOR = '[data-component-type="s-search-result"]';
const THUMB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23e8eaed'/%3E%3C/svg%3E";

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Outranks a 4.55 product unless its twenty five-star ratings are treated as fake.
const allFake = { asin: 'B0FIXTFAKE', name: 'Twenty Perfect Ratings USB C Cable', stars: 5, total: 20, price: '$5.99', pcts: [0, 0, 0, 0, 100] };
products.unshift(allFake);

const rated = products.filter(p => p.pcts);
const unrated = products.filter(p => !p.pcts);
// uBlock Origin Lite hides sponsored cards, which come first and can duplicate visible results.
const hiddenOnly = rated.slice(-2);
const hidden = [...rated.slice(0, 3), ...hiddenOnly];
const listed = rated.filter(p => !hiddenOnly.includes(p));
const pages = [[...listed.slice(0, 8), ...unrated], listed.slice(8)];
// This popover always fails, so a retry loop would show up in popoverHits.
const flaky = pages[1][2];

const card = p => `
    <div data-component-type="s-search-result" data-asin="${p.asin}">
      <div class="sg-col-inner">
        <img class="s-image" src="${THUMB}" alt="">
        <h2><span>${esc(p.name)}</span></h2>
        ${p.pcts ? `<div data-cy="reviews-block"><span class="stars">★★★★★</span> ${p.stars} <a>(${p.total.toLocaleString()})</a></div>` : ''}
        <div class="price"><span class="a-price"><span class="a-offscreen">${esc(p.price)}</span><span aria-hidden="true">${esc(p.price)}</span></span></div>
      </div>
    </div>`;

const resultsHtml = n => {
  const sponsored = n === 0 ? `<div style="display:none">${hidden.map(card).join('')}</div>` : '';
  return sponsored + pages[n].map(card).join('');
};

function searchPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Amazon.com : usb c cable (fixture)</title><style>
    body { margin: 0; font: 14px/20px Arial, sans-serif; color: #0f1111; background: #fff; }
    header { background: #131921; color: #fff; padding: 14px 20px; font-weight: 700; }
    main { display: grid; grid-template-columns: 240px 1fr; gap: 16px; padding: 16px; }
    aside { color: #565959; }
    .results { display: grid; grid-template-columns: repeat(4, 280px); gap: 16px; }
    .sg-col-inner { padding: 13px; }
    .s-image { width: 100%; height: 200px; border-radius: 4px; margin-bottom: 8px; }
    h2 { margin: 0 0 4px; font-size: 14px; line-height: 20px; font-weight: 400; }
    .stars { color: #de7921; }
    a { color: #2162a1; }
    .price { font-size: 21px; margin-top: 6px; }
    .a-offscreen { position: absolute; left: -9999px; }
  </style></head><body><header>amazon fixture</header><main><aside>Filters</aside><div class="results">${resultsHtml(0)}</div></main></body></html>`;
}

function popover(asin) {
  const p = products.find(x => x.asin === asin);
  const pcts = p?.pcts ?? [0, 0, 0, 0, 0];
  const total = p?.pcts ? p.total : 0;
  const rows = [5, 4, 3, 2, 1].map(star => `<a aria-label="${star} stars represent ${pcts[star - 1]}% of rating" href="#"></a>`).join('');
  return `<span data-hook="total-review-count" class="a-size-base a-color-secondary totalRatingCount">${total.toLocaleString('en-US')} global ratings</span>${rows}`;
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const popoverHits = new Map();

// Everything is fulfilled or aborted here, so no request reaches Amazon.
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'chrome-extension:') return route.continue();
  if (url.hostname === 'www.amazon.com' && url.pathname === '/s') {
    return route.fulfill({ contentType: 'text/html', body: searchPage() });
  }
  if (url.hostname === 'www.amazon.com' && url.pathname.startsWith('/review/widgets/')) {
    const asin = url.searchParams.get('asin');
    popoverHits.set(asin, (popoverHits.get(asin) ?? 0) + 1);
    if (asin === flaky.asin) return route.fulfill({ status: 503, body: '' });
    return route.fulfill({ contentType: 'text/html', body: popover(asin) });
  }
  return route.abort();
});

const page = context.pages()[0] ?? await context.newPage();
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.text().includes('Bayesian')) logs.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', e => logs.push(`pageerror: ${e.message}`));

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const shot = (name, options) => page.screenshot({ path: path.join(outDir, `${name}.png`), ...options });

const expectedOn = n => pages[n].filter(p => p.pcts && p !== flaky).length;
const waitForBadges = async n => {
  try {
    await page.waitForFunction(count => document.querySelectorAll('.bayesian-badge').length >= count, expectedOn(n), { timeout: 15000 });
  } catch {
    problems.push(`page ${n + 1}: expected ${expectedOn(n)} badges, got ${await page.locator('.bayesian-badge').count()}`);
  }
};
const switchPage = async n => {
  await page.evaluate(html => { document.querySelector('.results').innerHTML = html; }, resultsHtml(n));
  await waitForBadges(n);
};

const badges = page.locator('.bayesian-badge:visible');
const rankRows = () => page.$$eval('.bayesian-rank-row', rows => rows.map(r => ({
  asin: r.dataset.asin,
  rank: Number(r.querySelector('.bayesian-rank-num').textContent),
  mean: Number(r.dataset.mean),
  pBest: Number(r.dataset.pBest),
  ciLow: Number(r.dataset.ciLow),
  ciHigh: Number(r.dataset.ciHigh),
})));
const selectedCount = async () => Number(await page.locator('.bayesian-toolbar-count').textContent());
const selectedBadges = () => page.locator('.bayesian-badge[data-selected="true"]').count();

const checkRanking = async (count, label) => {
  const rows = await rankRows();
  check(rows.length === count, `${label}: expected ${count} ranked rows, got ${rows.length}`);
  rows.forEach((r, i) => {
    check(r.rank === i + 1, `${label}: row ${i + 1} shows rank ${r.rank}`);
    const prev = rows[i - 1];
    if (prev) check(prev.mean > r.mean || (prev.mean === r.mean && prev.pBest >= r.pBest), `${label}: row ${i + 1} is out of order`);
  });
};

await page.goto(SEARCH_URL);
await waitForBadges(0);
await shot('1-unselected');

for (let i = 0; i < 4; i++) await badges.nth(i).click();
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await shot('2-selected');

await page.locator('[data-action="rank"]').click();
await checkRanking(4, 'first ranking');
check((await rankRows()).at(-1)?.asin === allFake.asin, 'all-fake product should rank last');
await shot('3-ranking');

const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
const settingsPage = await context.newPage();
await settingsPage.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
await settingsPage.locator('#examples tr').first().waitFor();

const firstExample = () => settingsPage.locator('#examples tr').first().locator('td').last().textContent();
const noteText = () => page.locator('.bayesian-panel-note').textContent();
const waitForNote = async (text, label) => {
  try {
    await page.waitForFunction(t => document.querySelector('.bayesian-panel-note').textContent.includes(t), text, { timeout: 5000 });
  } catch {
    problems.push(`${label}: note never showed "${text}", got "${await noteText()}"`);
  }
};

check(await settingsPage.locator('#fakeFiveStars').inputValue() === '20', 'settings page should show the default fake count');
check(await firstExample() === '3.00', `twenty perfect ratings should score 3.00 by default, got ${await firstExample()}`);
const intervalAt95 = (await rankRows())[0];

await settingsPage.locator('#intervalPct').selectOption('80');
await waitForNote('80% likely range', 'interval setting');
const intervalAt80 = (await rankRows()).find(r => r.asin === intervalAt95.asin);
check(intervalAt80.ciHigh - intervalAt80.ciLow < intervalAt95.ciHigh - intervalAt95.ciLow, 'an 80% range should be narrower than a 95% range');

await settingsPage.locator('#fakeFiveStars').fill('0');
await waitForNote('Ordered by expected rating. Bars', 'fake setting');
check((await rankRows()).at(-1)?.asin !== allFake.asin, 'with no fakes the perfect product should stop ranking last');
check(await firstExample() === '4.60', `twenty perfect ratings should score 4.60 with no fakes, got ${await firstExample()}`);

const perfectMean = (await rankRows()).find(r => r.asin === allFake.asin).mean;
await settingsPage.locator('#priorMean').fill('4.5');
await settingsPage.locator('#priorStrength').fill('100');
await page.waitForFunction(
  ([asin, mean]) => Number(document.querySelector(`.bayesian-rank-row[data-asin="${asin}"]`).dataset.mean) !== mean,
  [allFake.asin, perfectMean],
  { timeout: 5000 },
).catch(() => problems.push('starting rating settings never reached the ranking'));
await settingsPage.screenshot({ path: path.join(outDir, '7-settings.png'), fullPage: true });

await settingsPage.locator('#rankBy').selectOption('lowEnd');
await waitForNote('low end', 'rank setting');
(await rankRows()).forEach((r, i, rows) => {
  if (i) check(rows[i - 1].ciLow >= r.ciLow, `low-end ranking: row ${i + 1} is out of order`);
});

await settingsPage.locator('#rankBy').selectOption('chance');
await waitForNote('chance of being the best', 'rank setting');
(await rankRows()).forEach((r, i, rows) => {
  if (i && rows[i - 1].pBest >= 0.001 && r.pBest >= 0.001) check(rows[i - 1].pBest >= r.pBest, `chance ranking: row ${i + 1} is out of order`);
});

await settingsPage.locator('#reset').click();
await waitForNote('Ordered by expected rating, assuming 20', 'reset');
await checkRanking(4, 'after settings reset');
check((await rankRows()).at(-1)?.asin === allFake.asin, 'reset should put the all-fake product last again');
check(await settingsPage.locator('#fakeFiveStars').inputValue() === '20', 'reset should restore the fake count on the page');

await settingsPage.close();
const [opened] = await Promise.all([context.waitForEvent('page'), page.locator('[data-action="settings"]').click()]);
await opened.waitForLoadState();
check(opened.url().endsWith('/options.html'), `settings button opened ${opened.url()}`);
await opened.close();
await page.bringToFront();

await switchPage(1);
await page.waitForTimeout(700);
check((await popoverHits.get(flaky.asin)) === 1, `failed popover requested ${popoverHits.get(flaky.asin)} times`);
await badges.nth(0).click();
await badges.nth(1).click();
await checkRanking(6, 'across pages');
await shot('4-page-2');

const hitsBefore = [...popoverHits.values()].reduce((a, b) => a + b, 0);
await switchPage(0);
check(await selectedBadges() === 4, `back on page 1: ${await selectedBadges()} of 4 selected badges restored`);
check([...popoverHits.values()].reduce((a, b) => a + b, 0) === hitsBefore, 'revisiting a page refetched ratings');

await page.reload();
await waitForBadges(0);
check(await selectedCount() === 6, `after reload: ${await selectedCount()} of 6 selections restored`);
check(await selectedBadges() === 4, `after reload: ${await selectedBadges()} of 4 selected badges painted`);
await page.locator('[data-action="rank"]').click();
await checkRanking(6, 'after reload');
await page.locator('.bayesian-rank-row [data-action="remove"]').first().click();
await checkRanking(5, 'after remove');
await shot('5-after-reload');

const selectPageMs = await page.evaluate(() => {
  const t0 = performance.now();
  document.querySelector('[data-action="select-page"]').click();
  return Math.round(performance.now() - t0);
});
await page.waitForTimeout(300);
await shot('6-select-page', { fullPage: true });

const report = await page.$$eval('.bayesian-badge', els => els.map(b => {
  const card = b.closest('[data-component-type="s-search-result"]');
  const clipped = ['.bayesian-main', '.bayesian-ci'].filter(sel => {
    const el = b.querySelector(sel);
    return el.scrollWidth > el.clientWidth;
  });
  if (b.getBoundingClientRect().right > card.getBoundingClientRect().right + 0.5) clipped.push('wider-than-card');
  return { asin: b.dataset.asin, text: b.innerText.replace(/\s+/g, ' ').trim(), clipped };
}));

const coverage = await page.$$eval(CARD_SELECTOR, (cards, ratedAsins) => {
  const shown = c => c.getBoundingClientRect().width > 0;
  const badged = c => !!c.querySelector('.bayesian-badge');
  return {
    unbadged: cards.filter(c => shown(c) && !badged(c) && ratedAsins.includes(c.dataset.asin)).map(c => c.dataset.asin),
    hiddenBadges: cards.filter(c => !shown(c) && badged(c)).length,
    unratedShown: cards.filter(c => shown(c) && !ratedAsins.includes(c.dataset.asin)).map(c => c.dataset.asin),
  };
}, rated.map(p => p.asin));

await page.locator('[data-action="reset"]').click();
check(await selectedBadges() === 0, 'clear left badges selected');
check(await page.locator('.bayesian-toolbar').isHidden(), 'clear left the toolbar showing');
check(await page.locator('.bayesian-panel').isHidden(), 'clear left the panel showing');
check(await page.evaluate(() => sessionStorage.getItem('bayesian-rating-selection')) === '[]', 'clear left a saved selection');

await context.close();

if (coverage.unbadged.length) problems.push(`visible rated cards without a badge: ${coverage.unbadged.join(', ')}`);
if (coverage.hiddenBadges) problems.push(`badges on hidden cards: ${coverage.hiddenBadges}`);
if (coverage.unratedShown.length) problems.push(`unrated cards still showing: ${coverage.unratedShown.join(', ')}`);

for (const r of report) console.log(`${r.asin}  ${r.text}${r.clipped.length ? `  [CLIPPED: ${r.clipped.join(', ')}]` : ''}`);
console.log(`\nbadges: ${report.length}/${expectedOn(0)} expected, clipped: ${report.filter(r => r.clipped.length).length}, select-page: ${selectPageMs}ms`);
console.log(logs.join('\n'));
console.log(`screenshots: ${outDir}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
