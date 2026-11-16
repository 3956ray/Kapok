import { mkdirSync, writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

export function isProgramChunk(file: string, modules: string[]): boolean {
  return /^_next\/static\/chunks\/[\w-]+-[\w-]{8}\.js$/.test(file) && modules.length > 0 &&
    modules.every(id => !/\.json(?:\?|$)|\/lib\/import\//.test(id));
}

// Generate from the actual client bundle, not a filename-only heuristic. An
// external server module is finalized after the client build (RSC builds first).
export function programAssetsPlugin(): Plugin {
  return {
    name: 'kapok-program-assets',
    resolveId(id) {
      if (id === 'virtual:kapok-program-assets') return { id: './program-assets.js', external: true };
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== 'client') return;
      const allowed: string[] = [];
      for (const [file, output] of Object.entries(bundle)) {
        if (output.type === 'chunk') {
          const modules = Object.keys(output.modules);
          // JSON and import manifests are data-bearing, even when merged into a
          // shared chunk. Unknown/empty provenance is denied by default.
          if (isProgramChunk(file, modules)) allowed.push('/' + file);
        }
        if (output.type === 'asset' && /^_next\/static\/css\/[\w-]+\.[\w-]{8}\.css$/.test(file)) allowed.push('/' + file);
      }
      mkdirSync('dist/staging/server', { recursive: true });
      writeFileSync('dist/staging/server/program-assets.js', `export const programAssets = new Set(${JSON.stringify(allowed.sort())});\n`);
    },
  };
}
