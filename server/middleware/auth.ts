import {
    Request,
    Response,
    NextFunction
} from "express";

import {
    verifyToken,
    JwtPayload
} from "../utils/jwt.js";

export interface AuthRequest
    extends Request {

    currentUser?: JwtPayload;

}

export function requireAuth(

    req: AuthRequest,

    res: Response,

    next: NextFunction

): void {

    const authHeader =
        req.headers.authorization;

    if (
        !authHeader ||
        !authHeader.startsWith(
            "Bearer "
        )
    ) {

        res.status(401).json({

            success: false,

            message:
                "Unauthorized."

        });

        return;

    }

    const token =
        authHeader.substring(7);

    const payload =
        verifyToken(token);

    if (!payload) {

        res.status(401).json({

            success: false,

            message:
                "Invalid or expired token."

        });

        return;

    }

    req.currentUser = payload;

    next();

}