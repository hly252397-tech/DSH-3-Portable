// Mechanical asset embedding: no runtime network requests or extra host routes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const client = fileURLToPath(new URL('../customizations/black-hole/lib/client.js', import.meta.url));
const bytes = readFileSync(new URL('../customizations/black-hole/assets/black-hole-banner.webp', import.meta.url));
if (bytes.length > 100_000 || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Expected WebP asset under 100KB');
const source = readFileSync(client, 'utf8');
const marker = /const BANNER_IMAGE = '[^']*'; \/\/ @black-hole-art/g;
if ([...source.matchAll(marker)].length !== 1) throw new Error('Asset marker missing or ambiguous');
const result = source.replace(marker, `const BANNER_IMAGE = 'data:image/webp;base64,${bytes.toString('base64')}'; // @black-hole-art`);
if (process.argv.includes('--check')) {
  if (source !== result) throw new Error('Embedded black-hole image is stale; run scripts/build-black-hole-art.mjs');
} else if (result !== source) writeFileSync(client, result);
console.log(`Black hole offline art verified (${bytes.length} bytes)`);
