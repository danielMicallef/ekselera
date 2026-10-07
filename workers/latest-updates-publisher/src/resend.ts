import { Resend } from "resend";

export function resendClient(env: RuntimeEnv) {
  const client = new Resend(env.RESEND_API_KEY);
  const request = client.fetchRequest.bind(client);
  client.fetchRequest = <T>(path: string, options = {}) =>
    request<T>(path, { ...options, signal: AbortSignal.timeout(15000) });
  return client;
}
