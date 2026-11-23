// EdgeOne copies dist/standalone verbatim when its server.js already exists.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

execFileSync(process.execPath, ['scripts/run-framework.mjs', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, KAPOK_MAKERS_PREVIEW: '1' },
});

const root = process.cwd();
const standalone = path.join(root, 'dist/standalone');
if (!existsSync(path.join(standalone, 'server.js'))) {
  const emitter = path.join(root, 'node_modules/vinext/dist/build/standalone.js');
  const { emitStandaloneOutput } = await import(pathToFileURL(emitter).href);
  await emitStandaloneOutput({ root, outDir: path.join(root, 'dist') });
}

const require = createRequire(import.meta.url);
for (const name of ['react', 'react-dom', 'scheduler']) {
  const source = path.dirname(require.resolve(name + '/package.json'));
  cpSync(source, path.join(standalone, 'node_modules', name), { recursive: true, dereference: true });
}

// Resolve from Vinext's deployed location. Ancestor node_modules can hide an
// incomplete artifact during a build, so require the resolved file to be local.
const fromVinext = createRequire(path.join(standalone, 'node_modules/vinext/dist/server/app-elements-wire.js'));
for (const name of ['react', 'react-dom/server', 'scheduler']) {
  if (!fromVinext.resolve(name).startsWith(standalone + path.sep)) {
    throw new Error('Missing standalone runtime dependency: ' + name);
  }
}
console.log('[makers] Verified React runtime in dist/standalone');
