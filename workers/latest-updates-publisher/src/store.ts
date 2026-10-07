import type { Draft } from "./content";
export interface Job {
  id: string;
  site: string;
  author: string;
  input_digest: string;
  digest: string;
  token_hash: string;
  state: string;
  draft: string;
  expires: number;
  created: number;
  updated: number;
  published_at: string | null;
  branch: string | null;
  pr: number | null;
  head: string | null;
  base: string | null;
  merged_sha: string | null;
  error_code: string | null;
  retry_count: number;
  cleaned_at: number | null;
  broadcast_id: string | null;
  notification_state: string;
  lease_until: number;
}
export function draftOf(job: Job): Draft {
  return JSON.parse(job.draft);
}
export async function jobById(env: RuntimeEnv, id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(id).first<Job>();
}
export async function updateJob(
  env: RuntimeEnv,
  id: string,
  values: Partial<Job> & { error_code?: string },
) {
  const fields = Object.entries({ ...values, updated: Date.now() });
  await env.DB.prepare(
    `UPDATE jobs SET ${fields.map(([key]) => `${key}=?`).join(",")} WHERE id=?`,
  )
    .bind(...fields.map(([, value]) => value), id)
    .run();
}
export async function enqueue(env: RuntimeEnv, job: Job) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO outbox(id,kind,job_id,created) VALUES (?,'advance',?,?)",
  )
    .bind(`advance:${job.id}`, job.id, Date.now())
    .run();
  await env.JOBS.send({ id: job.id });
}
export async function lock(env: RuntimeEnv, id: string) {
  const row = await env.DB.prepare(
    "UPDATE jobs SET lease_until=? WHERE id=? AND lease_until<? RETURNING id",
  )
    .bind(Date.now() + 180000, id, Date.now())
    .first();
  return !!row;
}
