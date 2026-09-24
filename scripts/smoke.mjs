// Smoke test of the built extension in a real Chromium (Playwright's bundled
// build; branded Chrome ignores --load-extension). Run `npm run build` first.
//
// The browser toolbar, context menu and keyboard commands cannot be driven
// from Playwright, and optional permissions cannot be granted without a user
// prompt, so the test copies dist/ to dist-e2e/ and turns the optional
// http/https host permissions into granted ones — standing in for the
// activeTab grant a real click gives, and for the user accepting the
// "restore automatically" prompt — then drives the extension through the same
// messages the popup and side panel send. The page under test ships hostile CSS.
//
// Usage: node scripts/smoke.mjs [--headed]
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PORT = 4322;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const testDist = join(root, 'dist-e2e');
const headed = process.argv.includes('--headed');
const shotsDir = join(root, 'test-results');

const HOSTILE_CSS = `
  html { font-size: 10px; }
  * { color: rgb(255, 0, 0) !important; font-family: serif !important; line-height: 3 !important; }
  div, span, p { border: 3px solid rgb(0, 255, 0) !important; }
  button { background: black !important; font-size: 30px !important; padding: 20px !important; }
  body { margin: 40px; }
`;

let variant = 1;
function article() {
  const p2 =
    variant === 1
      ? 'Highlights are stored with context so they reappear after a reload.'
      : 'This paragraph was rewritten completely by the author.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Smoke article</title>
<style>${HOSTILE_CSS}</style></head><body><article>
<h1>Paper notes</h1>
<p id="p1">The first paragraph talks about the <b>history</b> of sticky notes and why people love them.</p>
<p id="p2">${p2}</p>
<p id="p3">The answer is 42. Later on, the answer is 42 again.</p>
${'<p>Filler paragraph to make the page scroll.</p>'.repeat(40)}
</article></body></html>`;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  await rm(testDist, { recursive: true, force: true });
  await cp(dist, testDist, { recursive: true });
  const manifestPath = join(testDist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const server = http
    .createServer((req, res) => {
      if (req.url?.startsWith('/article.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(article());
      } else if (req.url === '/favicon.ico') {
        res.writeHead(204).end();
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(PORT, '127.0.0.1');

  const profile = await mkdtemp(join(tmpdir(), 'quicknotes-smoke-'));
  // Branded Chrome ≥ 137 ignores --load-extension; it loads unpacked extensions
  // through the CDP method Extensions.loadUnpacked instead, which requires
  // --enable-unsafe-extension-debugging (and extensions not disabled).
  // `--chromium` uses Playwright's bundled Chromium with --load-extension.
  const useChromium = process.argv.includes('--chromium');
  const context = await chromium.launchPersistentContext(profile, {
    channel: useChromium ? 'chromium' : 'chrome',
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    args: [
      '--lang=en-US',
      ...(useChromium
        ? [`--disable-extensions-except=${testDist}`, `--load-extension=${testDist}`]
        : ['--enable-unsafe-extension-debugging']),
    ],
    ignoreDefaultArgs: useChromium ? [] : ['--disable-extensions'],
  });

  const pageErrors = [];
  try {
    if (!useChromium) {
      const session = await context.browser().newBrowserCDPSession();
      await session.send('Extensions.loadUnpacked', { path: testDist });
    }
    let [worker] = context.serviceWorkers();
    worker ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(worker.url()).host;
    check('service worker starts', Boolean(extensionId), worker.url());

    // chrome://extensions: no warnings or errors for the extension.
    const extPage = await context.newPage();
    await extPage.goto(`chrome://extensions/?id=${extensionId}`);
    await extPage.locator('extensions-detail-view').waitFor({ timeout: 15_000 });
    await extPage.waitForTimeout(1000);
    // innerText does not enter shadow roots, so collect the visible text by hand.
    const detailText = await extPage.evaluate(() => {
      const parts = [];
      const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement;
          if (parent && parent.checkVisibility() && node.data.trim()) parts.push(node.data.trim());
          return;
        }
        if (node.shadowRoot) visit(node.shadowRoot);
        for (const child of node.childNodes) visit(child);
      };
      visit(document.querySelector('extensions-manager'));
      return parts.join(' | ');
    });
    const hasName = detailText.includes('QuickNotes: Highlights & Sticky Notes');
    const errorsButton = await extPage
      .locator('extensions-detail-view #errors-button')
      .filter({ visible: true })
      .count();
    const warningBlocks = await extPage
      .locator('extensions-detail-view .warning-list, extensions-detail-view #warnings')
      .filter({ visible: true })
      .count();
    check(
      'loads without warnings or errors on chrome://extensions',
      // Manifest problems show up as "Unrecognized manifest key …" / "… is unknown" warnings.
      // (The notice about unpacked extensions loaded outside developer mode is not one.)
      hasName &&
        errorsButton === 0 &&
        warningBlocks === 0 &&
        !/unrecognized|is unknown|manifest|errors/i.test(detailText),
      `name shown: ${hasName}, errors button: ${errorsButton}, warnings: ${warningBlocks}, text: ${detailText.slice(0, 2000).replace(/\s+/g, ' ')}`,
    );
    await extPage.close();

    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.goto(`${ORIGIN}/article.html`);

    // An extension page to talk to the background, like the popup does.
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const bg = (message) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
    const tabId = await ext.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${ORIGIN}/*`);
    const storage = () => ext.evaluate(() => chrome.storage.local.get(null));
    const pageKey = `page:${ORIGIN}/article.html`;

    await page.bringToFront();
    const injected = await bg({ type: 'qn:bg:inject', tabId });
    check('content script injects on demand', injected?.ok === true, JSON.stringify(injected));
    const injectedAgain = await bg({ type: 'qn:bg:inject', tabId });
    check(
      'second injection is a no-op',
      injectedAgain?.ok === true && (await page.locator('quicknotes-root').count()) === 1,
    );

    // --- Highlight from the selection toolbar ---------------------------
    await page.evaluate(() => {
      const p = document.getElementById('p2');
      const text = p.firstChild;
      const start = text.data.indexOf('stored with context');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'stored with context'.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    const toolbar = page.locator('[data-qn="toolbar"]');
    await toolbar.waitFor({ state: 'visible', timeout: 5000 });
    check('toolbar appears on selection', true);
    await mkdir(shotsDir, { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotsDir, 'smoke-toolbar.png') });
    await page.getByRole('button', { name: 'Highlight in Yellow' }).click();
    await page.locator('quicknotes-mark').first().waitFor({ timeout: 5000 });
    const markText = (await page.locator('quicknotes-mark').allTextContents()).join('');
    check('selection is highlighted', markText === 'stored with context', markText);
    check('toolbar hides after highlighting', (await toolbar.count()) === 0);

    // --- Highlight via message (context-menu path) on a repeated quote ----
    await page.evaluate(() => {
      const p = document.getElementById('p3');
      const text = p.firstChild;
      const start = text.data.lastIndexOf('the answer is 42');
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + 'the answer is 42'.length);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
    const viaMenu = await bg({ type: 'qn:bg:highlight-selection', tabId, color: 'pink' });
    check('highlight-selection message works', viaMenu?.ok === true, JSON.stringify(viaMenu));

    // --- Sticky note ------------------------------------------------------
    const created = await bg({ type: 'qn:bg:new-note', tabId });
    check('new-note message works', created?.ok === true, JSON.stringify(created));
    const note = page.locator('[data-qn="note"]');
    await note.waitFor({ timeout: 5000 });
    await page.keyboard.type('Remember ');
    await page.keyboard.press('Control+B');
    await page.keyboard.type('this');
    await page.keyboard.press('Control+B');
    await page.keyboard.type(' now');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.type('first item');
    await page.keyboard.press('Enter');
    await page.keyboard.type('second item');
    await page.waitForTimeout(900);
    let data = await storage();
    const savedHtml = data[pageKey]?.notes?.[0]?.html ?? '';
    check(
      'note text is saved with formatting',
      /Remember <b>this<\/b> now/.test(savedHtml) &&
        /<ul><li>first item<\/li><li>second item<\/li><\/ul>/.test(savedHtml),
      savedHtml,
    );

    await page.screenshot({ path: join(shotsDir, 'smoke-note.png') });
    const header = note.locator('div').first();
    const box = await header.boundingBox();
    const before = data[pageKey]?.notes?.[0]?.position;
    await page.mouse.move(box.x + box.width - 90, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 90 - 200, box.y + 10 + 120, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    data = await storage();
    const after = data[pageKey]?.notes?.[0]?.position;
    check(
      'dragging a note stores a new percentage position',
      after && before && after.x < before.x && after.y > before.y,
      `${JSON.stringify(before)} → ${JSON.stringify(after)}`,
    );

    // --- Shadow DOM isolation --------------------------------------------
    const styles = await page.evaluate(() => {
      const host = document.querySelector('quicknotes-root');
      const shadow = host.shadowRoot;
      const editor = shadow.querySelector('.qn-editor');
      const noteBox = shadow.querySelector('[data-qn="note"]');
      const button = shadow.querySelector('[data-qn="note"] button');
      const e = getComputedStyle(editor);
      const n = getComputedStyle(noteBox);
      const b = getComputedStyle(button);
      return {
        hostDisplay: getComputedStyle(host).display,
        hostZ: getComputedStyle(host).zIndex,
        editorColor: e.color,
        editorFont: e.fontFamily,
        editorSize: e.fontSize,
        editorLineHeight: e.lineHeight,
        noteBorder: n.borderTopColor,
        buttonBackground: b.backgroundColor,
        buttonFontSize: b.fontSize,
        pageColor: getComputedStyle(document.getElementById('p1')).color,
      };
    });
    check('page CSS still applies to the page itself', styles.pageColor === 'rgb(255, 0, 0)', styles.pageColor);
    check(
      'page CSS does not leak into the injected UI',
      styles.editorColor === 'rgb(28, 25, 23)' &&
        !/serif/.test(styles.editorFont.replace('sans-serif', '')) &&
        styles.editorSize === '14px' &&
        styles.noteBorder !== 'rgb(0, 255, 0)' &&
        styles.buttonBackground !== 'rgb(0, 0, 0)' &&
        styles.buttonFontSize !== '30px',
      JSON.stringify(styles),
    );
    check('host sits on top of the page', styles.hostDisplay === 'block' && styles.hostZ === '2147483647');
    const leaked = await page.evaluate(() => getComputedStyle(document.querySelector('h1')).boxSizing);
    check('UI styles do not leak into the page', leaked === 'content-box', `h1 box-sizing: ${leaked}`);

    // --- Reload: everything comes back -----------------------------------
    await page.reload();
    await bg({ type: 'qn:bg:inject', tabId });
    await page.locator('[data-qn="note"]').waitFor({ timeout: 5000 });
    const restoredMarks = await page.locator('quicknotes-mark').allTextContents();
    check(
      'highlights are restored after reload',
      restoredMarks.join('|') === 'stored with context|the answer is 42',
      restoredMarks.join('|'),
    );
    const restoredContext = await page.evaluate(() => {
      const mark = [...document.querySelectorAll('quicknotes-mark')].find((m) => m.textContent === 'the answer is 42');
      return mark?.previousSibling?.textContent?.slice(-10) ?? '';
    });
    check('repeated quote restored on the right occurrence', restoredContext.endsWith('Later on, '), restoredContext);
    const restoredNote = await page.evaluate(
      () => document.querySelector('quicknotes-root').shadowRoot.querySelector('.qn-editor').innerHTML,
    );
    check('note is restored after reload', restoredNote.includes('<b>this</b>'), restoredNote);
    const status = await bg({ type: 'qn:bg:get-status', tabId });
    check(
      'status reports counts',
      status?.ok && status.data.highlights === 2 && status.data.notes === 1,
      JSON.stringify(status),
    );

    // --- Click a highlight: menu, recolor ---------------------------------
    await page.locator('quicknotes-mark').first().click();
    const menu = page.locator('[data-qn="highlight-menu"]');
    await menu.waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotsDir, 'smoke-menu.png') });
    await page.getByRole('button', { name: 'Change color to Blue' }).click();
    await page.waitForTimeout(300);
    const color = await page.locator('quicknotes-mark').first().getAttribute('data-qn-color');
    check('highlight menu recolors', color === 'blue', color ?? 'none');
    await page.keyboard.press('Escape');

    // --- Orphans ------------------------------------------------------------
    variant = 2;
    await page.reload();
    await bg({ type: 'qn:bg:inject', tabId });
    await page.waitForTimeout(500);
    const orphanStatus = await bg({ type: 'qn:bg:get-status', tabId });
    // Static page: the orphan watch ends after ~1.5 s without DOM changes.
    await page
      .locator('[data-qn="toast"]')
      .first()
      .waitFor({ timeout: 8000 })
      .catch(() => undefined);
    check(
      'a highlight whose text disappeared is reported as orphaned',
      orphanStatus?.ok &&
        orphanStatus.data.orphans.length === 1 &&
        (await page.locator('quicknotes-mark').count()) === 1,
      JSON.stringify(orphanStatus?.data),
    );
    const toast = await page.locator('[data-qn="toast"]').allTextContents();
    check(
      'orphan toast is shown',
      toast.some((t) => t.includes('not found')),
      toast.join(' | '),
    );
    await page.waitForTimeout(500);
    data = await storage();
    const flagged = (data[pageKey]?.highlights ?? []).filter((h) => h.orphaned).length;
    check('orphan flag is stored once the page is quiet', flagged === 1, `flagged: ${flagged}`);
    variant = 1;

    // --- Pause on this site ----------------------------------------------
    await page.reload();
    await bg({ type: 'qn:bg:inject', tabId });
    await page.locator('[data-qn="note"]').waitFor({ timeout: 5000 });
    await ext.evaluate(() =>
      chrome.storage.sync.set({
        settings: {
          defaultColor: 'yellow',
          showToolbar: true,
          pausedSites: ['127.0.0.1'],
          theme: 'system',
          autoRestore: false,
        },
      }),
    );
    await page.waitForTimeout(500);
    check(
      'pausing removes highlights and notes from the page',
      (await page.locator('quicknotes-mark').count()) === 0 && (await page.locator('[data-qn="note"]').count()) === 0,
    );
    const pausedNote = await bg({ type: 'qn:bg:new-note', tabId });
    check(
      'actions are refused on a paused site',
      pausedNote?.ok === false && pausedNote.error === 'paused',
      JSON.stringify(pausedNote),
    );
    await page.evaluate(() => {
      const text = document.getElementById('p1').firstChild;
      const range = document.createRange();
      range.setStart(text, 4);
      range.setEnd(text, 20);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    check('no toolbar on a paused site', (await page.locator('[data-qn="toolbar"]').count()) === 0);
    await ext.evaluate(() => chrome.storage.sync.remove('settings'));
    await page.locator('[data-qn="note"]').waitFor({ timeout: 5000 });
    check('resuming restores the page', (await page.locator('quicknotes-mark').count()) === 2);

    // --- Opt-in auto restore (registered content script) ------------------
    const registeredScripts = () => ext.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    check('nothing is registered while auto-restore is off', (await registeredScripts()).length === 0);
    await ext.evaluate(() => chrome.storage.sync.set({ settings: { autoRestore: true } }));
    await page.waitForTimeout(700);
    const registered = await registeredScripts();
    check(
      'opting in registers the content script for http(s) pages',
      registered.length === 1 &&
        registered[0].js?.[0] === 'src/content/index.js' &&
        registered[0].matches?.includes('https://*/*'),
      JSON.stringify(registered),
    );
    await page.reload();
    await page.locator('[data-qn="note"]').waitFor({ timeout: 10_000 });
    check(
      'with auto-restore, notes and highlights reappear on load without any click',
      (await page.locator('quicknotes-mark').count()) === 2,
    );

    await ext.evaluate(() => chrome.storage.sync.set({ settings: { autoRestore: true, pausedSites: ['127.0.0.1'] } }));
    await page.waitForTimeout(700);
    const excluded = await registeredScripts();
    check(
      'paused sites are excluded from the registration',
      JSON.stringify(excluded[0]?.excludeMatches ?? []).includes('*://127.0.0.1/*'),
      JSON.stringify(excluded[0]?.excludeMatches),
    );
    await page.reload();
    await page.waitForTimeout(1500);
    check('a paused site gets no content script on load', (await page.locator('quicknotes-root').count()) === 0);

    await ext.evaluate(() => chrome.storage.sync.remove('settings'));
    await page.waitForTimeout(700);
    check('turning auto-restore off unregisters the script', (await registeredScripts()).length === 0);

    check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
