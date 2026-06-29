/** Request authentication: Linear webhook signatures and bearer-secret guards. */
import crypto from "node:crypto";
import {
  cronSecret,
  datadogWebhookSecret,
  triggerSecret,
  vercelWebhookSecret,
  webhookSecret,
} from "./config.js";

/**
 * Minimal request shape these guards need. Avoids importing express's types,
 * which resolve inconsistently in the @vercel/node builder.
 */
interface AuthRequest {
  get(name: string): string | undefined;
  query?: Record<string, unknown>;
}

/** Verifies a Linear webhook HMAC-SHA256 signature against the raw request body. */
export function verifyLinearSignature(rawBody: Buffer, signature: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(digest, "hex");
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function bearerToken(req: AuthRequest): string | undefined {
  return req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

/** Authorizes the manual `/api/trigger` fallback via the bridge trigger secret. */
export function isAuthorizedTrigger(req: AuthRequest): boolean {
  const secret = triggerSecret();
  if (!secret) return false;
  return bearerToken(req) === secret || req.get("x-bridge-trigger-secret") === secret;
}

/**
 * Authorizes `/api/reconcile`. Accepts Vercel Cron's injected `CRON_SECRET`
 * bearer token, or the bridge trigger secret for manual/curl invocation.
 */
export function isAuthorizedReconcile(req: AuthRequest): boolean {
  const bearer = bearerToken(req);
  const cron = cronSecret();
  if (cron && bearer === cron) return true;
  const secret = triggerSecret();
  if (!secret) return false;
  return bearer === secret || req.get("x-bridge-trigger-secret") === secret;
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Shared-secret guard for inbound service webhooks (Vercel, Datadog). The secret
 * is supplied either as a `?secret=` query param (simplest for webhook URLs) or
 * an `x-conductor-secret` header. Both providers support custom URLs/headers.
 */
function isAuthorizedWebhook(req: AuthRequest, expected: string): boolean {
  if (!expected) return false;
  const fromQuery = typeof req.query?.secret === "string" ? (req.query.secret as string) : "";
  const fromHeader = req.get("x-conductor-secret") ?? "";
  return (fromQuery !== "" && safeEqual(fromQuery, expected)) || (fromHeader !== "" && safeEqual(fromHeader, expected));
}

/** Authorizes the Vercel deployment webhook (`/webhook/vercel`). */
export function isAuthorizedVercel(req: AuthRequest): boolean {
  return isAuthorizedWebhook(req, vercelWebhookSecret());
}

/** Authorizes the Datadog monitor webhook (`/webhook/datadog`). */
export function isAuthorizedDatadog(req: AuthRequest): boolean {
  return isAuthorizedWebhook(req, datadogWebhookSecret());
}
