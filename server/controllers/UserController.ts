import { Request, Response } from "express";
import UserService from "../services/UserService";

class UserController {

    async getAll(req: Request, res: Response): Promise<Response> {

        try {

            const users = await UserService.getAllUsers();

            return res.status(200).json({
                success: true,
                data: users,
            });

        } catch (error: any) {

            return res.status(500).json({
                success: false,
                message: error.message ?? "Internal Server Error",
            });

        }

    }

    async getById(req: Request, res: Response): Promise<Response> {

        try {

            const user = await UserService.getUserById(req.params.id);

            if (!user) {

                return res.status(404).json({
                    success: false,
                    message: "User not found",
                });

            }

            return res.status(200).json({
                success: true,
                data: user,
            });

        } catch (error: any) {

            return res.status(500).json({
                success: false,
                message: error.message ?? "Internal Server Error",
            });

        }

    }

    async create(req: Request, res: Response): Promise<Response> {

        try {

            const user = await UserService.createUser(req.body);

            return res.status(201).json({
                success: true,
                message: "User created successfully",
                data: user,
            });

        } catch (error: any) {

            return res.status(400).json({
                success: false,
                message: error.message ?? "Failed to create user",
            });

        }

    }

    async update(req: Request, res: Response): Promise<Response> {

        try {

            const user = await UserService.updateUser(
                req.params.id,
                req.body
            );

            return res.status(200).json({
                success: true,
                message: "User updated successfully",
                data: user,
            });

        } catch (error: any) {

            return res.status(400).json({
                success: false,
                message: error.message ?? "Failed to update user",
            });

        }

    }

    async delete(req: Request, res: Response): Promise<Response> {

        try {

            await UserService.deleteUser(req.params.id);

            return res.status(200).json({
                success: true,
                message: "User deleted successfully",
            });

        } catch (error: any) {

            return res.status(400).json({
                success: false,
                message: error.message ?? "Failed to delete user",
            });

        }

    }

    async resetPassword(req: Request, res: Response): Promise<Response> {

        try {

            const { password } = req.body;

            if (!password) {

                return res.status(400).json({
                    success: false,
                    message: "Password is required.",
                });

            }

            await UserService.resetPassword(
                req.params.id,
                password
            );

            return res.status(200).json({
                success: true,
                message: "Password reset successfully",
            });

        } catch (error: any) {

            return res.status(400).json({
                success: false,
                message: error.message ?? "Failed to reset password",
            });

        }

    }

}

export default new UserController();