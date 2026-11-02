// Shared by the content script and the settings page.

const DEFAULT_SETTINGS = {
  fakeFiveStars: 20,
  priorMean: 3,
  priorStrength: 5,
  intervalPct: 95,
  rankBy: "mean",
};

function loadSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

function trustedCounts(total, pcts, { fakeFiveStars }) {
  const counts = pcts.map(p => Math.round((p / 100) * total));
  counts[4] = Math.max(0, counts[4] - fakeFiveStars);
  return counts;
}

// Flattest star shares that average priorMean, scaled to priorStrength imaginary ratings.
function priorAlphas({ priorMean, priorStrength }) {
  const sharesFor = tilt => {
    const weights = [1, 2, 3, 4, 5].map(star => Math.exp(tilt * star));
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map(w => w / sum);
  };
  const meanOf = shares => shares.reduce((sum, share, i) => sum + share * (i + 1), 0);

  let low = -10, high = 10;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (meanOf(sharesFor(mid)) < priorMean) low = mid;
    else high = mid;
  }
  return sharesFor(low).map(share => share * priorStrength);
}
