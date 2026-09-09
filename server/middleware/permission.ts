import { Response, NextFunction } from "express";

import { AuthRequest } from "./auth.js";
import { query } from "../database/connection.js";

export function requireRole(...allowedRoles: string[]) {

    return (

        req: AuthRequest,

        res: Response,

        next: NextFunction

    ): void => {

        if (!req.currentUser) {

            res.status(401).json({

                success: false,

                message: "Unauthorized."

            });

            return;

        }

        const userRole =
            req.currentUser.roleCode.toUpperCase();

        const allowed =
            allowedRoles.map(
                role => role.toUpperCase()
            );

        if (!allowed.includes(userRole)) {

            res.status(403).json({

                success: false,

                message: "Permission denied."

            });

            return;

        }

        next();

    };

}

export function requireAdmin(

    req: AuthRequest,

    res: Response,

    next: NextFunction

): void {

    if (!req.currentUser) {

        res.status(401).json({

            success: false,

            message: "Unauthorized."

        });

        return;

    }

    if (
        req.currentUser.roleCode.toUpperCase() !== "ADMIN"
    ) {

        res.status(403).json({

            success: false,

            message: "Admin permission required."

        });

        return;

    }

    next();

}

export function requireManager(

    req: AuthRequest,

    res: Response,

    next: NextFunction

): void {

    if (!req.currentUser) {

        res.status(401).json({

            success: false,

            message: "Unauthorized."

        });

        return;

    }

    const managerRoles = [

        "ADMIN",

        "GM",

        "DGM",

        "AGM",

        "SM",

        "BM"

    ];

    if (

        !managerRoles.includes(

            req.currentUser.roleCode.toUpperCase()

        )

    ) {

        res.status(403).json({

            success: false,

            message: "Manager permission required."

        });

        return;

    }

    next();

}

export function requirePermission(permissionCode: string) {

    return async (

        req: AuthRequest,

        res: Response,

        next: NextFunction

    ): Promise<void> => {

        if (!req.currentUser) {

            res.status(401).json({

                success: false,

                message: "Unauthorized."

            });

            return;

        }

        try {

            const result = await query<{ allowed: boolean }>(
                `
                SELECT COALESCE(
                    up.is_allowed,
                    rp.is_allowed,
                    FALSE
                ) AS allowed
                FROM users u
                INNER JOIN permissions p
                    ON p.permission_code = $1
                   AND p.is_active = TRUE
                LEFT JOIN role_permissions rp
                    ON rp.role_id = u.role_id
                   AND rp.permission_id = p.id
                LEFT JOIN user_permissions up
                    ON up.user_id = u.id
                   AND up.permission_id = p.id
                WHERE u.id = $2
                  AND COALESCE(u.is_active, TRUE) = TRUE
                LIMIT 1
                `,
                [permissionCode, req.currentUser.id]
            );

            if (!result.rows[0]?.allowed) {

                res.status(403).json({

                    success: false,

                    message: "Permission denied.",

                    permission: permissionCode

                });

                return;

            }

            next();

        } catch (error) {

            console.error("Permission check failed:", error);

            res.status(503).json({

                success: false,

                message: "Authorization service unavailable."

            });

        }

    };

}