<img src="icon128.png" alt="" width="64" height="64">

# Bayesian Rating Comparator

A Chrome extension that ranks Amazon search results by how good each product probably is, not just its star average.

A 4.9 from 12 ratings and a 4.6 from 8,000 ratings aren't equally trustworthy. This extension treats each product's ratings as evidence, works out a likely range for its true rating, and ranks the products you pick. Listings with only a few ratings, or that are padded with fake five-star reviews, stop floating to the top.

## Install

The extension isn't in the Chrome Web Store, so you load it from source:

1. Clone or download this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the repository folder.

After you pull new changes, click the reload icon on the extension in `chrome://extensions`, then refresh any open Amazon tabs.

## Use

1. Search on Amazon. Each result with ratings gets a badge showing its rating count, average and share of five-star ratings.
2. Click badges to select the products you want to compare. Click again to deselect.
3. Click **View ranking** in the toolbar at the bottom right. The ranking needs at least two products.

The ranking panel lists the products in order, with each product's expected rating, its likely range drawn as a bar, and its chance of being the best of the group. The panel updates as you select or remove products, and **×** removes a product.

The toolbar also has **Select page**, which adds every rated result on the current page, and **Clear**, which empties the selection.

Your selection stays as you change pages, reload or start new searches, until you click **Clear** or close the tab. Each tab keeps its own selection.

Results with no ratings are hidden.

## Settings

Open settings from the **Settings** button in the ranking panel, or by clicking the extension's toolbar icon. Changes apply right away, including on Amazon tabs that are already open, and sync across your devices if Chrome sync is on.

| Setting | Default | What it does |
|---|---|---|
| Fake five-star ratings per product | 20 | Removed from every product before scoring. A small listing can lose most of its score, while a big one barely moves. |
| Starting rating | 3.0 | What a product is assumed to score before its ratings count. Raising it is kinder to new listings. |
| Starting rating weight | 5 | How many imaginary ratings the starting rating is worth. Higher means a product needs more real ratings to move away from it. |
| Likely range | 95% | How sure the range around each rating should be. Surer ranges are wider. |
| Rank products by | Expected rating | Can also rank by the low end of the likely range, which favors products with many ratings, or by chance of being the best, which favors long shots. |

The settings page also shows how your settings change the score of three example products.

## How it works

For each product, the extension reads Amazon's rating breakdown, the share of 1 to 5 star ratings, and turns it back into a count for each star level. It then:

1. Removes the fake five-star allowance from the five-star count.
2. Adds imaginary ratings for the starting rating, spread across the star levels as evenly as possible while averaging the starting rating.
3. Treats the result as a Dirichlet distribution over how the product's buyers rate it, and draws 20,000 samples from it. Each sample's average star rating is one plausible true rating.

From those samples, the **expected rating** is the average, the **likely range** is the middle 95% (or whatever you set), and the **chance of being best** is the share of samples in which that product scores highest of the ones you selected.

## Assumptions and limitations

- Stars are evenly spaced, so going from 1 to 2 stars counts as much as going from 4 to 5.
- Fake ratings are always five-star, and every product gets the same allowance.
- Apart from that, ratings are independent and honest. The tendency of very happy or very unhappy buyers to rate more often isn't modeled.
- Every product starts from the same rating, whatever its category.
- Rating counts are rebuilt from Amazon's rounded percentages, so they're approximate.
- Only amazon.com has been tested. Rating text is read in English, so the German, French and Japanese sites probably won't work.
- The extension depends on the structure of Amazon's pages and will break when Amazon changes it.
- With an ad blocker off, a product that also appears as a sponsored result gets only one badge.

## Privacy and Amazon's terms

The extension talks only to Amazon. Its sole network requests are one request per rated result to Amazon's own rating popup, made from the page you're on. It has no analytics. Your settings are stored in Chrome's synced storage, and your selection in the tab's session storage.

Those background requests are a form of automated data gathering, which Amazon's Conditions of Use restrict, and enough of them could trigger Amazon's limits on automated traffic. Use it at your own risk. This project isn't affiliated with Amazon.

## Development

The dev tools in `dev/` use Playwright to load the real extension against a mocked Amazon search page, so no requests reach Amazon.

```sh
cd dev
npm install
npx playwright install chromium
npm run preview
```

`npm run preview` runs the whole flow and exits with an error if any check fails: badges, selection, the ranking, page switching, reloads and settings. It saves screenshots to `dev/out/`. Run `node preview.mjs --headed` to watch it.

The icons are drawn in `icon.svg`. After editing it, run `node render-icons.mjs` from `dev/` to regenerate the PNGs.

## License

MIT. See [LICENSE](LICENSE).
