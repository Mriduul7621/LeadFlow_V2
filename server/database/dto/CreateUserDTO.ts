export interface CreateUserDTO {
    employee_id: string;

    full_name: string;

    email: string;

    phone?: string;

    password: string;

    role_id: string;

    department_id?: string;

    team_id?: string;

    manager_id?: string;

    designation?: string;

    joining_date?: Date;

    profile_photo?: string;

    is_active?: boolean;
}