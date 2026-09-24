import { beforeEach } from 'vitest';
import { createChromeMock, type ChromeMock } from './chromeMock';

declare global {
  var mockChrome: ChromeMock;
}

beforeEach(() => {
  const mock = createChromeMock();
  globalThis.mockChrome = mock;
  (globalThis as unknown as { chrome: ChromeMock }).chrome = mock;
});
