import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const artifactsDir = 'C:/Users/Usuario/.gemini/antigravity/brain/b130443a-5f01-42aa-8878-4a68d8815862';

const viewports = [
  { name: 'phone-small-landscape', width: 740, height: 360 },
  { name: 'phone-large-landscape', width: 930, height: 430 },
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow-window', width: 480, height: 900 },
];

async function main() {
  const browser = await chromium.launch();

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: 'dark',
    });
    const page = await context.newPage();

    const htmlPath = path.join(projectRoot, 'static/phone-v3/index.html');
    await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`);

    // Navigate to the Video page
    await page.evaluate(() => {
      document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
      const videoPage = document.querySelector('.page-video');
      if (videoPage) videoPage.classList.remove('hidden');
      document.body.style.background = '#0a0a0c';
    });

    await page.waitForTimeout(300);

    const screenshotPath = path.join(artifactsDir, `vision-${vp.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`OK ${vp.name} (${vp.width}x${vp.height})`);

    await context.close();
  }

  await browser.close();
  console.log('All screenshots saved.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
