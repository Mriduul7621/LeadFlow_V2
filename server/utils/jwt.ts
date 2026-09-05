import jwt from "jsonwebtoken";

const configuredSecret = process.env.JWT_SECRET;

if (!configuredSecret && process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be configured in production.");
}

const JWT_SECRET = configuredSecret || "leadflow_development_only_secret";

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
    payload: JwtPayload
): string {

    return jwt.sign(
        payload,
        JWT_SECRET,
        {
            expiresIn: "7d"
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