import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.stubGlobal('window', { wook: {}, location: { search: '' } });

it('keeps a toast area mounted while the first snapshot is loading', async () => {
  const { App } = await import('../App');
  const markup = renderToString(createElement(App));
  expect(markup).toContain('toast-stack login-toasts');
});
