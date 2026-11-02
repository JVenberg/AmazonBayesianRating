const inputs = Object.keys(DEFAULT_SETTINGS).map(id => document.getElementById(id));

const EXAMPLES = [
  { total: 20, pcts: [0, 0, 0, 0, 100] },
  { total: 200, pcts: [3, 2, 5, 15, 75] },
  { total: 2000, pcts: [5, 5, 8, 20, 62] },
];

const OUTPUT_FORMATS = {
  priorMean: value => `${value.toFixed(1)} ★`,
};

function valueOf(input) {
  return typeof DEFAULT_SETTINGS[input.id] === "number" ? Number(input.value) : input.value;
}

function currentSettings() {
  return Object.fromEntries(inputs.map(input => [input.id, valueOf(input)]));
}

function averageOf(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.reduce((total, weight, i) => total + weight * (i + 1), 0) / sum;
}

function exampleRow({ total, pcts }, settings) {
  const prior = priorAlphas(settings);
  const posterior = trustedCounts(total, pcts, settings).map((count, i) => count + prior[i]);

  const row = document.createElement("tr");
  const cells = [`${total.toLocaleString()} ratings`, averageOf(pcts).toFixed(2), averageOf(posterior).toFixed(2)];
  row.append(...cells.map(text => {
    const cell = document.createElement("td");
    cell.textContent = text;
    return cell;
  }));
  return row;
}

function render() {
  const settings = currentSettings();
  for (const input of inputs) {
    const output = document.querySelector(`output[for="${input.id}"]`);
    if (output) output.textContent = (OUTPUT_FORMATS[input.id] ?? String)(valueOf(input));
  }
  document.getElementById("examples").replaceChildren(...EXAMPLES.map(e => exampleRow(e, settings)));
}

function fill(settings) {
  for (const input of inputs) input.value = settings[input.id];
  render();
}

for (const input of inputs) {
  input.addEventListener("input", render);
  // Range inputs fire change on release, which keeps writes under the sync rate limit.
  input.addEventListener("change", () => chrome.storage.sync.set({ [input.id]: valueOf(input) }));
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.sync.clear();
  fill(DEFAULT_SETTINGS);
});

loadSettings().then(fill);
