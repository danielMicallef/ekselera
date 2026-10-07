export async function digest(data: string | Uint8Array) {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function signedCallback(
  request: Request,
  secret: string,
  body: string,
) {
  const timestamp = request.headers.get("x-publishing-timestamp") || "";
  const signature = request.headers.get("x-publishing-signature") || "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !secret
  )
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature.match(/../g)!, (h) => parseInt(h, 16)),
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
}
export function sameOrigin(request: Request, origin: string) {
  return request.headers.get("origin") === origin;
}
export async function rateLimit(env: RuntimeEnv, key: string, maximum: number) {
  const now = Date.now();
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(key,count,expires) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<? THEN excluded.expires ELSE expires END RETURNING count",
  )
    .bind(key, now + 3600000, now, now)
    .first<{ count: number }>();
  return !!row && row.count <= maximum;
}
