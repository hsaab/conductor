/** Request authentication: Linear webhook signatures and bearer-secret guards. */
import crypto from "node:crypto";
import { cronSecret, triggerSecret, webhookSecret } from "./config.js";

/**
 * Minimal request shape these guards need. Avoids importing express's types,
 * which resolve inconsistently in the @vercel/node builder.
 */
interface AuthRequest {
  get(name: string): string | undefined;
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
