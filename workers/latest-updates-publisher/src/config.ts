export interface Site {
  id: string;
  name: string;
  recipient: string;
  origin: string;
  serviceOrigin: string;
  repository: string;
  branch: string;
  contentPrefix: string;
  mediaPrefix: string;
  pagesProject: string;
  trackingIssue: number;
  installationId: number;
  segmentId: string;
  topicId: string;
  sender: string;
  postalAddress: string;
  accent: string;
  background: string;
}
export interface Author {
  id: string;
  email: string;
  name: string;
  sites: string[];
}
export function sites(env: RuntimeEnv): Site[] {
  const result: Site[] = JSON.parse(env.SITES_JSON);
  if (!Array.isArray(result)) throw new Error("Invalid site configuration");
  const hosts = new Set<string>();
  for (const site of result) {
    const host = new URL(site.serviceOrigin).host;
    if (
      hosts.has(host) ||
      !site.contentPrefix.endsWith("/") ||
      !site.mediaPrefix.endsWith("/") ||
      site.contentPrefix.includes("..") ||
      site.mediaPrefix.includes("..")
    )
      throw new Error("Invalid site configuration");
    hosts.add(host);
    if (
      env.ENVIRONMENT === "staging" &&
      (site.branch === "main" ||
        site.origin === "https://ekselera.com" ||
        site.origin === "https://ziffa.io")
    )
      throw new Error("Staging may not target production");
  }
  return result;
}
export function authors(env: RuntimeEnv): Author[] {
  return JSON.parse(env.AUTHORS_JSON || "[]");
}
export function authorFor(env: RuntimeEnv, site: Site, email: string) {
  return authors(env).find(
    (a) =>
      a.email.toLowerCase() === email.toLowerCase() &&
      a.sites.includes(site.id),
  );
}
export function ready(site: Site) {
  if (
    !site.installationId ||
    !site.trackingIssue ||
    !site.segmentId ||
    !site.topicId ||
    !site.sender ||
    !site.postalAddress
  )
    throw new Error("Site setup incomplete");
}

export function ensureTestRecipient(env: RuntimeEnv, email: string) {
  if (
    env.ENVIRONMENT === "staging" &&
    !(JSON.parse(env.STAGING_RECIPIENTS_JSON || "[]") as string[]).includes(
      email,
    )
  )
    throw new Error("staging_recipient_not_allowed");
}
