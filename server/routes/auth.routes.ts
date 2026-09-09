import { Router } from "express";

import AuthController from "../controllers/AuthController.js";

import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.post(
    "/login",
    AuthController.login
);

router.get(
    "/profile",
    requireAuth,
    AuthController.profile
);

export default router;