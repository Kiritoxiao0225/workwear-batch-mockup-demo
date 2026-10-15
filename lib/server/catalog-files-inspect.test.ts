import sharp from 'sharp';
import { expect, it } from 'vitest';
import { CatalogHttpError } from './catalog-auth';
import { inspectCatalogImage } from './catalog-files';

it('accepts a real upload format', async () => {
  const png = await sharp({ create: { width: 6, height: 4, channels: 4, background: '#0000' } }).png().toBuffer();
  expect(await inspectCatalogImage(png)).toMatchObject({ width: 6, height: 4, hasAlpha: true, mimeType: 'image/png' });
});

it.each([
  ['an unreadable file', Buffer.from('not an image at all')],
  ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>')],
])('refuses %s as the user\'s mistake, not a server failure', async (_, bytes) => {
  const error = await inspectCatalogImage(bytes).catch(e => e);
  expect(error).toBeInstanceOf(CatalogHttpError);
  expect(error.status).toBe(415);
});
