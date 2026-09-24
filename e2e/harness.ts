/**
 * Test harness: launches a browser with the unpacked extension from dist/,
 * serves demo/article.html, and gives tests handles on the parts of the
 * extension Playwright does not expose as pages (popup, side panel) through
 * raw DevTools-protocol target sessions.
 *
 * Browser selection (QN_E2E_BROWSER):
 *  - "chromium": Playwright's bundled Chromium with --load-extension
 *    (QN_CHROMIUM_PATH overrides the executable);
 *  - "chrome": the installed Google Chrome. Branded Chrome ignores
 *    --load-extension since version 137, so the extension is loaded with the
 *    DevTools method Extensions.loadUnpacked (needs
 *    --enable-unsafe-extension-debugging). Recent Chrome also offers
 *    Extensions.triggerAction — a real toolbar-button click, which is what grants
 *    `activeTab` — so the activeTab tests only run there;
 *  - "auto" (default): Chromium, falling back to Chrome when it cannot start.
 * A spec can pin its browser with `test.use({ browserKind: 'chrome' })`.
 *
 * Variants of the extension under test:
 *  - "default": host access only through activeTab, as installed;
 *  - "hosts": the optional http/https host permissions are declared as granted,
 *    standing in for the user accepting the "Restore my notes automatically"
 *    permission prompt, which a headless browser cannot show. Revoking works as
 *    in real life, from chrome://extensions (see ExtensionHarness.setSiteAccess).
 *
 * Shadow root (`shadow` option):
 *  - "test" (default): a copy of dist/ in which the one `attachShadow({mode:
 *    "closed"})` call of the content script is patched to "open", so that
 *    Playwright locators (which only pierce open shadow roots) can drive the
 *    injected UI. Nothing else differs from the shipped build.
 *  - "shipped": dist/ exactly as built (closed shadow root). Used by the install
 *    and privacy specs.
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  chromium,
  test as base,
  type BrowserContext,
  type CDPSession,
  type Page,
  type TestInfo,
  type Worker,
} from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
export const DEMO_PORT = Number(process.env.QN_E2E_PORT) || 4324;
const HEADED = process.env.QN_E2E_HEADED === '1';

export type Variant = 'default' | 'hosts';
export type ShadowMode = 'test' | 'shipped';
export type BrowserKind = 'chromium' | 'chrome';

// ---------------------------------------------------------------------------
// Raw CDP targets (popup, side panel)
// ---------------------------------------------------------------------------

interface CdpReply {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

interface RemoteObject {
  value?: unknown;
  description?: string;
}

/** A page-like target (popup, side panel) driven over a DevTools session. */
export class CdpTarget {
  readonly errors: string[] = [];
  private sequence = 0;
  private readonly pending = new Map<number, (reply: CdpReply) => void>();

  private constructor(
    private readonly session: CDPSession,
    private readonly sessionId: string,
    readonly targetId: string,
    readonly url: string,
  ) {
    session.on('Target.receivedMessageFromTarget', (event: { sessionId: string; message: string }) => {
      if (event.sessionId !== this.sessionId) return;
      const message = JSON.parse(event.message) as CdpReply;
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
        const args = (message.params.args as RemoteObject[] | undefined) ?? [];
        const text = args.map((arg) =>
          typeof arg.value === 'string' ? arg.value : (arg.description ?? JSON.stringify(arg.value)),
        );
        this.errors.push(`${this.url}: ${text.join(' ')}`);
      } else if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params?.exceptionDetails as { text?: string; exception?: RemoteObject } | undefined;
        this.errors.push(`${this.url}: ${details?.exception?.description ?? details?.text ?? 'exception'}`);
      }
    });
  }

  /** Waits for a target whose URL contains `urlPart` and attaches to it. */
  static async attach(session: CDPSession, urlPart: string, timeout = 15_000): Promise<CdpTarget> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const { targetInfos } = (await session.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string; type: string }>;
      };
      const info = targetInfos.find((target) => target.type === 'page' && target.url.includes(urlPart));
      if (info) {
        const { sessionId } = await session.send('Target.attachToTarget', {
          targetId: info.targetId,
          flatten: false,
        });
        const target = new CdpTarget(session, sessionId, info.targetId, info.url);
        await target.send('Runtime.enable');
        await target.waitFor('document.readyState === "complete"');
        return target;
      }
      if (Date.now() > deadline) throw new Error(`No target matching ${urlPart}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (reply) =>
        reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result ?? {}),
      );
      void this.session
        .send('Target.sendMessageToTarget', {
          sessionId: this.sessionId,
          message: JSON.stringify({ id, method, params }),
        })
        .catch(reject);
    });
  }

  /**
   * Evaluates a function in the target (with a user gesture, like a click) and
   * returns its JSON-serializable result.
   */
  async evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    const result = (await this.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as { result?: RemoteObject; exceptionDetails?: { exception?: RemoteObject; text?: string } };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed',
      );
    }
    return result.result?.value as R;
  }

  /** Polls a JavaScript expression until it is truthy. */
  async waitFor(expression: string, timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true })) as {
        result?: RemoteObject;
      };
      if (result.result?.value) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Clicks the first element matching `selector` whose text contains `text` (if given). */
  click(selector: string, text?: string): Promise<void> {
    return this.evaluate(
      ({ selector, text }) => {
        const element = [...document.querySelectorAll<HTMLElement>(selector)].find(
          (candidate) => text === undefined || (candidate.textContent ?? '').includes(text),
        );
        if (!element) throw new Error(`No element for ${selector} ${text ?? ''}`);
        element.click();
      },
      { selector, text },
    );
  }

  /** Sets an input's or select's value the way typing or choosing would. */
  fill(selector: string, value: string): Promise<void> {
    return this.evaluate(
      ({ selector, value }) => {
        const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
        if (!element) throw new Error(`No element for ${selector}`);
        element.value = value;
        element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      },
      { selector, value },
    );
  }

  text(selector: string): Promise<string[]> {
    return this.evaluate(
      (selector) => [...document.querySelectorAll(selector)].map((element) => (element.textContent ?? '').trim()),
      selector,
    );
  }

  async screenshot(path?: string): Promise<Buffer> {
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    const buffer = Buffer.from(data, 'base64');
    if (path) await writeFile(path, buffer);
    return buffer;
  }

  async close(): Promise<void> {
    await this.session.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Browser + extension
// ---------------------------------------------------------------------------

/** The content script's shadow-root call as the minifier prints it (see src/content/shadow.ts). */
const CLOSED_SHADOW_CALL = /attachShadow\(\{\s*mode:\s*(["'`])closed\1\s*\}\)/g;

/** Patches the copy's single closed shadow root to "open"; fails loudly if the build changed shape. */
async function openShadowRootForTests(dir: string): Promise<void> {
  const files = (await readdir(dir, { recursive: true })).filter((file) => file.endsWith('.js'));
  let replaced = 0;
  for (const file of files) {
    const path = join(dir, file);
    const code = await readFile(path, 'utf8');
    const patched = code.replace(CLOSED_SHADOW_CALL, () => {
      replaced++;
      return 'attachShadow({mode:"open"})';
    });
    if (patched !== code) await writeFile(path, patched);
  }
  if (replaced !== 1) {
    throw new Error(`Expected exactly one closed attachShadow() call in the build, found ${replaced}.`);
  }
}

/** The directory Chrome loads for a variant: dist/ itself, or a patched copy of it. */
async function prepareBuild(variant: Variant, shadow: ShadowMode): Promise<string> {
  if (variant === 'default' && shadow === 'shipped') return DIST;
  const dir = join(ROOT, `dist-e2e-${variant}${shadow === 'shipped' ? '-shipped' : ''}`);
  await rm(dir, { recursive: true, force: true });
  await cp(DIST, dir, { recursive: true });
  if (variant === 'hosts') {
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    manifest.host_permissions = manifest.optional_host_permissions;
    delete manifest.optional_host_permissions;
    await writeFile(path, JSON.stringify(manifest, null, 2));
  }
  if (shadow === 'test') await openShadowRootForTests(dir);
  return dir;
}

const LAUNCH_OPTIONS = {
  headless: !HEADED,
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  acceptDownloads: true,
} as const;

/**
 * The id of the unpacked extension: from its service worker, or — if the worker
 * is not running yet — from chrome://extensions.
 */
async function unpackedExtensionId(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null));
  if (worker) return new URL(worker.url()).host;
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions/');
    const id = await page.evaluate(async () => {
      const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      return (await api.getExtensionsInfo()).find((extension) => extension.location === 'UNPACKED')?.id;
    });
    if (!id) throw new Error('The unpacked extension did not load.');
    return id;
  } finally {
    await page.close();
  }
}

async function launch(
  profile: string,
  extensionPath: string,
  pinned: BrowserKind | 'default',
): Promise<{ context: BrowserContext; kind: BrowserKind; extensionId: string }> {
  const wanted = pinned === 'default' ? (process.env.QN_E2E_BROWSER ?? 'auto') : pinned;
  if (wanted !== 'chrome') {
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profile, {
        ...LAUNCH_OPTIONS,
        channel: 'chromium',
        ...(process.env.QN_CHROMIUM_PATH ? { executablePath: process.env.QN_CHROMIUM_PATH } : {}),
        args: ['--lang=en-US', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      });
    } catch (error) {
      if (wanted === 'chromium') throw error;
      process.stderr.write(
        `[e2e] Bundled Chromium did not start (${String(error).split('\n')[0]}); using installed Chrome.\n`,
      );
    }
    if (context) return { context, kind: 'chromium', extensionId: await unpackedExtensionId(context) };
  }
  const context = await chromium.launchPersistentContext(profile, {
    ...LAUNCH_OPTIONS,
    channel: 'chrome',
    args: ['--lang=en-US', '--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  const session = await context.browser()!.newBrowserCDPSession();
  const { id } = await session.send('Extensions.loadUnpacked', { path: extensionPath });
  await session.detach();
  return { context, kind: 'chrome', extensionId: id };
}

interface ExtensionInfo {
  runtimeErrors: Array<{ message: string; source: string; contextUrl: string }>;
  manifestErrors: Array<{ message: string }>;
  installWarnings: Array<{ message: string }>;
}

interface DeveloperPrivate {
  getExtensionsInfo(): Promise<Array<{ id: string; location: string }>>;
  updateProfileConfiguration(update: { inDeveloperMode: boolean }): Promise<void>;
  getExtensionInfo(id: string): Promise<ExtensionInfo>;
  updateExtensionConfiguration(update: {
    extensionId: string;
    hostAccess?: string;
    fileAccess?: boolean;
  }): Promise<void>;
}

/** Everything a test needs to drive the extension. */
export class ExtensionHarness {
  readonly pageErrors: string[] = [];
  private readonly targets: CdpTarget[] = [];
  private browserSession: CDPSession | null = null;
  private managementPage: Page | null = null;

  constructor(
    readonly context: BrowserContext,
    readonly kind: BrowserKind,
    readonly extensionId: string,
    readonly variant: Variant,
    readonly demoUrl: string,
  ) {
    context.on('console', (message) => {
      if (message.type() === 'error') this.pageErrors.push(`${message.page()?.url() ?? '?'}: ${message.text()}`);
    });
    context.on('weberror', (error) => this.pageErrors.push(`${error.page()?.url() ?? '?'}: ${String(error.error())}`));
  }

  get origin(): string {
    return `chrome-extension://${this.extensionId}`;
  }

  /** The extension's service worker, woken up with a message if Chrome stopped it. */
  async worker(): Promise<Worker> {
    const find = () => this.context.serviceWorkers().find((worker) => worker.url().startsWith(this.origin));
    const running = find();
    if (running) return running;
    const started = this.context.waitForEvent('serviceworker', {
      predicate: (worker) => worker.url().startsWith(this.origin),
      timeout: 20_000,
    });
    const page = await this.extensionPage('src/options/index.html');
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'qn:bg:sync-auto-restore' })).catch(() => undefined);
    await page.close();
    return find() ?? started;
  }

  async session(): Promise<CDPSession> {
    this.browserSession ??= await this.context.browser()!.newBrowserCDPSession();
    return this.browserSession;
  }

  /** Opens one of the extension's own pages (options, side panel…) in a tab. */
  async extensionPage(path: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(`${this.origin}/${path}`);
    return page;
  }

  /** Opens the demo article in a new tab. */
  async openDemo(hash = ''): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(this.demoUrl + hash);
    await page.bringToFront();
    return page;
  }

  /** chrome.storage.local, read from the service worker. */
  async storage(): Promise<Record<string, unknown>> {
    const worker = await this.worker();
    return worker.evaluate(() => chrome.storage.local.get(null));
  }

  async demoRecord(): Promise<{
    title: string;
    highlights: Array<{ id: string; color: string; orphaned?: boolean; anchor: { quote: { exact: string } } }>;
    notes: Array<{
      id: string;
      html: string;
      color: string;
      minimized: boolean;
      position: { x: number; y: number };
      size: { width: number; height: number };
      highlightId?: string;
    }>;
  } | null> {
    const all = await this.storage();
    return (all[`page:${this.demoUrl}`] as never) ?? null;
  }

  canTriggerAction(): boolean {
    return this.kind === 'chrome';
  }

  /**
   * Clicks the extension's toolbar button for `page`'s tab — what a user does,
   * and what grants `activeTab` — and returns the popup it opens.
   */
  async clickAction(page: Page): Promise<CdpTarget> {
    const session = await this.session();
    await page.bringToFront();
    const { targetInfos } = (await session.send('Target.getTargets', { filter: [{ type: 'tab' }] })) as {
      targetInfos: Array<{ targetId: string; url: string }>;
    };
    const tab = targetInfos.find((info) => info.url === page.url());
    if (!tab) throw new Error(`No tab target for ${page.url()}`);
    // Not in Playwright 1.57's protocol typings yet (added to Chrome after Chromium 143).
    const send = session.send.bind(session) as (method: string, params: object) => Promise<unknown>;
    await send('Extensions.triggerAction', { id: this.extensionId, targetId: tab.targetId });
    return this.attach('/src/popup/index.html');
  }

  /**
   * Opens the popup programmatically (chrome.action.openPopup). Unlike a click
   * this grants no activeTab, so the popup only sees the tab with host access.
   */
  async openPopup(page: Page): Promise<CdpTarget> {
    await page.bringToFront();
    const worker = await this.worker();
    // Chrome refuses while a previous popup is still closing; try again briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await worker.evaluate(() => chrome.action.openPopup());
        break;
      } catch (error) {
        if (attempt >= 10) throw error;
        await page.waitForTimeout(300);
      }
    }
    return this.attach('/src/popup/index.html');
  }

  /** Attaches to an extension page that is not a Playwright page (popup, side panel). */
  async attach(path: string): Promise<CdpTarget> {
    const target = await CdpTarget.attach(await this.session(), `${this.origin}${path}`);
    this.targets.push(target);
    return target;
  }

  /** chrome://extensions, where developer mode, site access and error reports live. */
  private async management(): Promise<Page> {
    if (!this.managementPage || this.managementPage.isClosed()) {
      this.managementPage = await this.context.newPage();
      await this.managementPage.goto('chrome://extensions/');
      await this.managementPage.locator('extensions-manager').waitFor();
      await this.managementPage.evaluate(async () => {
        const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
        await api.updateProfileConfiguration({ inDeveloperMode: true });
      });
    }
    return this.managementPage;
  }

  /** Turns on developer mode so Chrome records the extension's errors (from every context). */
  async enableErrorCollection(): Promise<void> {
    await this.management();
  }

  /** Errors, manifest problems and install warnings Chrome recorded for the extension. */
  async extensionInfo(): Promise<ExtensionInfo> {
    const page = await this.management();
    return page.evaluate(async (id) => {
      const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
      const info = await api.getExtensionInfo(id);
      return {
        runtimeErrors: info.runtimeErrors.map(({ message, source, contextUrl }) => ({ message, source, contextUrl })),
        manifestErrors: info.manifestErrors.map(({ message }) => ({ message })),
        installWarnings: info.installWarnings.map(({ message }) => ({ message })),
      };
    }, this.extensionId);
  }

  /**
   * Site access as set on chrome://extensions: "all" grants the host
   * permissions, "on-click" withholds them (what a user does to revoke).
   */
  async setSiteAccess(access: 'all' | 'on-click'): Promise<void> {
    const page = await this.management();
    await page.evaluate(
      async ({ id, hostAccess }) => {
        const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
        await api.updateExtensionConfiguration({ extensionId: id, hostAccess });
      },
      { id: this.extensionId, hostAccess: access === 'all' ? 'ON_ALL_SITES' : 'ON_CLICK' },
    );
  }

  /**
   * Chrome's "Allow access to file URLs" switch for the extension (off for a new
   * install). Chrome reloads the extension when it changes.
   */
  async setFileAccess(allowed: boolean): Promise<void> {
    const page = await this.management();
    await page.evaluate(
      async ({ id, fileAccess }) => {
        const api = (chrome as unknown as { developerPrivate: DeveloperPrivate }).developerPrivate;
        await api.updateExtensionConfiguration({ extensionId: id, fileAccess });
      },
      { id: this.extensionId, fileAccess: allowed },
    );
  }

  /** Every error seen in any extension context and on the pages under test. */
  async allErrors(): Promise<string[]> {
    const info = await this.extensionInfo();
    return [
      ...this.pageErrors,
      ...this.targets.flatMap((target) => target.errors),
      ...info.runtimeErrors.map((error) => `${error.contextUrl || error.source}: ${error.message}`),
      ...info.manifestErrors.map((error) => `manifest: ${error.message}`),
      ...info.installWarnings.map((warning) => `install warning: ${warning.message}`),
    ];
  }

  async dispose(testInfo: TestInfo): Promise<void> {
    if (testInfo.status !== testInfo.expectedStatus) {
      await mkdir(testInfo.outputDir, { recursive: true });
      let index = 0;
      for (const page of this.context.pages()) {
        if (page.url().startsWith('chrome://')) continue;
        const path = testInfo.outputPath(`failure-${index++}.png`);
        await page.screenshot({ path }).catch(() => undefined);
      }
      for (const target of this.targets) {
        await target.screenshot(testInfo.outputPath(`failure-${index++}.png`)).catch(() => undefined);
      }
    }
    await this.context.close();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface DemoServer {
  url: string;
  close: () => Promise<void>;
}

interface Options {
  variant: Variant;
  shadow: ShadowMode;
  /** Browser for this spec; "default" follows QN_E2E_BROWSER (auto: Chromium, then Chrome). */
  browserKind: BrowserKind | 'default';
}

export const test = base.extend<Options & { harness: ExtensionHarness }, { demo: DemoServer }>({
  variant: ['default', { option: true }],
  shadow: ['test', { option: true }],
  browserKind: ['default', { option: true }],

  demo: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const serverModule = pathToFileURL(join(ROOT, 'scripts', 'demo-server.mjs')).href;
      const { startDemoServer } = (await import(serverModule)) as {
        startDemoServer: (options: { port: number }) => Promise<DemoServer>;
      };
      const server = await startDemoServer({ port: DEMO_PORT });
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  harness: async ({ variant, shadow, browserKind, demo }, use, testInfo) => {
    const extensionPath = await prepareBuild(variant, shadow);
    const profile = await mkdtemp(join(tmpdir(), 'quicknotes-e2e-'));
    const { context, kind, extensionId } = await launch(profile, extensionPath, browserKind);
    const harness = new ExtensionHarness(context, kind, extensionId, variant, demo.url);
    try {
      await harness.enableErrorCollection();
      await use(harness);
    } finally {
      await harness.dispose(testInfo).catch(() => undefined);
      await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
  },
});

export { expect } from '@playwright/test';
