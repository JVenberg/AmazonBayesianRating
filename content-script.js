// ==============================================================
// Amazon Bayesian Rating Comparator — Content Script
//
// Scrapes search results, fetches rating widgets, runs Bayesian
// comparison, injects interactive badges with click-to-toggle
// subset selection and live recalculation.
// ==============================================================

(async function () {
  "use strict";

  // ─── State ────────────────────────────────────────────────

  /** @type {Map<string, {asin: string, name: string, image: string, price: string, total: number, pcts: number[], element: HTMLElement|null}>} */
  const productMap = new Map();

  /** @type {Set<string>} ASINs currently selected for comparison */
  const selectedAsins = new Set();

  /** @type {Set<string>} ASINs already requested, so failed popovers are never retried */
  const requestedAsins = new Set();

  /** Whether user has manually toggled anything */
  let subsetMode = false;

  /** Latest comparison of the selected products, in rank order */
  let lastResults = new Map();

  let settings = DEFAULT_SETTINGS;

  const STORAGE_KEY = "bayesian-rating-selection";

  // ─── RNG / Bayesian Core ──────────────────────────────────

  function randn() {
    return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
  }

  function sampleGamma(shape) {
    if (shape < 1) return sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do { x = randn(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function sampleDirichlet(alphas) {
    const g = alphas.map(a => sampleGamma(a));
    const s = g.reduce((a, b) => a + b, 0);
    return g.map(x => x / s);
  }

  const N_SAMPLES = 20_000;

  // Chances under 0.1% are Monte Carlo noise, so those order by mean instead.
  const chance = r => (r.p_best < 0.001 ? 0 : r.p_best);

  const RANKINGS = {
    mean: (a, b) => b.mean - a.mean || b.p_best - a.p_best,
    lowEnd: (a, b) => b.ci_low - a.ci_low || b.mean - a.mean,
    chance: (a, b) => chance(b) - chance(a) || b.mean - a.mean,
  };

  function posteriorSamples(counts, prior) {
    const alphas = counts.map((c, i) => c + prior[i]);
    const samples = new Float64Array(N_SAMPLES);
    for (let s = 0; s < N_SAMPLES; s++) {
      const p = sampleDirichlet(alphas);
      samples[s] = p[0] * 1 + p[1] * 2 + p[2] * 3 + p[3] * 4 + p[4] * 5;
    }
    return samples;
  }

  function pctl(sorted, p) {
    return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
  }

  function compareAsins(asins) {
    const products = asins.map(a => productMap.get(a)).filter(Boolean);
    if (products.length < 2) return new Map();

    const prior = priorAlphas(settings);
    const allSamples = products.map(prod => ({
      asin: prod.asin,
      samples: posteriorSamples(trustedCounts(prod.total, prod.pcts, settings), prior),
    }));
    const tail = (1 - settings.intervalPct / 100) / 2;

    const n = N_SAMPLES;
    const bestCounts = new Array(products.length).fill(0);
    for (let s = 0; s < n; s++) {
      let bestIdx = 0, bestVal = -Infinity;
      for (let i = 0; i < allSamples.length; i++) {
        if (allSamples[i].samples[s] > bestVal) {
          bestVal = allSamples[i].samples[s];
          bestIdx = i;
        }
      }
      bestCounts[bestIdx]++;
    }

    const results = allSamples.map((item, i) => {
      const sorted = Array.from(item.samples).sort((a, b) => a - b);
      const mean = sorted.reduce((s, v) => s + v, 0) / n;
      const ci_low = pctl(sorted, tail);
      const ci_high = pctl(sorted, 1 - tail);
      return {
        asin: item.asin,
        mean: +mean.toFixed(3),
        ci_low: +ci_low.toFixed(3),
        ci_high: +ci_high.toFixed(3),
        p_best: +(bestCounts[i] / n).toFixed(4),
      };
    }).sort(RANKINGS[settings.rankBy])
      .map((r, i) => ({ ...r, rank: i + 1 }));

    return new Map(results.map(r => [r.asin, r]));
  }

  // ─── Amazon Scraping ──────────────────────────────────────

  function findProductCards() {
    const cards = document.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
    const products = [];
    for (const card of cards) {
      const asin = card.getAttribute("data-asin");
      if (!asin || asin.length < 5) continue;
      // Ad blockers hide sponsored cards, which can share an ASIN with a visible result.
      if (card.offsetWidth === 0) continue;
      const titleEl = card.querySelector("h2 span");
      const name = titleEl ? titleEl.textContent.trim().slice(0, 80) : asin;
      const image = card.querySelector("img.s-image")?.src ?? "";
      const price = card.querySelector(".a-price .a-offscreen")?.textContent.trim() ?? "";
      products.push({ asin, name, image, price, element: card });
    }
    return products;
  }

  function isUnrated(card) {
    return !card.querySelector('[data-cy="reviews-block"], [class*="a-icon-star"], [aria-label*="out of 5"]');
  }

  async function fetchRatingData(asin) {
    const url = `/review/widgets/average-customer-review/popover/ref=acr_search__popover?ie=UTF8&asin=${asin}&ref=acr_search__popover&contextId=search`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const html = await response.text();

    const totalMatch = html.match(/data-hook="total-review-count"[^>]*>([\d,]+)\s/);
    if (!totalMatch) return null;
    const total = parseInt(totalMatch[1].replace(/,/g, ""), 10);
    if (total === 0) return null;

    const starRegex = /aria-label="(\d)\s+stars?\s+represent\s+(\d+)%\s+of\s+rating"/g;
    const starMap = {};
    let match;
    while ((match = starRegex.exec(html)) !== null) {
      starMap[parseInt(match[1], 10)] = parseInt(match[2], 10);
    }
    for (let i = 1; i <= 5; i++) {
      if (starMap[i] === undefined) return null;
    }

    return { total, pcts: [starMap[1], starMap[2], starMap[3], starMap[4], starMap[5]] };
  }

  // ─── UI: Styles ───────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById("bayesian-rating-styles")) return;
    const style = document.createElement("style");
    style.id = "bayesian-rating-styles";
    style.textContent = `
      .bayesian-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 6px;
        padding: 7px 10px;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 12px;
        line-height: 1.4;
        border: 2px solid;
        cursor: pointer;
        user-select: none;
        transition: opacity 0.2s, border-color 0.2s, transform 0.1s;
      }
      .bayesian-badge:hover {
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      }
      .bayesian-badge:active { transform: translateY(0); }

      .bayesian-badge[data-selected="false"] {
        opacity: 0.35;
        border-style: dashed;
      }

      .bayesian-badge--best    { background:#e6f4ea; border-color:#34a853; color:#1e7e34; }
      .bayesian-badge--good    { background:#fef7e0; border-color:#f9ab00; color:#b06d00; }
      .bayesian-badge--neutral { background:#f1f3f4; border-color:#dadce0; color:#5f6368; }
      .bayesian-badge--poor    { background:#fce8e6; border-color:#ea4335; color:#c5221f; }
      .bayesian-badge--pending { background:#f8f9fa; border-color:#dadce0; color:#80868b; border-style:dashed; }

      .bayesian-checkbox {
        width: 16px; height: 16px;
        border-radius: 3px;
        border: 2px solid currentColor;
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 10px; opacity: 0.6;
      }
      .bayesian-badge[data-selected="true"] .bayesian-checkbox {
        opacity: 1; background: currentColor;
      }
      .bayesian-badge[data-selected="true"] .bayesian-checkbox::after {
        content: "✓"; color: white; font-weight: 700;
      }

      .bayesian-rank { font-weight:700; font-size:15px; min-width:22px; text-align:center; flex-shrink:0; }
      .bayesian-details { display:flex; flex-direction:column; gap:1px; flex:1; min-width:0; }
      .bayesian-main { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .bayesian-ci { font-size:11px; opacity:0.8; white-space:nowrap; }
      .bayesian-bar-container { width:50px; height:6px; background:rgba(0,0,0,0.08); border-radius:3px; overflow:hidden; flex-shrink:0; }
      .bayesian-bar { height:100%; border-radius:3px; }

      .bayesian-toolbar {
        position: fixed; bottom: 20px; right: 20px; z-index: 10000;
        background: white; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
        padding: 12px 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        display: flex; align-items: center; gap: 12px;
      }
      .bayesian-toolbar-count { font-weight:600; color:#1a73e8; }
      .bayesian-toolbar-btn {
        padding: 6px 14px; border-radius: 6px; border: none;
        cursor: pointer; font-size: 12px; font-weight: 600;
      }
      .bayesian-toolbar-btn--primary { background:#1a73e8; color:white; }
      .bayesian-toolbar-btn--primary:hover { background:#1557b0; }
      .bayesian-toolbar-btn--secondary { background:#f1f3f4; color:#5f6368; }
      .bayesian-toolbar-btn--secondary:hover { background:#e8eaed; }
      .bayesian-toolbar-btn:disabled { opacity:0.45; cursor:default; }

      .bayesian-unrated { display:none !important; }

      .bayesian-panel {
        position: fixed; bottom: 84px; right: 20px; z-index: 10000;
        width: min(440px, calc(100vw - 40px));
        max-height: calc(100vh - 124px);
        display: flex; flex-direction: column;
        background: white; border-radius: 12px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px; line-height: 1.4; color: #202124;
      }
      .bayesian-panel[hidden] { display:none; }
      .bayesian-panel-header {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        padding: 14px 16px 10px; border-bottom: 1px solid #e8eaed;
      }
      .bayesian-panel-title { font-size:15px; font-weight:700; }
      .bayesian-panel-note { margin-top:2px; font-size:11px; color:#5f6368; }
      .bayesian-panel-settings {
        margin-left: auto; padding: 3px 8px; flex-shrink: 0;
        border: none; border-radius: 6px; background: none;
        color: #1a73e8; font-size: 12px; font-weight: 600; cursor: pointer;
      }
      .bayesian-panel-settings:hover { background:#f1f3f4; }
      .bayesian-panel-close, .bayesian-rank-remove {
        width: 24px; height: 24px; padding: 0; flex-shrink: 0;
        border: none; border-radius: 6px; background: none;
        color: #5f6368; font-size: 16px; line-height: 1; cursor: pointer;
      }
      .bayesian-panel-close:hover, .bayesian-rank-remove:hover { background:#f1f3f4; color:#202124; }
      .bayesian-panel-list { list-style:none; margin:0; padding:0; overflow-y:auto; }

      .bayesian-rank-row {
        display: grid; grid-template-columns: 24px 56px minmax(0, 1fr) 24px; gap: 10px;
        align-items: start; margin: 0; padding: 10px 16px;
        border-bottom: 1px solid #f1f3f4;
      }
      .bayesian-rank-row:last-child { border-bottom:none; }
      .bayesian-rank-num {
        width: 24px; height: 24px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: #f1f3f4; color: #5f6368; font-size: 12px; font-weight: 700;
      }
      .bayesian-rank-img { width:56px; height:56px; object-fit:contain; border-radius:4px; }
      .bayesian-rank-name {
        display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
        color: #202124; font-weight: 600; text-decoration: none;
      }
      .bayesian-rank-name:hover { color:#1a73e8; }
      .bayesian-rank-meta { margin-top:2px; font-size:12px; color:#5f6368; }
      .bayesian-rank-stats { display:flex; justify-content:space-between; gap:8px; margin-top:4px; font-size:12px; }
      .bayesian-rank-chance { font-weight:600; }
      .bayesian-rank-interval { color:#5f6368; white-space:nowrap; }
      .bayesian-rank-track { position:relative; height:6px; margin-top:6px; border-radius:3px; background:#f1f3f4; }
      .bayesian-rank-range { position:absolute; top:0; bottom:0; min-width:3px; border-radius:3px; background:#8ab4f8; }
      .bayesian-rank-mean { position:absolute; top:-2px; width:2px; height:10px; margin-left:-1px; background:#1a73e8; }

      .bayesian-rank-row--best .bayesian-rank-num { background:#e6f4ea; color:#1e7e34; }
      .bayesian-rank-row--best .bayesian-rank-range { background:#a8dab5; }
      .bayesian-rank-row--best .bayesian-rank-mean { background:#1e7e34; }
    `;
    document.head.appendChild(style);
  }

  // ─── UI: Toolbar ──────────────────────────────────────────

  let toolbar = null;

  function createToolbar() {
    toolbar = document.createElement("div");
    toolbar.className = "bayesian-toolbar";
    toolbar.style.display = "none";
    toolbar.innerHTML = `
      <span><span class="bayesian-toolbar-count">0</span> selected</span>
      <button class="bayesian-toolbar-btn bayesian-toolbar-btn--primary" data-action="rank">View ranking</button>
      <button class="bayesian-toolbar-btn bayesian-toolbar-btn--secondary" data-action="select-page">Select page</button>
      <button class="bayesian-toolbar-btn bayesian-toolbar-btn--secondary" data-action="reset">Clear</button>
    `;
    document.body.appendChild(toolbar);
    toolbar.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "reset") resetSelection();
      else if (action === "select-page") selectPage();
      else if (action === "rank") togglePanel();
    });
  }

  function updateToolbar() {
    if (!toolbar) return;
    toolbar.querySelector(".bayesian-toolbar-count").textContent = selectedAsins.size;
    const rankButton = toolbar.querySelector('[data-action="rank"]');
    rankButton.disabled = lastResults.size < 2;
    rankButton.textContent = panelOpen ? "Hide ranking" : "View ranking";
    toolbar.style.display = subsetMode ? "flex" : "none";
  }

  // ─── UI: Ranking Panel ────────────────────────────────────

  let rankPanel = null;
  let panelOpen = false;

  function createRankPanel() {
    rankPanel = document.createElement("section");
    rankPanel.className = "bayesian-panel";
    rankPanel.hidden = true;
    rankPanel.innerHTML = `
      <div class="bayesian-panel-header">
        <div>
          <div class="bayesian-panel-title"></div>
          <div class="bayesian-panel-note"></div>
        </div>
        <button class="bayesian-panel-settings" data-action="settings">Settings</button>
        <button class="bayesian-panel-close" data-action="close" aria-label="Close ranking">×</button>
      </div>
      <ol class="bayesian-panel-list"></ol>
    `;
    document.body.appendChild(rankPanel);
    rankPanel.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (action === "close") togglePanel();
      else if (action === "settings") chrome.runtime.sendMessage("open-settings");
      else if (action === "remove") toggleProduct(e.target.closest("[data-asin]").dataset.asin);
    });
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    renderRankPanel();
    updateToolbar();
  }

  function panelNote() {
    const { rankBy, fakeFiveStars, intervalPct } = settings;
    const order = {
      mean: "expected rating",
      lowEnd: "the low end of the likely range",
      chance: "chance of being the best",
    }[rankBy];
    const fakes = fakeFiveStars ? `, assuming ${fakeFiveStars} five-star ratings per product are fake` : "";
    return `Ordered by ${order}${fakes}. Bars show the ${intervalPct}% likely range.`;
  }

  function renderRankPanel() {
    rankPanel.hidden = !panelOpen;
    if (!panelOpen) return;

    const results = [...lastResults.values()];
    const scaleLow = Math.min(...results.map(r => r.ci_low));
    const scaleSpan = Math.max(...results.map(r => r.ci_high)) - scaleLow || 1;

    rankPanel.querySelector(".bayesian-panel-title").textContent = `Ranking ${results.length} products`;
    rankPanel.querySelector(".bayesian-panel-note").textContent = panelNote();
    rankPanel.querySelector(".bayesian-panel-list").replaceChildren(
      ...results.map(r => createRankRow(r, scaleLow, scaleSpan))
    );
  }

  function createRankRow(result, scaleLow, scaleSpan) {
    const prod = productMap.get(result.asin);
    const toScale = value => `${((value - scaleLow) / scaleSpan) * 100}%`;

    const row = document.createElement("li");
    row.className = `bayesian-rank-row${result.rank === 1 ? " bayesian-rank-row--best" : ""}`;
    row.dataset.asin = result.asin;
    row.dataset.mean = result.mean;
    row.dataset.pBest = result.p_best;
    row.dataset.ciLow = result.ci_low;
    row.dataset.ciHigh = result.ci_high;
    row.innerHTML = `
      <span class="bayesian-rank-num"></span>
      <img class="bayesian-rank-img" alt="">
      <div>
        <a class="bayesian-rank-name" target="_blank" rel="noopener"></a>
        <div class="bayesian-rank-meta"></div>
        <div class="bayesian-rank-stats">
          <span class="bayesian-rank-chance"></span>
          <span class="bayesian-rank-interval"></span>
        </div>
        <div class="bayesian-rank-track">
          <div class="bayesian-rank-range"></div>
          <div class="bayesian-rank-mean"></div>
        </div>
      </div>
      <button class="bayesian-rank-remove" data-action="remove" aria-label="Remove from comparison">×</button>
    `;

    row.querySelector(".bayesian-rank-num").textContent = result.rank;
    row.querySelector(".bayesian-rank-img").src = prod.image;
    const link = row.querySelector(".bayesian-rank-name");
    link.href = `/dp/${result.asin}`;
    link.textContent = prod.name;
    row.querySelector(".bayesian-rank-meta").textContent =
      [prod.price, `${prod.total.toLocaleString()} ratings`].filter(Boolean).join(" · ");
    row.querySelector(".bayesian-rank-chance").textContent = `${formatChance(result.p_best)} chance best`;
    row.querySelector(".bayesian-rank-interval").textContent = formatInterval(result);

    const range = row.querySelector(".bayesian-rank-range");
    range.style.left = toScale(result.ci_low);
    range.style.width = `${((result.ci_high - result.ci_low) / scaleSpan) * 100}%`;
    row.querySelector(".bayesian-rank-mean").style.left = toScale(result.mean);
    return row;
  }

  // ─── UI: Badge Rendering ──────────────────────────────────

  function getBadgeEl(asin) {
    return document.querySelector(`.bayesian-badge[data-asin="${asin}"]`);
  }

  function formatChance(pBest) {
    const pct = pBest * 100;
    return pct >= 1 ? pct.toFixed(0) + "%" : pct < 0.1 ? "<0.1%" : pct.toFixed(1) + "%";
  }

  function formatInterval(result) {
    return `${result.mean.toFixed(2)} ★  [${result.ci_low.toFixed(2)} – ${result.ci_high.toFixed(2)}]`;
  }

  function renderBadge(asin) {
    const prod = productMap.get(asin);
    if (!prod?.element?.isConnected) return;

    let badge = getBadgeEl(asin);
    if (badge) return badge;

    badge = document.createElement("div");
    badge.className = "bayesian-badge bayesian-badge--pending";
    badge.setAttribute("data-asin", asin);
    badge.setAttribute("data-selected", "false");

    // ★ Store all raw data on the element
    badge.setAttribute("data-total", prod.total);
    badge.setAttribute("data-pct-1", prod.pcts[0]);
    badge.setAttribute("data-pct-2", prod.pcts[1]);
    badge.setAttribute("data-pct-3", prod.pcts[2]);
    badge.setAttribute("data-pct-4", prod.pcts[3]);
    badge.setAttribute("data-pct-5", prod.pcts[4]);
    badge.setAttribute("data-name", prod.name);

    // Compute individual Bayesian mean for the unselected summary line
    const counts = prod.pcts.map(p => Math.round((p / 100) * prod.total));
    const rawMean = counts.reduce((s, c, i) => s + c * (i + 1), 0) / counts.reduce((s, c) => s + c, 0);

    badge.innerHTML = `
      <div class="bayesian-checkbox"></div>
      <span class="bayesian-rank">＋</span>
      <div class="bayesian-details">
        <span class="bayesian-main">Click to compare</span>
        <span class="bayesian-ci">${prod.total.toLocaleString()} ratings — ${rawMean.toFixed(2)} ★ avg — ${prod.pcts[4]}% five-star</span>
      </div>
      <div class="bayesian-bar-container">
        <div class="bayesian-bar" style="width:0%;background:currentColor;"></div>
      </div>
    `;

    badge.addEventListener("click", () => toggleProduct(asin));

    const reviewsBlock = prod.element.querySelector('[data-cy="reviews-block"]');
    if (reviewsBlock) {
      reviewsBlock.parentNode.insertBefore(badge, reviewsBlock.nextSibling);
    } else {
      (prod.element.querySelector(".sg-col-inner") || prod.element).prepend(badge);
    }
    return badge;
  }

  function updateBadgeResult(asin, result, totalCompared) {
    const badge = getBadgeEl(asin);
    if (!badge) return;

    // ★ Store computed results as data attributes
    badge.setAttribute("data-mean", result.mean);
    badge.setAttribute("data-ci-low", result.ci_low);
    badge.setAttribute("data-ci-high", result.ci_high);
    badge.setAttribute("data-p-best", result.p_best);
    badge.setAttribute("data-rank", result.rank);
    badge.setAttribute("data-compared-with", totalCompared);

    let badgeClass, emoji;
    if (result.rank === 1)        { badgeClass = "bayesian-badge--best";    emoji = "🏆"; }
    else if (result.p_best > 0.1) { badgeClass = "bayesian-badge--good";    emoji = "✓"; }
    else if (result.p_best > 0.01){ badgeClass = "bayesian-badge--neutral";  emoji = "—"; }
    else                          { badgeClass = "bayesian-badge--poor";     emoji = "↓"; }

    badge.className = `bayesian-badge ${badgeClass}`;
    badge.setAttribute("data-selected", "true");

    badge.querySelector(".bayesian-rank").textContent = emoji;
    badge.querySelector(".bayesian-main").textContent = `#${result.rank}/${totalCompared} — ${formatChance(result.p_best)} chance best`;
    badge.querySelector(".bayesian-ci").textContent = `Bayesian: ${formatInterval(result)}`;
    badge.querySelector(".bayesian-bar").style.width = `${Math.min(result.p_best * 100, 100)}%`;

    badge.title = `${productMap.get(asin)?.name}\nBayesian mean: ${result.mean.toFixed(3)}\n${settings.intervalPct}% CI: [${result.ci_low.toFixed(3)}, ${result.ci_high.toFixed(3)}]\nP(best): ${(result.p_best * 100).toFixed(2)}%\nRank: ${result.rank} of ${totalCompared}\n\nClick to toggle selection`;
  }

  function markBadgeExcluded(asin) {
    const badge = getBadgeEl(asin);
    if (!badge) return;
    badge.setAttribute("data-selected", "false");
    badge.className = "bayesian-badge bayesian-badge--pending";
    badge.querySelector(".bayesian-rank").textContent = "＋";
    badge.querySelector(".bayesian-main").textContent = "Click to compare";

    // Show raw stats summary
    const prod = productMap.get(asin);
    if (prod) {
      const counts = prod.pcts.map(p => Math.round((p / 100) * prod.total));
      const rawMean = counts.reduce((s, c, i) => s + c * (i + 1), 0) / counts.reduce((s, c) => s + c, 0);
      badge.querySelector(".bayesian-ci").textContent =
        `${prod.total.toLocaleString()} ratings — ${rawMean.toFixed(2)} ★ avg — ${prod.pcts[4]}% five-star`;
    } else {
      badge.querySelector(".bayesian-ci").textContent = "";
    }

    badge.querySelector(".bayesian-bar").style.width = "0%";

    // Clear computed (but keep raw data-pct-* and data-total)
    for (const attr of ["data-mean", "data-ci-low", "data-ci-high", "data-p-best", "data-rank", "data-compared-with"]) {
      badge.removeAttribute(attr);
    }
  }

  // ─── Selection Logic ──────────────────────────────────────

  function toggleProduct(asin) {
    if (selectedAsins.has(asin)) {
      selectedAsins.delete(asin);
    } else {
      selectedAsins.add(asin);
    }
    subsetMode = selectedAsins.size > 0;
    recalculate();
  }

  function resetSelection() {
    subsetMode = false;
    selectedAsins.clear();
    recalculate();
  }

  function selectPage() {
    for (const { asin } of findProductCards()) {
      if (productMap.has(asin)) selectedAsins.add(asin);
    }
    recalculate();
  }

  function paintBadge(asin) {
    if (!selectedAsins.has(asin)) {
      markBadgeExcluded(asin);
      return;
    }

    const result = lastResults.get(asin);
    if (result) {
      updateBadgeResult(asin, result, lastResults.size);
      return;
    }

    const badge = getBadgeEl(asin);
    const prod = productMap.get(asin);
    if (badge && prod) {
      badge.className = "bayesian-badge bayesian-badge--neutral";
      badge.setAttribute("data-selected", "true");
      badge.querySelector(".bayesian-rank").textContent = "①";
      badge.querySelector(".bayesian-main").textContent = "Select more to compare";
      badge.querySelector(".bayesian-ci").textContent = `${prod.total.toLocaleString()} ratings — ${prod.pcts[4]}% five-star`;
      badge.querySelector(".bayesian-bar").style.width = "0%";
    }
  }

  function recalculate() {
    lastResults = compareAsins([...selectedAsins]);
    if (lastResults.size < 2) panelOpen = false;

    for (const asin of productMap.keys()) paintBadge(asin);
    renderRankPanel();
    updateToolbar();
    saveSelection();
  }

  // ─── Persistence ──────────────────────────────────────────

  function saveSelection() {
    const selection = [...selectedAsins].map(asin => {
      const { element, ...saved } = productMap.get(asin);
      return saved;
    });
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
    } catch (e) {
      console.warn("[Bayesian Ratings] Could not save selection", e);
    }
  }

  function restoreSelection() {
    let selection = [];
    try {
      selection = JSON.parse(sessionStorage.getItem(STORAGE_KEY)) ?? [];
    } catch (e) {
      console.warn("[Bayesian Ratings] Could not restore selection", e);
    }
    for (const saved of selection) {
      productMap.set(saved.asin, { ...saved, element: null });
      selectedAsins.add(saved.asin);
    }
    subsetMode = selectedAsins.size > 0;
  }

  // ─── Main ─────────────────────────────────────────────────

  async function loadRatings(cards) {
    const BATCH = 4;
    for (let i = 0; i < cards.length; i += BATCH) {
      await Promise.all(cards.slice(i, i + BATCH).map(async (card) => {
        if (!card.element.isConnected) {
          requestedAsins.delete(card.asin);
          return;
        }
        try {
          const data = await fetchRatingData(card.asin);
          if (data) {
            productMap.set(card.asin, { ...card, ...data });
            renderBadge(card.asin);
          }
        } catch (e) {
          console.warn(`[Bayesian Ratings] Failed: ${card.asin}`, e);
        }
      }));
    }
    scan();
  }

  function scan() {
    const fresh = [];
    for (const card of findProductCards()) {
      if (isUnrated(card.element)) {
        card.element.classList.add("bayesian-unrated");
        continue;
      }

      const known = productMap.get(card.asin);
      if (!known && !requestedAsins.has(card.asin)) {
        requestedAsins.add(card.asin);
        fresh.push(card);
      } else if (known && !getBadgeEl(card.asin)) {
        Object.assign(known, card);
        renderBadge(card.asin);
        paintBadge(card.asin);
      }
    }
    if (fresh.length) loadRatings(fresh);
  }

  // Amazon paginates and re-renders results in place, without a new page load.
  function watchResults() {
    let timer = null;
    new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        scan();
      }, 300);
    }).observe(document.body, { childList: true, subtree: true });
  }

  async function run() {
    settings = await loadSettings();
    injectStyles();
    createToolbar();
    createRankPanel();
    restoreSelection();
    recalculate();
    scan();
    watchResults();
    chrome.storage.onChanged.addListener(async () => {
      settings = await loadSettings();
      recalculate();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
