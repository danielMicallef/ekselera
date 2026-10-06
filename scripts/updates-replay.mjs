// Replay only after inspecting GitHub/provider state. This never changes the ledger or clears ambiguous sends.
const id = process.argv[2];
if (!/^[a-f0-9-]{36}$/.test(id || ""))
  throw new Error("Supply the existing publication job UUID");
if (!process.argv.includes("--apply")) {
  console.log(
    `Would enqueue reconciliation for existing job ${id}. No publication or send state will be reset.`,
  );
  process.exit(0);
}
for (const name of ["CI_CALLBACK_SECRET", "PUBLISHING_SERVICE_ORIGIN"])
  if (!process.env[name])
    throw new Error(`Missing securely configured ${name}`);
process.env.UPDATES_JOB_ID = id;
process.env.GITHUB_RUN_ID = `manual-${crypto.randomUUID()}`;
process.env.GITHUB_RUN_ATTEMPT = "1";
await import("./updates-ci-callback.mjs");
console.log("The existing job was queued for reconciliation.");
