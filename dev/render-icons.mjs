import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = fs.readFileSync(path.join(extDir, 'icon.svg'), 'utf8');

const browser = await chromium.launch({ channel: 'chromium' });
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html, body { margin: 0; background: transparent; } svg { display: block; width: ${size}px; height: ${size}px; }</style>${svg}`);
  await page.screenshot({ path: path.join(extDir, `icon${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
