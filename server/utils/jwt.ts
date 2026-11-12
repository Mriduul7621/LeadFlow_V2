import jwt from "jsonwebtoken";

const configuredSecret = process.env.JWT_SECRET;

if (!configuredSecret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be configured in production.");
}

const JWT_SECRET = configuredSecret || "leadflow_development_only_secret";

/**
 * Login/session token lifetime (audit A5, DZ-4).
 * ------------------------------------------------------------------
 * The lifetime used to be a hardcoded "7d" in two places at once:
 * here AND in server/routes/production/shared.ts signToken — and the
 * production login/bootstrap flows use the shared.ts copy, so this
 * file alone was never the live value. Both issuers now take the
 * same option and clamp through the same pure resolver.
 *
 * The effective value lives in the Danger Zone security policy
 * (server/services/SecurityPolicyService.ts): editable 1–30 days,
 * code default 7. A stored value outside 1–30 is clamped here, so
 * a bad stored value can never mint an absurd token. A new value
 * affects newly issued tokens only — a token already issued keeps
 * the expiry it was minted with.
 */
export const DEFAULT_TOKEN_LIFETIME_DAYS = 7;
export const TOKEN_LIFETIME_DAYS_MIN = 1;
export const TOKEN_LIFETIME_DAYS_MAX = 30;

/** Clamp any candidate lifetime into [1, 30] days; unusable input → 7. */
export function resolveTokenLifetimeDays(value?: unknown): number {
    const n = typeof value === 'number' ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return DEFAULT_TOKEN_LIFETIME_DAYS;
    return Math.min(TOKEN_LIFETIME_DAYS_MAX, Math.max(TOKEN_LIFETIME_DAYS_MIN, n));
}

export interface JwtPayload {

    id: string;

    employeeId: string;

    role?: string;

    roleId: string;

    roleCode: string;

    roleName: string;

    hierarchyLevel: number;

}

export function signToken(
    payload: JwtPayload,
    options?: { expiresInDays?: number }
): string {

    return jwt.sign(
        payload,
        JWT_SECRET,
        {
            expiresIn: `${resolveTokenLifetimeDays(options?.expiresInDays)}d`
        }
    );

}

export function verifyToken(
    token: string
): JwtPayload | null {

    try {

        return jwt.verify(
            token,
            JWT_SECRET
        ) as JwtPayload;

    } catch {

        return null;

    }

}
