import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === 'next/headers') return { url: new URL('./server-stubs.mjs', import.meta.url).href, shortCircuit: true };
        if (specifier.endsWith('/server/runtime')) return { url: new URL('./server-stubs.mjs', import.meta.url).href, shortCircuit: true };
        if (specifier === 'next/link' || specifier === 'next/navigation') return { url: new URL('./next-stubs.mjs', import.meta.url).href, shortCircuit: true };
        if (specifier.startsWith('.') && context.parentURL) {
            const url = new URL(specifier, context.parentURL);
            for (const suffix of ['', '.tsx', '.ts', '/index.ts']) {
                if (existsSync(fileURLToPath(url) + suffix) && /\.(?:tsx|ts)$/.test(url.pathname + suffix)) return { url: url.href + suffix, shortCircuit: true };
            }
        }
        return next(specifier, context);
    },
    load(url, context, next) {
        if (/\.(?:tsx|ts)$/.test(new URL(url).pathname)) {
            return { format: 'module', source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
            }).outputText, shortCircuit: true };
        }
        return next(url, context);
    }
});
