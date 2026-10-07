import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');
const srcManifest = join(rootDir, 'public', 'manifest.json');
const publicDir = join(rootDir, 'public');
const distDir = join(rootDir, 'dist');
const nativeHostDir = join(rootDir, 'native_host');
const nativeHostDistDir = join(distDir, 'native-host');

if (!existsSync(srcManifest)) {
  throw new Error('Missing public/manifest.json for Chrome extension build');
}

mkdirSync(distDir, { recursive: true });
copyFileSync(srcManifest, join(distDir, 'manifest.json'));

for (const page of ['popup.html', 'offscreen.html']) {
  if (!existsSync(join(distDir, page))) {
    throw new Error(`Vite did not generate ${page}`);
  }
}

await build({
  entryPoints: [join(rootDir, 'src', 'background', 'serviceWorker.ts')],
  outfile: join(distDir, 'background.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  sourcemap: false,
  logLevel: 'info',
});

await build({
  entryPoints: [join(rootDir, 'src', 'content', 'index.ts')],
  outfile: join(distDir, 'content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome116'],
  sourcemap: false,
  logLevel: 'info',
});

mkdirSync(nativeHostDistDir, { recursive: true });
for (const file of ['local_security_agent.py', 'local_evidence_store.py', 'requirements-agent.txt']) {
  const source = join(rootDir, file);
  if (!existsSync(source)) throw new Error(`Missing ${file} for local security agent package`);
  copyFileSync(source, join(nativeHostDistDir, file));
}
for (const file of ['install_native_host.ps1', 'uninstall_native_host.ps1', 'com.look_at_me.security.json.template']) {
  const source = join(nativeHostDir, file);
  if (!existsSync(source)) throw new Error(`Missing native_host/${file}`);
  copyFileSync(source, join(nativeHostDistDir, file));
}
copyFileSync(join(rootDir, 'setup_windows.ps1'), join(distDir, 'setup_windows.ps1'));

console.log('Copied extension assets and local security host package to dist/');
