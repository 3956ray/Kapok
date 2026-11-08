import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";

if (process.argv.length !== 2) {
  throw new Error("build:staging takes no arguments.");
}

// The pinned Vinext and Cloudflare plugins emit these metadata files at fixed
// paths even with distinct output directories. Keep the Sites build and its
// implicit deploy target intact. The staging CLI always uses its explicit config.
const sharedMetadata = ["dist/server/BUILD_ID", ".wrangler/deploy/config.json"];
const saved = sharedMetadata.map(file => existsSync(file) ? readFileSync(file) : undefined);
try {
  const builder = await createBuilder({ configFile: "vite.staging.config.ts", mode: "staging" });
  await builder.buildApp();
} finally {
  for (const [index, file] of sharedMetadata.entries()) {
    if (saved[index] === undefined) {
      rmSync(file, { force: true });
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, saved[index]);
    }
  }
}
