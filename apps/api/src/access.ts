import type { Clock } from "@ai-moves/contracts/ports/runtime";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const subject = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const issuer = z.string().regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/);
const audience = z.string().trim().min(1).max(128);
const publicKeys = z.object({
  keys: z
    .array(
      z.object({
        kty: z.literal("RSA"),
        alg: z.literal("RS256"),
        use: z.literal("sig"),
        kid: z.string().min(1).max(128),
        n: z.string().regex(/^[A-Za-z0-9_-]+$/),
        e: z.string().regex(/^[A-Za-z0-9_-]+$/),
      }),
    )
    .min(1)
    .max(10),
});

export interface AccessSettings {
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly ACCESS_JWKS?: string;
  readonly ACCESS_ADMIN_SUBJECTS?: string;
}

export interface Identity {
  readonly actor: string;
  readonly admin: boolean;
}

export type VerifyAccess = (assertion: string | undefined) => Promise<Identity | null>;

function readJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function createAccessVerifier(settings: AccessSettings, clock: Clock): VerifyAccess {
  const team = issuer.safeParse(settings.ACCESS_ISSUER);
  const application = audience.safeParse(settings.ACCESS_AUDIENCE);
  const keys = publicKeys.safeParse(readJson(settings.ACCESS_JWKS));
  const admins = z.array(subject).safeParse(readJson(settings.ACCESS_ADMIN_SUBJECTS ?? "[]"));
  if (!team.success || !application.success || !keys.success || !admins.success) {
    return async () => null;
  }

  const resolveKey = createLocalJWKSet(keys.data);
  const adminSubjects = new Set(admins.data);
  return async (assertion) => {
    if (!assertion || assertion.length > 16_384) return null;
    try {
      const { payload, protectedHeader } = await jwtVerify(assertion, resolveKey, {
        algorithms: ["RS256"],
        issuer: team.data,
        audience: application.data,
        requiredClaims: ["exp", "sub"],
        currentDate: new Date(clock.now()),
      });
      const actor = subject.safeParse(payload.sub);
      if (!protectedHeader.kid || payload["type"] !== "app" || !actor.success) return null;
      return { actor: actor.data, admin: adminSubjects.has(actor.data) };
    } catch {
      return null;
    }
  };
}
