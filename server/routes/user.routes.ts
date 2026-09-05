import { Router } from "express";
import UserController from "../controllers/UserController";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get(
    "/",
    requireAuth,
    UserController.getAll
);

router.get(
    "/:id",
    requireAuth,
    UserController.getById
);

router.post(
    "/",
    requireAuth,
    UserController.create
);

router.put(
    "/:id",
    requireAuth,
    UserController.update
);

router.delete(
    "/:id",
    requireAuth,
    UserController.delete
);

router.post(
    "/:id/reset-password",
    requireAuth,
    UserController.resetPassword
);

export default router;