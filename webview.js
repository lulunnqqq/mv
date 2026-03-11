const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

(async () => {
  const downloadPath = path.resolve(__dirname, 'downloads');
  if (!fs.existsSync(downloadPath)) {
    fs.mkdirSync(downloadPath);
  }

  // SurfShark proxy config (from GitHub Actions secrets)
  const proxyHost = process.env.PROXY_HOST;
  const proxyUser = process.env.PROXY_USER;
  const proxyPass = process.env.PROXY_PASS;

  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  if (proxyHost) {
    launchArgs.push(`--proxy-server=https://${proxyHost}`);
    console.log(`[Proxy] Using proxy`);
  }

  const browser = await puppeteer.launch({
    headless: 'new', // Run headless, no browser window
    args: launchArgs,
    defaultViewport: { width: 1280, height: 800 },
  });

  const page = await browser.newPage();

  // Authenticate with proxy (equivalent to https-proxy-agent auth)
  if (proxyUser && proxyPass) {
    await page.authenticate({ username: proxyUser, password: proxyPass });
    console.log('[Proxy] Authenticated successfully.');
  }

  // Set up CDP session to handle downloads
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloadPath,
  });

  // === Step 1: Open webcrack link ===
  console.log('[Step 1] Opening webcrack page...');
  const timestampInSeconds = Date.now() / 1000;
  const url =
    `https://webcrack.netlify.app/?url=https://vidsrc.cc/saas/js/embed.min.js?t=${timestampInSeconds}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('[Step 1] Page opened successfully.');

  // === Step 2: Wait 5s for page to finish loading ===
  console.log('[Step 2] Waiting 5 seconds for page to finish loading...');
  await new Promise((r) => setTimeout(r, 5000));
  console.log('[Step 2] Done waiting.');

  // === Step 3: Press Alt+Enter to run deobfuscate ===
  console.log('[Step 3] Pressing Alt+Enter to run deobfuscate...');
  await page.keyboard.down('Alt');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Alt');
  console.log('[Step 3] Alt+Enter pressed.');

  // === Step 4: Wait 2s for processing ===
  console.log('[Step 4] Waiting 2 seconds for processing...');
  await new Promise((r) => setTimeout(r, 2000));
  console.log('[Step 4] Done waiting.');

  // === Step 5: Press Ctrl+S (macOS: Meta+S) to download code ===
  console.log('[Step 5] Pressing Ctrl+S / Cmd+S to save/download code...');

  // On macOS, browser uses Cmd+S (Meta+S) for Save
  // On web app (Monaco editor), Ctrl+S may also work
  // Try both methods:

  // macOS uses Meta (Cmd+S), Linux uses Control (Ctrl+S)
  const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modKey);
  await page.keyboard.press('s');
  await page.keyboard.up(modKey);

  // Wait for download to complete
  console.log('[Step 5] Waiting for download...');
  await new Promise((r) => setTimeout(r, 3000));

  // Check downloaded file
  const files = fs.readdirSync(downloadPath);
  if (files.length > 0) {
    const latestFile = files.sort((a, b) => {
      return (
        fs.statSync(path.join(downloadPath, b)).mtimeMs -
        fs.statSync(path.join(downloadPath, a)).mtimeMs
      );
    })[0];
    const filePath = path.join(downloadPath, latestFile);
    const content = fs.readFileSync(filePath, 'utf-8');
    console.log('\n=== FILE DOWNLOADED ===');
    console.log(`File: ${latestFile}`);
    console.log(`Size: ${content.length} bytes`);
    console.log('======================\n');

    // Save to output file
    const outputPath = path.join(__dirname, 'obfuscated.js');
    fs.writeFileSync(outputPath, content, 'utf-8');
    console.log(`Output saved to: ${outputPath}`);
  } else {
    console.log(
      '[Step 5] No downloaded file found via Ctrl+S/Cmd+S.'
    );
    console.log(
      '         Trying to extract content directly from output editor...'
    );

    // Fallback: Extract content from output panel on the web page
    const outputContent = await page.evaluate(() => {
      // Monaco editor stores content in model
      // Try to get from Monaco editor instance
      if (
        typeof window.monaco !== 'undefined' &&
        window.monaco.editor
      ) {
        const editors = window.monaco.editor.getEditors();
        if (editors.length >= 2) {
          // The 2nd editor is usually the output
          return editors[1].getValue();
        }
        if (editors.length === 1) {
          return editors[0].getValue();
        }
      }

      // Try to get from textarea or pre/code elements
      const outputEl =
        document.querySelector('.output-editor textarea') ||
        document.querySelector('[data-keybinding-context]') ||
        document.querySelector('.editor-container:last-child textarea');
      if (outputEl) return outputEl.value || outputEl.textContent;

      // Try all view-lines in Monaco
      const viewLines = document.querySelectorAll('.view-lines');
      if (viewLines.length >= 2) {
        return viewLines[1].textContent;
      }

      return null;
    });

    if (outputContent) {
      const outputPath = path.join(__dirname, 'obfuscated.js');
      fs.writeFileSync(outputPath, outputContent, 'utf-8');
      console.log(`\nExtracted and saved output to: ${outputPath}`);
      console.log(`Size: ${outputContent.length} bytes`);
    } else {
      console.log('\nCould not extract output content.');
      console.log(
        'May need to wait longer or the page has a different structure.'
      );
    }
  }

  // Close browser
  await browser.close();
  console.log('\nDone!');
})();
