import bcrypt from "bcrypt";

import UserRepository, {
    UserRecord,
    UserWithRole
} from "../database/repository/UserRepository.js";

class UserService {

    async getAllUsers(): Promise<UserWithRole[]> {

        return await UserRepository.getAll();

    }

    async getUserById(
        id: string
    ): Promise<UserWithRole | null> {

        return await UserRepository.findById(id);

    }

    async createUser(
        data: Partial<UserRecord>
    ): Promise<UserRecord> {

        const employeeExists =
            await UserRepository.findByEmployeeId(
                data.employee_id!
            );

        if (employeeExists) {

            throw new Error("Employee ID already exists.");

        }

        const emailExists =
            await UserRepository.findByEmail(
                data.email!
            );

        if (emailExists) {

            throw new Error("Email already exists.");

        }

        const hashedPassword =
            await bcrypt.hash(
                data.password!,
                10
            );

        return await UserRepository.create({

            ...data,

            password: hashedPassword,

        });

    }

    async updateUser(
        id: string,
        data: Partial<UserRecord>
    ): Promise<UserRecord | null> {

        const existingUser =
            await UserRepository.findById(id);

        if (!existingUser) {

            throw new Error("User not found.");

        }

        return await UserRepository.update(
            id,
            data
        );

    }

    async deleteUser(
        id: string
    ): Promise<void> {

        const existingUser =
            await UserRepository.findById(id);

        if (!existingUser) {

            throw new Error("User not found.");

        }

        await UserRepository.delete(id);

    }

    async resetPassword(
        id: string,
        newPassword: string
    ): Promise<void> {

        const existingUser =
            await UserRepository.findById(id);

        if (!existingUser) {

            throw new Error("User not found.");

        }

        const hashedPassword =
            await bcrypt.hash(
                newPassword,
                10
            );

        await UserRepository.updatePassword(
            id,
            hashedPassword
        );

    }

}

export default new UserService();