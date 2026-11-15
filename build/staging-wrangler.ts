import { readFileSync } from "node:fs";
import type { WorkerConfig } from "@cloudflare/vite-plugin";
import batch from "../lib/import/initial-batch.json" with { type: "json" };

const deployPath = process.env.KAPOK_DEPLOY_CONFIG_PATH;
const deploy = deployPath ? JSON.parse(readFileSync(deployPath, "utf8")) as {
  worker: string;
  accountId: string;
  host: string;
  databaseName: string;
  databaseId: string;
  accessIssuer: string;
  accessAudience: string;
  bucketName: string;
} : null;

if (deployPath && (!deploy || !/^[a-z0-9-]{1,63}$/.test(deploy.worker) ||
    !/^[a-f0-9]{32}$/.test(deploy.accountId) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(deploy.host) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(deploy.databaseName) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(deploy.databaseId) ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(deploy.accessIssuer) ||
    !/^[a-f0-9]{64}$/.test(deploy.accessAudience) ||
    typeof deploy.bucketName !== "string" ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(deploy.bucketName))) {
  throw new Error("KAPOK_DEPLOY_CONFIG_PATH must point to a valid deployment configuration.");
}
if (deploy && batch.status === "PUBLIC_TEST_FIXTURE") {
  throw new Error("Use the owner-approved video manifest in a private release checkout before building a deployment.");
}

const host = deploy?.host ?? "kapok.test";

export const stagingWorkerConfig = {
  name: deploy?.worker ?? "kapok-local",
  main: "./build/staging-worker.ts",
  ...(deploy ? { account_id: deploy.accountId } : {}),
  compatibility_date: "2026-05-22",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  routes: deploy ? [{ pattern: host, custom_domain: true }] : [],
  assets: { binding: "ASSETS", run_worker_first: true },
  r2_buckets: [{ binding: "BUCKET", bucket_name: deploy?.bucketName ?? "kapok-local-media" }],
  d1_databases: [{
    binding: "DB",
    database_name: deploy?.databaseName ?? "kapok-local",
    database_id: deploy?.databaseId ?? "00000000-0000-4000-8000-000000000001",
    migrations_dir: "../../../drizzle",
  }],
  vars: {
    ACCESS_ALLOWED_HOST: host,
    ACCESS_ISSUER: deploy?.accessIssuer ?? "https://kapok-test.cloudflareaccess.com",
    ACCESS_AUDIENCE: deploy?.accessAudience ?? "local-test-audience",
  },
} satisfies Partial<WorkerConfig>;
