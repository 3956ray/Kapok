// Run from the repository root as the Makers preview project's build command.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

execFileSync(process.execPath, ['scripts/run-framework.mjs', 'build'], { stdio: 'inherit' });

const manifest = 'dist/server/vinext-externals.json';
const externals = JSON.parse(readFileSync(manifest, 'utf8'));
// Vinext's Node server imports React even when application code bundled React.
const peers = ['react', 'react-dom', 'scheduler'];
writeFileSync(manifest, JSON.stringify([...new Set([...externals, ...peers])]) + '\n');

// Some builders emit standalone during the build, others package it afterward.
const standalone = 'dist/standalone';
if (existsSync(path.join(standalone, 'server.js'))) {
  const require = createRequire(import.meta.url);
  for (const name of peers) {
    const source = path.dirname(require.resolve(name + '/package.json'));
    cpSync(source, path.join(standalone, 'node_modules', name), { recursive: true });
  }
}
