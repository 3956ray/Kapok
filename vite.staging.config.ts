import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import { stagingWorkerConfig } from "./build/staging-wrangler";

const outDir = "dist/staging";

export default defineConfig(({ command, mode }) => {
  if (command !== "build" || mode !== "staging" ||
      process.env.CLOUDFLARE_ENV || process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH) {
    throw new Error("The standalone configuration supports only the staging build.");
  }

  return {
    build: { outDir },
    environments: {
      client: {
        build: {
          outDir: `${outDir}/client`,
          rolldownOptions: { preserveEntrySignatures: "strict" },
        },
      },
      rsc: { build: { outDir: `${outDir}/server` } },
      ssr: { build: { outDir: `${outDir}/server/ssr` } },
    },
    plugins: [
      vinext({
        clientOutDir: `${outDir}/client`,
        rscOutDir: `${outDir}/server`,
        ssrOutDir: `${outDir}/server/ssr`,
      }),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: stagingWorkerConfig,
      }),
    ],
  };
});
