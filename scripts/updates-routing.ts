import { writeFileSync } from "node:fs";
const apply = process.argv.includes("--apply"),
  staging = process.argv.includes("--staging"),
  token = process.env.CLOUDFLARE_API_TOKEN;
if (!token)
  throw new Error(
    "Set CLOUDFLARE_API_TOKEN securely; DNS and Email Routing write permissions are required.",
  );
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as any;
  if (!response.ok || !result.success)
    throw new Error(
      `Cloudflare operation rejected (${response.status}) at ${path}`,
    );
  return result.result;
}
const records: any[] = [];
for (const domain of ["ekselera.com", "ziffa.io"]) {
  const zones = await api(`zones?name=${domain}`);
  if (zones.length !== 1) throw new Error(`Expected one zone: ${domain}`);
  const zone = zones[0].id,
    subdomain = `publish.${domain}`,
    recipient = `${staging ? "staging-post" : "post"}@${subdomain}`;
  const apexBefore = await api(
    `zones/${zone}/dns_records?type=MX&name=${domain}`,
  );
  const mx = await api(`zones/${zone}/dns_records?type=MX&name=${subdomain}`);
  if (!mx.length) {
    console.log(`Enable Email Routing DNS only for ${subdomain}`);
    if (apply)
      await api(`zones/${zone}/email/routing/dns`, "POST", { name: subdomain });
  }
  const rules: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await api(
      `zones/${zone}/email/routing/rules?per_page=50&page=${page}`,
    );
    rules.push(...batch);
    if (batch.length < 50) break;
    if (page === 100) throw new Error("Routing pagination limit");
  }
  const matches = rules.filter((rule) =>
    rule.matchers?.some(
      (m: any) =>
        m.type === "literal" &&
        m.field === "to" &&
        m.value.toLowerCase() === recipient,
    ),
  );
  if (matches.length > 1)
    throw new Error(`Duplicate exact routing rules for ${recipient}`);
  const worker = `latest-updates-publisher-${staging ? "staging" : "production"}`;
  if (
    matches[0] &&
    (!matches[0].enabled ||
      matches[0].actions?.length !== 1 ||
      matches[0].actions[0].type !== "worker" ||
      matches[0].actions[0].value?.[0] !== worker)
  )
    throw new Error(
      `Existing rule differs for ${recipient}; review before changing it`,
    );
  let rule = matches[0];
  if (!rule) {
    console.log(`Create exact ${recipient} → ${worker}`);
    if (apply)
      rule = await api(`zones/${zone}/email/routing/rules`, "POST", {
        name: `Latest Updates ${staging ? "staging " : ""}${domain}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: recipient }],
        actions: [{ type: "worker", value: [worker] }],
      });
  }
  const apexAfter = await api(
    `zones/${zone}/dns_records?type=MX&name=${domain}`,
  );
  const canonical = (items: any[]) =>
    JSON.stringify(
      items
        .map(({ name, content, priority }) => ({ name, content, priority }))
        .sort((a, b) => a.content.localeCompare(b.content)),
    );
  if (canonical(apexBefore) !== canonical(apexAfter))
    throw new Error("Apex mail records changed; stop and investigate");
  records.push({
    domain,
    zone,
    recipient,
    ruleId: rule?.id || rule?.tag || "pending",
  });
}
if (apply)
  writeFileSync(
    `workers/latest-updates-publisher/routing-resources${staging ? "-staging" : ""}.json`,
    JSON.stringify(records, null, 2) + "\n",
  );
