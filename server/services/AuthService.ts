import bcrypt from "bcrypt";

import UserRepository from "../database/repository/UserRepository";

import { signToken } from "../utils/jwt";

export interface LoginPayload {

    employeeId: string;

    password: string;

}

class AuthService {

    async login(
        payload: LoginPayload
    ) {

        const user =
            await UserRepository.findByEmployeeId(
                payload.employeeId
            );

        if (!user) {

            throw new Error(
                "Invalid Employee ID or Password"
            );

        }

        if (!user.is_active) {

            throw new Error(
                "Your account is inactive."
            );

        }

        const matched =
            await bcrypt.compare(
                payload.password,
                user.password
            );

        if (!matched) {

            throw new Error(
                "Invalid Employee ID or Password"
            );

        }

        await UserRepository.updateLastLogin(
            user.id
        );

        const token = signToken({

            id: user.id,

            employeeId: user.employee_id,

            roleId: user.role_id,

            roleCode: user.role_code,

            roleName: user.role_name,

            hierarchyLevel:
                user.hierarchy_level

        });

        return {

            token,

            user: {

                id: user.id,

                employeeId:
                    user.employee_id,

                fullName:
                    user.full_name,

                email:
                    user.email,

                phone:
                    user.phone,

                roleId:
                    user.role_id,

                roleCode:
                    user.role_code,

                roleName:
                    user.role_name,

                hierarchyLevel:
                    user.hierarchy_level,

                designation:
                    user.designation,

                departmentId:
                    user.department_id,

                teamId:
                    user.team_id,

                profilePhoto:
                    user.profile_photo

            }

        };

    }

}

export default new AuthService();