import { Request, Response } from "express";

import AuthService from "../services/AuthService";

import { AuthRequest } from "../middleware/auth";

class AuthController {

    async login(
        req: Request,
        res: Response
    ) {

        try {

            const result =
                await AuthService.login(
                    req.body
                );

            return res.status(200).json({

                success: true,

                message:
                    "Login successful.",

                data: result

            });

        } catch (error: any) {

            return res.status(401).json({

                success: false,

                message: error.message

            });

        }

    }

    async profile(
        req: AuthRequest,
        res: Response
    ) {

        return res.status(200).json({

            success: true,

            data: req.currentUser

        });

    }

}

export default new AuthController();