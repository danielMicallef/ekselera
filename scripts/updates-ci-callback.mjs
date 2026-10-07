import { createHmac } from "node:crypto";
const {
  CI_CALLBACK_SECRET,
  PUBLISHING_SERVICE_ORIGIN,
  UPDATES_JOB_ID,
  GITHUB_RUN_ID,
  GITHUB_RUN_ATTEMPT,
} = process.env;
if (!CI_CALLBACK_SECRET || !PUBLISHING_SERVICE_ORIGIN || !UPDATES_JOB_ID)
  process.exit(0); // Reconciliation also discovers completed CI runs.
const body = JSON.stringify({
  eventId: `${GITHUB_RUN_ID}:${GITHUB_RUN_ATTEMPT}`,
  jobId: UPDATES_JOB_ID,
});
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", CI_CALLBACK_SECRET)
  .update(`${timestamp}.${body}`)
  .digest("hex");
const response = await fetch(`${PUBLISHING_SERVICE_ORIGIN}/callbacks/ci`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-publishing-timestamp": timestamp,
    "x-publishing-signature": signature,
  },
  body,
});
if (!response.ok) throw new Error("CI callback rejected");
