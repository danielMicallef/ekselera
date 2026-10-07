// Binding shapes come from `wrangler types`; deployed variables and secrets vary by environment.
type RuntimeEnv = Omit<
  Env,
  "ENVIRONMENT" | "PUBLISHING_PAUSED" | "DELIVERY_PAUSED" | "SITES_JSON"
> & {
  ENVIRONMENT: "staging" | "production";
  PUBLISHING_PAUSED: string;
  DELIVERY_PAUSED: string;
  SITES_JSON: string;
  AUTHORS_JSON: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  RESEND_API_KEY: string;
  RESEND_WEBHOOK_SECRET: string;
  CI_CALLBACK_SECRET: string;
  STAGING_RECIPIENTS_JSON: string;
};
