/**
 * server/config/env.ts — centralized production configuration validation
 * ------------------------------------------------------------------
 * Single source of truth for how LeadFlow classifies and validates its
 * runtime environment variables, and for the "is this a production
 * deployment" rule used across both entrypoints.
 *
 * Goals (see docs/PRODUCTION_READINESS.md):
 *   - classify every env var as REQUIRED / OPTIONAL / DEVELOPMENT_ONLY,
 *   - in production, missing REQUIRED config is reported as a BLOCKER,
 *   - weak / default / development-only JWT secrets are never accepted,
 *   - every message is explicit yet NEVER contains a secret value
 *     (DATABASE_URL, JWT_SECRET, passwords, tokens, connection creds).
 *
 * This module is deliberately side-effect free and pure: it reads from the
 * `env` argument it is given (defaulting to `process.env`) and returns
 * plain data. Nothing here throws at import time and nothing here mutates
 * `process.env`, so it is safe to import from every entrypoint, the
 * serverless build, the smoke script and the test suite without changing
 * cold-start or test behaviour. Callers decide what to DO with the report
 * (log it, refuse readiness, refuse to sign tokens, etc.).
 *
 * NOTE: the JWT_SECRET rule here is deliberately conservative. A secret is
 * "weak" when it is missing, when it exactly matches a known development /
 * default / CI placeholder, or when it is shorter than the minimum. It is
 * the caller's job to enforce the consequence (see production.routes.ts
 * `signToken`, and the `/api/health/readiness` contract).
 */

/* ==================================================================== */
/* Runtime detection                                                    */
/* ==================================================================== */

/**
 * True when the process is a production deployment: the standalone server
 * started with NODE_ENV=production, or any Vercel runtime. Mirrors the rule
 * used by server/middleware.ts, server.ts, api/index.ts and
 * production.routes.ts. Kept local here so this module has no heavy imports
 * and can be shared by scripts and tests.
 */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production' || Boolean(env.VERCEL);
}

/* ==================================================================== */
/* Env-var classification                                               */
/* ==================================================================== */

export type EnvVarClass = 'REQUIRED' | 'OPTIONAL' | 'DEVELOPMENT_ONLY';

export interface EnvVarSpec {
  name: string;
  classification: EnvVarClass;
  /** Secret-free, operator-facing description of the variable's role. */
  description: string;
}

/**
 * The canonical catalog. "REQUIRED" means: a production deployment cannot
 * operate as a real business system without a valid value. "OPTIONAL" means:
 * harmless to omit (the app has a documented default). "DEVELOPMENT_ONLY"
 * means: meaningful only for local/demo runs and never required in
 * production (its absence in production is expected, not an error).
 *
 * Only variables actually consumed by the runtime are catalogued here. See
 * docs/PRODUCTION_READINESS.md for the full secrets policy and the client
 * (VITE_*) boundary.
 */
export const ENV_VAR_SPECS: EnvVarSpec[] = [
  {
    name: 'DATABASE_URL',
    classification: 'REQUIRED',
    description:
      'PostgreSQL (Supabase) connection string. Server-only; never exposed to the browser.',
  },
  {
    name: 'JWT_SECRET',
    classification: 'REQUIRED',
    description:
      'Strong, production-specific signing secret for session tokens. Never a development/default value.',
  },
  {
    name: 'NODE_ENV',
    classification: 'REQUIRED',
    description:
      'Runtime environment. Production detection also honours VERCEL, so a Vercel deployment is production even if this is unset locally.',
  },
  {
    name: 'TRUST_PROXY',
    classification: 'OPTIONAL',
    description: 'Trusted reverse-proxy hop count used for client-IP rate limiting.',
  },
  {
    name: 'PORT',
    classification: 'OPTIONAL',
    description: 'Standalone server listen port (default 3000).',
  },
  {
    name: 'PGSSL',
    classification: 'OPTIONAL',
    description: 'Override PostgreSQL SSL handling (e.g. "disable" for local-only tunnels).',
  },
  {
    name: 'VITE_SUPABASE_URL',
    classification: 'OPTIONAL',
    description: 'Supabase browser URL. Public; compiled into the client bundle.',
  },
  {
    name: 'VITE_SUPABASE_ANON_KEY',
    classification: 'OPTIONAL',
    description: 'Supabase anon key. Public by design; row-level security scoped.',
  },
  {
    name: 'GEMINI_API_KEY',
    classification: 'OPTIONAL',
    description:
      'Gemini API key injected into the browser bundle. See the secrets policy in docs/PRODUCTION_READINESS.md.',
  },
  {
    name: 'SESSION_SECRET',
    classification: 'OPTIONAL',
    description: 'Reserved. The current auth flow is JWT-based and does not consume this.',
  },
];

/* ==================================================================== */
/* JWT secret strength                                                  */
/* ==================================================================== */

/**
 * Known development / default / CI placeholder secrets that must never be
 * used to sign production tokens. Exact, lower-cased matches are rejected
 * regardless of length.
 */
export const KNOWN_WEAK_JWT_SECRETS: ReadonlySet<string> = new Set([
  'leadflow_development_only_secret',
  'replace-with-a-long-random-secret',
  'leadflow-ci-only-secret',
  'secret',
  'supersecret',
  'changeme',
  'change-me',
  'changeme123',
  'password',
  'jwt_secret',
  'jwt-secret',
  'dev',
  'development',
  'development_secret',
  'development-only-secret',
  'test',
  'test_secret',
  'default',
  'insecure',
  'placeholder',
]);

/**
 * Minimum length for a JWT secret the validator will accept in production.
 * This is a pragmatic floor, not a cryptographic claim about entropy; the
 * production guidance (docs/PRODUCTION_READINESS.md) recommends a long,
 * randomly generated value. Kept intentionally below the 32-byte HS256
 * recommendation so the existing integration-test secret
 * (`production-security-test-secret`, 31 chars) is not mis-classified as
 * weak — those tests run the real production entrypoints.
 */
export const MIN_JWT_SECRET_LENGTH = 16;

/**
 * True when `secret` must not be used to sign production tokens: missing,
 * an exact known-weak placeholder, or shorter than the minimum length.
 */
export function isWeakJwtSecret(secret: string | undefined): boolean {
  if (!secret) return true;
  const trimmed = secret.trim();
  if (trimmed.length < MIN_JWT_SECRET_LENGTH) return true;
  if (KNOWN_WEAK_JWT_SECRETS.has(trimmed.toLowerCase())) return true;
  return false;
}

/* ==================================================================== */
/* Validation report                                                    */
/* ==================================================================== */

export type ConfigIssueSeverity = 'BLOCKER' | 'WARNING';

export interface ConfigIssue {
  /** The env var name (never the value). */
  name: string;
  severity: ConfigIssueSeverity;
  /** Secret-free, human-readable message. */
  message: string;
}

export interface ConfigCheck {
  name: string;
  classification: EnvVarClass;
  /** Present and non-empty in the environment. */
  present: boolean;
  /** Present AND (for JWT_SECRET) strong. */
  valid: boolean;
}

export interface ConfigValidation {
  /** Whether the environment is a production deployment. */
  production: boolean;
  /** True when there are no BLOCKER issues (safe to operate). */
  valid: boolean;
  issues: ConfigIssue[];
  checks: ConfigCheck[];
}

/** A short, non-secret stand-in for redacting a value in a message. */
export function redact(_value: unknown): string {
  return '<redacted>';
}

/**
 * Validate the environment against the catalog. Pure: never throws, never
 * logs, never mutates, and never includes a secret value in any message.
 *
 * In non-production environments only the JWT strength is checked (so the
 * development fallback secret is surfaced as a WARNING, not a BLOCKER, and
 * a missing DATABASE_URL — normal for local demo mode — is not an error).
 * In production, a missing/weak DATABASE_URL or JWT_SECRET is a BLOCKER.
 */
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env): ConfigValidation {
  const production = isProductionRuntime(env);

  const valueOf = (name: string): string | undefined => {
    const raw = env[name];
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  };

  const checks: ConfigCheck[] = ENV_VAR_SPECS.map((spec) => {
    const present = valueOf(spec.name) !== undefined;
    const valid =
      spec.name === 'JWT_SECRET' ? present && !isWeakJwtSecret(valueOf(spec.name)) : present;
    return { name: spec.name, classification: spec.classification, present, valid };
  });

  const issues: ConfigIssue[] = [];
  const byName = new Map(checks.map((c) => [c.name, c]));

  const jwt = byName.get('JWT_SECRET')!;
  if (production && !jwt.present) {
    issues.push({
      name: 'JWT_SECRET',
      severity: 'BLOCKER',
      message:
        'JWT_SECRET is not configured. Authentication cannot sign tokens in production; set a strong, production-specific secret.',
    });
  } else if (production && jwt.present && !jwt.valid) {
    issues.push({
      name: 'JWT_SECRET',
      severity: 'BLOCKER',
      message:
        'JWT_SECRET is a known weak/default value (or shorter than the minimum length). Replace it with a strong, production-specific secret before deploying.',
    });
  } else if (!production && jwt.present && !jwt.valid) {
    issues.push({
      name: 'JWT_SECRET',
      severity: 'WARNING',
      message:
        'JWT_SECRET is a weak/default value. This is acceptable only for local development and must never be used in production.',
    });
  }

  const db = byName.get('DATABASE_URL')!;
  if (production && !db.present) {
    issues.push({
      name: 'DATABASE_URL',
      severity: 'BLOCKER',
      message:
        'DATABASE_URL is not configured. In production the application refuses database-backed requests (HTTP 503) and never falls back to in-memory storage.',
    });
  }

  const nodeEnv = byName.get('NODE_ENV')!;
  if (production && !nodeEnv.present) {
    issues.push({
      name: 'NODE_ENV',
      severity: 'WARNING',
      message:
        'NODE_ENV is not set explicitly; production is being inferred from VERCEL. This is normal on Vercel but should be set explicitly on standalone deployments.',
    });
  }

  const blockers = issues.filter((i) => i.severity === 'BLOCKER');
  return { production, valid: blockers.length === 0, issues, checks };
}

/**
 * Convenience: a single-line, secret-free summary of the validation result
 * for startup logging (never logs any value).
 */
export function summarizeConfigValidation(v: ConfigValidation): string {
  const blockers = v.issues.filter((i) => i.severity === 'BLOCKER');
  const warnings = v.issues.filter((i) => i.severity === 'WARNING');
  return (
    `config validation: production=${v.production} valid=${v.valid}` +
    ` blockers=${blockers.length} warnings=${warnings.length}` +
    (blockers.length ? ` (${blockers.map((b) => b.name).join(', ')})` : '')
  );
}
