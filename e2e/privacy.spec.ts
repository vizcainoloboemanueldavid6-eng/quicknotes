/**
 * The shipped build (not the test copy with an open shadow root): scripts of
 * the annotated page cannot read, change or delete the user's notes, because
 * the injected UI lives in a closed shadow root that only the content script
 * (in its isolated world) holds.
 */
import { popupReady, waitForQuickNotes } from './helpers';
import { expect, test } from './harness';

test.use({ variant: 'hosts', shadow: 'shipped' });

const SECRET = 'My private opinion about this site';

test("the page's scripts cannot reach the notes in the closed shadow root", async ({ harness }) => {
  const page = await harness.context.newPage();
  // A hostile page trying to capture every shadow root created in its world.
  await page.addInitScript(() => {
    // Taken unbound on purpose: it is called with .call(this) below, as page scripts that patch it do.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = Element.prototype.attachShadow;
    const captured: ShadowRoot[] = [];
    Object.defineProperty(window, '__captured', { value: captured });
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = original.call(this, { ...init, mode: 'open' });
      captured.push(root);
      return root;
    };
  });
  await page.goto(harness.demoUrl);
  await page.bringToFront();

  // "New note" from the popup; the new note has the focus, so typing goes into it.
  const popup = await harness.openPopup(page);
  await waitForQuickNotes(page);
  await popupReady(popup);
  await popup.click('button', 'New note');
  await page.waitForTimeout(300);
  await page.keyboard.type(SECRET);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await harness.demoRecord())?.notes[0]?.html).toBe(SECRET);

  // Everything the page's own JavaScript can try.
  const seenByPage = await page.evaluate((secret) => {
    const host = document.querySelector('quicknotes-root');
    const captured = (window as unknown as { __captured: ShadowRoot[] }).__captured;
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight * 0.3);
    return {
      hostFound: host !== null,
      shadowRoot: host?.shadowRoot ?? null,
      hostChildren: host?.childNodes.length ?? -1,
      hostText: host?.textContent ?? '',
      capturedRoots: captured.length,
      secretInHtml: document.documentElement.outerHTML.includes(secret),
      secretInBodyText: document.body.innerText.includes(secret),
      secretInRootText: document.documentElement.innerText.includes(secret),
      hitInsideUi: hit !== null && hit !== host && host?.contains(hit) === true,
    };
  }, SECRET);
  expect(seenByPage).toEqual({
    hostFound: true,
    shadowRoot: null,
    hostChildren: 0,
    hostText: '',
    capturedRoots: 0,
    secretInHtml: false,
    secretInBodyText: false,
    secretInRootText: false,
    hitInsideUi: false,
  });

  // The note is still there, unchanged, after the page tried.
  expect((await harness.demoRecord())?.notes).toHaveLength(1);
  expect((await harness.demoRecord())?.notes[0]?.html).toBe(SECRET);
  expect(await harness.allErrors()).toEqual([]);
});
