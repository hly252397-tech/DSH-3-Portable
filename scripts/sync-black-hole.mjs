// Repository-owned source -> existing portable Profile. Never changes user data or other plugins.
import { readFileSync, existsSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'customizations/black-hole');
const profile = join(root, 'Data/DSH/profiles/web');
const target = join(profile, 'local/dsh-black-hole');
const files = ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js', 'lib/client.js', 'lib/core.js', 'lib/portable-store.js'];
const install = process.argv.includes('--install');
if (process.argv.slice(2).some(arg => !['--check', '--install'].includes(arg))) throw new Error('Usage: node scripts/sync-black-hole.mjs [--check|--install]');
if (!existsSync(join(profile, 'package.json'))) throw new Error('Missing portable Web Profile; see customizations/black-hole/README.md');
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
if (manifest.dependencies?.['dsh-black-hole']?.replaceAll('\\', '/') !== 'link:local/dsh-black-hole') throw new Error('Expected existing link:local/dsh-black-hole dependency; no manifest overwritten');
if (!manifest.dsh?.profile?.bundles?.includes('dsh-black-hole')) throw new Error('Black hole bundle is not enabled');
if (realpathSync(join(profile, 'node_modules/dsh-black-hole')).toLowerCase() !== realpathSync(target).toLowerCase()) throw new Error('Profile link points to a different package');
const normalize = value => value.replace(/\r\n/g, '\n').trimEnd();
const changed = files.filter(file => !existsSync(join(target, file)) || normalize(readFileSync(join(source, file), 'utf8')) !== normalize(readFileSync(join(target, file), 'utf8')));
if (install && changed.length) {
  const backup = join(root, 'artifacts', 'black-hole-backup-' + Date.now());
  for (const file of changed) {
    if (existsSync(join(target, file))) { mkdirSync(dirname(join(backup, file)), { recursive: true }); copyFileSync(join(target, file), join(backup, file)); }
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(source, file), join(target, file));
  }
  console.log(`Installed ${changed.length} files. Previous plugin files: ${backup}`);
} else if (changed.length) {
  console.error('Source/runtime drift:', changed.join(', ')); process.exitCode = 1;
} else console.log('Black hole source, installed package and Profile link match. User data unchanged.');
