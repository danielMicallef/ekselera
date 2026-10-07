import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const apply = process.argv.includes("--apply");
const run = (args: string[]) =>
  execFileSync("bunx", ["wrangler", ...args], { encoding: "utf8" });
const databases = JSON.parse(run(["d1", "list", "--json"])) as {
  name: string;
  uuid: string;
}[];
const buckets = run(["r2", "bucket", "list", "--jurisdiction", "eu"]);
const queues = run(["queues", "list"]);
const resourcePath = "workers/latest-updates-publisher/resources.json";
let recorded: Record<string, Record<string, unknown>> = {};
try {
  recorded = JSON.parse(readFileSync(resourcePath, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const resources: Record<string, unknown> = {};
for (const environment of ["staging", "production"]) {
  const database = `latest-updates-${environment}`,
    bucket = `latest-updates-drafts-${environment}`;
  const found = databases.find((db) => db.name === database);
  if (!found) {
    console.log(`Create D1 ${database}`);
    if (apply) run(["d1", "create", database, "--jurisdiction", "eu"]);
  }
  if (
    !buckets.includes(`name:           ${bucket}\n`) &&
    !new RegExp(`name:\\s+${bucket}(?:\\s|$)`).test(buckets)
  ) {
    console.log(`Create private EU R2 ${bucket}`);
    if (apply) run(["r2", "bucket", "create", bucket, "--jurisdiction", "eu"]);
  }
  for (const queue of [database, `${database}-dlq`])
    if (!new RegExp(`\\b${queue}\\s`).test(queues)) {
      console.log(`Create Queue ${queue}`);
      if (apply) run(["queues", "create", queue]);
    }
  resources[environment] = {
    ...recorded[environment],
    database: found?.uuid || "pending",
    databaseName: database,
    bucket,
    jurisdiction: "eu",
    queue: database,
    deadLetterQueue: `${database}-dlq`,
  };
}
if (apply) {
  const latest = JSON.parse(run(["d1", "list", "--json"])) as {
    name: string;
    uuid: string;
  }[];
  let config = readFileSync(
    "workers/latest-updates-publisher/wrangler.jsonc",
    "utf8",
  );
  for (const environment of ["staging", "production"]) {
    const id = latest.find(
      (db) => db.name === `latest-updates-${environment}`,
    )!.uuid;
    (resources[environment] as any).database = id;
    const expression = new RegExp(
      `("database_name": "latest-updates-${environment}", "database_id": ")[^"]+`,
    );
    config = config.replace(expression, `$1${id}`);
  }
  writeFileSync("workers/latest-updates-publisher/wrangler.jsonc", config);
  writeFileSync(resourcePath, JSON.stringify(resources, null, 2) + "\n");
}
console.log(JSON.stringify(resources, null, 2));
