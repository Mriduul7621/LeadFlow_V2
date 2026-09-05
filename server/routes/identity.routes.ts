import { Request, Response, Router } from "express";
import { getPool } from "../database/connection";
import { requireAuth, signToken } from "../auth";
import { requirePermission } from "../middleware/permission";
import { hashPassword, isBcryptHash, verifyPassword } from "../utils/password";
import AuditService from "../services/auditService";

const router = Router();

function isUuid(value: unknown): value is string {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getDatabase() {
    try {
        return getPool();
    } catch {
        return null;
    }
}

function formatUser(row: any) {
    return {
        id: row.id,
        name: row.full_name,
        fullName: row.full_name,
        employeeId: row.employee_id,
        email: row.email,
        phone: row.phone || "",
        role: row.role_code,
        roleName: row.role_name,
        designation: row.designation || "",
        status: row.account_status || (row.is_active ? "ACTIVE" : "INACTIVE"),
        employmentStatus: row.employment_status || (row.is_active ? "ACTIVE" : "INACTIVE"),
        departmentId: row.department_id || "",
        primaryDepartmentId: row.department_id || "",
        teamId: row.team_id || "",
        managerId: row.manager_id || "",
        reportingManagerId: row.manager_id || "",
        joiningDate: row.joining_date || "",
        avatarUrl: row.profile_photo || "",
        lastLogin: row.last_login || null,
        createdDate: row.created_at,
        mustChangePassword: false,
    };
}

function sendDatabaseUnavailable(res: Response): boolean {
    if (!getDatabase()) {
        res.status(503).json({
            success: false,
            message: "Database unavailable.",
        });
        return true;
    }
    return false;
}

router.post("/auth/login", async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    const loginId = String(req.body.employeeId || req.body.email || "").trim();
    const password = String(req.body.password || "");
    if (!loginId || !password) {
        res.status(400).json({ error: "Employee ID/email and password are required." });
        return;
    }

    try {
        const result = await pool.query(`
            SELECT u.*, r.role_code, r.role_name, r.hierarchy_level,
                   e.employment_status
            FROM users u
            INNER JOIN roles r ON r.id = u.role_id
            LEFT JOIN employees e ON e.id = u.employee_record_id
            WHERE UPPER(u.employee_id) = UPPER($1)
               OR UPPER(u.email) = UPPER($1)
            LIMIT 1
        `, [loginId]);
        const user = result.rows[0];

        if (!user) {
            res.status(401).json({ error: "Invalid credentials." });
            return;
        }

        if (!user.is_active || user.account_status === "INACTIVE") {
            res.status(403).json({ error: "This account is inactive." });
            return;
        }

        if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
            res.status(423).json({ error: "This account is temporarily locked." });
            return;
        }

        const valid = isBcryptHash(user.password)
            ? await verifyPassword(password, user.password)
            : user.password === password;

        if (!valid) {
            const attempts = Number(user.failed_login_attempts || 0) + 1;
            await pool.query(`
                UPDATE users
                SET failed_login_attempts = $1,
                    locked_until = CASE WHEN $1 >= 5 THEN NOW() + INTERVAL '30 minutes' ELSE NULL END,
                    account_status = CASE WHEN $1 >= 5 THEN 'LOCKED' ELSE account_status END,
                    updated_at = NOW()
                WHERE id = $2
            `, [attempts, user.id]);
            await recordAudit(req, {
                actionCode: "LOGIN_FAILED",
                entityType: "USER",
                entityId: user.id,
                targetUserId: user.id,
                metadata: { loginId },
            });
            res.status(attempts >= 5 ? 423 : 401).json({ error: "Invalid credentials." });
            return;
        }

        await pool.query(`
            UPDATE users
            SET last_login = NOW(),
                failed_login_attempts = 0,
                locked_until = NULL,
                account_status = 'ACTIVE',
                password_changed_at = CASE
                    WHEN password_changed_at IS NULL THEN NOW()
                    ELSE password_changed_at
                END,
                updated_at = NOW()
            WHERE id = $1
        `, [user.id]);

        const token = signToken({
            id: user.id,
            employeeId: user.employee_id,
            role: user.role_code,
        });

        await recordAudit(req, {
            actionCode: "LOGIN",
            entityType: "USER",
            entityId: user.id,
            targetUserId: user.id,
        });

        res.json({ token, user: formatUser(user) });
    } catch (error: any) {
        res.status(500).json({ error: "Login failed.", details: error.message });
    }
});

async function recordAudit(req: Request, event: Parameters<typeof AuditService.record>[0]) {
    try {
        await AuditService.record({
            ...event,
            actorUserId: req.currentUser?.id,
            ipAddress: req.ip,
            userAgent: req.headers["user-agent"] || null,
        });
    } catch (error) {
        console.error("Audit event could not be recorded:", error);
    }
}

router.get("/employees", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT e.*, u.id AS user_id,
                   u.account_status,
                   u.role_id,
                   r.role_code,
                   r.role_name
            FROM employees e
            LEFT JOIN users u ON u.employee_record_id = e.id
            LEFT JOIN roles r ON r.id = u.role_id
            ORDER BY e.created_at DESC
        `);
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get("/users", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT u.*, r.role_code, r.role_name, r.hierarchy_level,
                   e.employment_status
            FROM users u
            INNER JOIN roles r ON r.id = u.role_id
            LEFT JOIN employees e ON e.id = u.employee_record_id
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows.map(formatUser));
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get("/users/:id", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT u.*, r.role_code, r.role_name, r.hierarchy_level,
                   e.employment_status
            FROM users u
            INNER JOIN roles r ON r.id = u.role_id
            LEFT JOIN employees e ON e.id = u.employee_record_id
            WHERE u.id = $1 OR u.employee_id = $1
            LIMIT 1
        `, [req.params.id]);

        if (!result.rows[0]) {
            res.status(404).json({ success: false, message: "User not found." });
            return;
        }

        res.json({ success: true, data: formatUser(result.rows[0]) });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.put("/users/:id", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const existingResult = await pool.query(
            `SELECT * FROM users WHERE id = $1 LIMIT 1`,
            [req.params.id]
        );
        const existing = existingResult.rows[0];
        if (!existing) {
            res.status(404).json({ success: false, message: "User not found." });
            return;
        }

        let roleId = existing.role_id;
        if (req.body.role || req.body.roleCode) {
            const roleResult = await pool.query(
                `SELECT id FROM roles WHERE role_code = $1 OR id::text = $1 LIMIT 1`,
                [String(req.body.role || req.body.roleCode)]
            );
            roleId = roleResult.rows[0]?.id || roleId;
        }

        const active = req.body.status === undefined
            ? existing.is_active
            : String(req.body.status).toLowerCase() !== "inactive";

        const result = await pool.query(`
            UPDATE users
            SET full_name = $1,
                email = $2,
                phone = $3,
                role_id = $4,
                department_id = $5,
                team_id = $6,
                manager_id = $7,
                designation = $8,
                joining_date = $9,
                profile_photo = $10,
                is_active = $11,
                account_status = $12,
                updated_at = NOW()
            WHERE id = $13
            RETURNING *
        `, [
            req.body.name ?? req.body.fullName ?? existing.full_name,
            req.body.email ?? existing.email,
            req.body.phone ?? req.body.contact ?? existing.phone,
            roleId,
            isUuid(req.body.departmentId) ? req.body.departmentId : existing.department_id,
            isUuid(req.body.teamId) ? req.body.teamId : existing.team_id,
            isUuid(req.body.managerId) ? req.body.managerId : existing.manager_id,
            req.body.designation ?? existing.designation,
            req.body.joiningDate ?? existing.joining_date,
            req.body.avatarUrl ?? existing.profile_photo,
            active,
            active ? "ACTIVE" : "INACTIVE",
            req.params.id,
        ]);

        const saved = await pool.query(`
            SELECT u.*, r.role_code, r.role_name, r.hierarchy_level,
                   e.employment_status
            FROM users u
            INNER JOIN roles r ON r.id = u.role_id
            LEFT JOIN employees e ON e.id = u.employee_record_id
            WHERE u.id = $1
        `, [result.rows[0].id]);

        await recordAudit(req, {
            actionCode: "USER_UPDATED",
            entityType: "USER",
            entityId: result.rows[0].id,
            targetUserId: result.rows[0].id,
        });

        res.json(formatUser(saved.rows[0]));
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.patch(
    "/users/:id/status",
    requireAuth,
    requirePermission("users.activate"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const active = String(req.body.status || "").toUpperCase() === "ACTIVE";

        try {
            const result = await pool.query(`
                UPDATE users
                SET is_active = $1,
                    account_status = $2,
                    updated_at = NOW()
                WHERE id = $3
                RETURNING id, employee_id
            `, [active, active ? "ACTIVE" : "INACTIVE", req.params.id]);

            if (!result.rows[0]) {
                res.status(404).json({ success: false, message: "User not found." });
                return;
            }

            await recordAudit(req, {
                actionCode: active ? "USER_ACTIVATED" : "USER_DEACTIVATED",
                entityType: "USER",
                entityId: result.rows[0].id,
                targetUserId: result.rows[0].id,
            });

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.delete(
    "/users/:id",
    requireAuth,
    requirePermission("users.delete"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                UPDATE users
                SET is_active = FALSE,
                    account_status = 'INACTIVE',
                    updated_at = NOW()
                WHERE id = $1
                RETURNING id
            `, [req.params.id]);

            if (!result.rows[0]) {
                res.status(404).json({ success: false, message: "User not found." });
                return;
            }

            await recordAudit(req, {
                actionCode: "USER_DEACTIVATED",
                entityType: "USER",
                entityId: result.rows[0].id,
                targetUserId: result.rows[0].id,
            });

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.post(
    "/users/:id/reset-password",
    requireAuth,
    requirePermission("users.edit"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const password = String(req.body.password || "");
        if (password.length < 8) {
            res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
            return;
        }

        try {
            const passwordHash = isBcryptHash(password)
                ? password
                : await hashPassword(password);
            const result = await pool.query(`
                UPDATE users
                SET password = $1,
                    password_changed_at = NOW(),
                    failed_login_attempts = 0,
                    locked_until = NULL,
                    updated_at = NOW()
                WHERE id = $2
                RETURNING id
            `, [passwordHash, req.params.id]);

            if (!result.rows[0]) {
                res.status(404).json({ success: false, message: "User not found." });
                return;
            }

            await recordAudit(req, {
                actionCode: "PASSWORD_RESET",
                entityType: "USER",
                entityId: result.rows[0].id,
                targetUserId: result.rows[0].id,
            });

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.post(
    "/users/:id/lock",
    requireAuth,
    requirePermission("users.lock"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            await pool.query(`
                UPDATE users
                SET locked_until = NOW() + INTERVAL '30 minutes',
                    account_status = 'LOCKED',
                    updated_at = NOW()
                WHERE id = $1
            `, [req.params.id]);
            await recordAudit(req, {
                actionCode: "USER_LOCKED",
                entityType: "USER",
                entityId: req.params.id,
                targetUserId: req.params.id,
            });
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.post(
    "/users/:id/unlock",
    requireAuth,
    requirePermission("users.lock"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            await pool.query(`
                UPDATE users
                SET locked_until = NULL,
                    failed_login_attempts = 0,
                    account_status = CASE WHEN is_active THEN 'ACTIVE' ELSE 'INACTIVE' END,
                    updated_at = NOW()
                WHERE id = $1
            `, [req.params.id]);
            await recordAudit(req, {
                actionCode: "USER_UNLOCKED",
                entityType: "USER",
                entityId: req.params.id,
                targetUserId: req.params.id,
            });
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get("/roles", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT r.id, r.role_code, r.role_name, r.hierarchy_level,
                   r.description, r.is_active,
                   COALESCE(
                       json_agg(
                           json_build_object(
                               'code', p.permission_code,
                               'allowed', rp.is_allowed
                           )
                       ) FILTER (WHERE p.id IS NOT NULL),
                       '[]'::json
                   ) AS permissions
            FROM roles r
            LEFT JOIN role_permissions rp ON rp.role_id = r.id
            LEFT JOIN permissions p ON p.id = rp.permission_id
            GROUP BY r.id
            ORDER BY r.hierarchy_level, r.role_name
        `);

        res.json(result.rows.map(row => ({
            roleId: row.role_code,
            roleName: row.role_name,
            hierarchyLevel: row.hierarchy_level,
            isActive: row.is_active,
            dataVisibility: row.role_code.toUpperCase() === "ADMIN" ? "Organization" : "Own",
            permissions: row.permissions,
            featurePermissions: {},
            menuAccess: {},
            actions: {},
        })));
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post(
    "/roles",
    requireAuth,
    requirePermission("roles.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const roleCode = String(req.body.roleId || req.body.roleCode || "").trim();
        const roleName = String(req.body.roleName || "").trim();
        if (!roleCode || !roleName) {
            res.status(400).json({ success: false, message: "Role code and name are required." });
            return;
        }

        try {
            const result = await pool.query(`
                INSERT INTO roles (role_code, role_name, hierarchy_level, description)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (role_code) DO UPDATE SET
                    role_name = EXCLUDED.role_name,
                    hierarchy_level = EXCLUDED.hierarchy_level,
                    description = EXCLUDED.description,
                    updated_at = NOW()
                RETURNING id, role_code, role_name, hierarchy_level, is_active
            `, [
                roleCode,
                roleName,
                Number(req.body.hierarchyLevel || 1),
                req.body.description || null,
            ]);

            await recordAudit(req, {
                actionCode: "ROLE_CHANGED",
                entityType: "ROLE",
                entityId: result.rows[0].id,
                metadata: { roleCode },
            });

            res.json({
                roleId: result.rows[0].role_code,
                roleName: result.rows[0].role_name,
                hierarchyLevel: result.rows[0].hierarchy_level,
                isActive: result.rows[0].is_active,
                dataVisibility: req.body.dataVisibility || "SELF",
                permissions: [],
            });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.patch(
    "/roles/:id/status",
    requireAuth,
    requirePermission("roles.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            await pool.query(`
                UPDATE roles
                SET is_active = $1, updated_at = NOW()
                WHERE id = $2 OR role_code = $2
            `, [Boolean(req.body.isActive), req.params.id]);
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get("/permissions", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT id, permission_code, module_name, action_name,
                   description, is_active
            FROM permissions
            ORDER BY module_name, action_name, permission_code
        `);
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.get(
    "/roles/:roleId/permissions",
    requireAuth,
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                SELECT p.permission_code, p.module_name, p.action_name,
                       COALESCE(rp.is_allowed, FALSE) AS is_allowed
                FROM permissions p
                LEFT JOIN role_permissions rp
                    ON rp.permission_id = p.id
                   AND rp.role_id = (
                       SELECT id FROM roles
                       WHERE role_code = $1 OR id::text = $1
                       LIMIT 1
                   )
                ORDER BY p.module_name, p.action_name, p.permission_code
            `, [req.params.roleId]);
            res.json({ success: true, data: result.rows });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.put(
    "/roles/:roleId/permissions",
    requireAuth,
    requirePermission("permissions.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];

        try {
            const roleResult = await pool.query(
                `SELECT id FROM roles WHERE role_code = $1 OR id::text = $1 LIMIT 1`,
                [req.params.roleId]
            );
            const roleId = roleResult.rows[0]?.id;
            if (!roleId) {
                res.status(404).json({ success: false, message: "Role not found." });
                return;
            }

            for (const item of permissions) {
                await pool.query(`
                    INSERT INTO role_permissions (role_id, permission_id, is_allowed)
                    SELECT $1, id, $3
                    FROM permissions
                    WHERE permission_code = $2
                    ON CONFLICT (role_id, permission_id) DO UPDATE
                    SET is_allowed = EXCLUDED.is_allowed,
                        updated_at = NOW()
                `, [roleId, item.code, Boolean(item.allowed)]);
            }

            await recordAudit(req, {
                actionCode: "PERMISSIONS_CHANGED",
                entityType: "ROLE",
                entityId: roleId,
                metadata: { permissionCount: permissions.length },
            });

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get(
    "/users/:userId/permissions",
    requireAuth,
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                SELECT p.permission_code, p.module_name, p.action_name,
                       COALESCE(up.is_allowed, rp.is_allowed, FALSE) AS is_allowed,
                       up.is_allowed AS user_override
                FROM users u
                INNER JOIN roles r ON r.id = u.role_id
                CROSS JOIN permissions p
                LEFT JOIN role_permissions rp
                    ON rp.role_id = r.id AND rp.permission_id = p.id
                LEFT JOIN user_permissions up
                    ON up.user_id = u.id AND up.permission_id = p.id
                WHERE u.id = $1
                ORDER BY p.module_name, p.action_name, p.permission_code
            `, [req.params.userId]);
            res.json({ success: true, data: result.rows });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.put(
    "/users/:userId/permissions",
    requireAuth,
    requirePermission("permissions.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];

        try {
            for (const item of permissions) {
                await pool.query(`
                    INSERT INTO user_permissions (user_id, permission_id, is_allowed, reason)
                    SELECT $1, id, $3, $4
                    FROM permissions
                    WHERE permission_code = $2
                    ON CONFLICT (user_id, permission_id) DO UPDATE
                    SET is_allowed = EXCLUDED.is_allowed,
                        reason = EXCLUDED.reason,
                        updated_at = NOW()
                `, [req.params.userId, item.code, Boolean(item.allowed), item.reason || null]);
            }

            await recordAudit(req, {
                actionCode: "PERMISSIONS_CHANGED",
                entityType: "USER",
                entityId: req.params.userId,
                targetUserId: req.params.userId,
                metadata: { permissionCount: permissions.length },
            });

            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get("/departments", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT id, department_code, department_name, description,
                   is_active, created_at, updated_at
            FROM departments
            ORDER BY department_name
        `);
        res.json(result.rows.map(row => ({
            id: row.id,
            name: row.department_name,
            code: row.department_code,
            createdDate: row.created_at,
            isActive: row.is_active,
        })));
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post(
    "/departments",
    requireAuth,
    requirePermission("departments.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const name = String(req.body.name || req.body.departmentName || "").trim();
        const code = String(req.body.code || name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30)).trim();
        if (!name || !code) {
            res.status(400).json({ success: false, message: "Department name is required." });
            return;
        }

        try {
            const result = await pool.query(`
                INSERT INTO departments (department_code, department_name, description)
                VALUES ($1, $2, $3)
                ON CONFLICT (department_code) DO UPDATE SET
                    department_name = EXCLUDED.department_name,
                    description = EXCLUDED.description,
                    updated_at = NOW()
                RETURNING id, department_code, department_name, is_active, created_at
            `, [code, name, req.body.description || null]);
            res.json({
                id: result.rows[0].id,
                name: result.rows[0].department_name,
                code: result.rows[0].department_code,
                isActive: result.rows[0].is_active,
                createdDate: result.rows[0].created_at,
            });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.delete(
    "/departments/:id",
    requireAuth,
    requirePermission("departments.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            await pool.query(`
                UPDATE departments
                SET is_active = FALSE, updated_at = NOW()
                WHERE id = $1
            `, [req.params.id]);
            res.json({ success: true });
        } catch (error: any) {
            res.status(409).json({ success: false, message: error.message });
        }
    }
);

router.get("/teams", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT t.id, t.team_code, t.team_name, t.department_id,
                   t.description, t.is_active, t.created_at,
                   COALESCE(
                       json_agg(tm.employee_id) FILTER (WHERE tm.employee_id IS NOT NULL),
                       '[]'::json
                   ) AS member_ids
            FROM teams t
            LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.is_active = TRUE
            GROUP BY t.id
            ORDER BY t.team_name
        `);
        res.json({ success: true, data: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post(
    "/teams",
    requireAuth,
    requirePermission("teams.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const teamName = String(req.body.name || req.body.teamName || "").trim();
        const teamCode = String(req.body.code || req.body.teamCode || teamName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 30)).trim();
        if (!teamName || !teamCode || !isUuid(req.body.departmentId)) {
            res.status(400).json({ success: false, message: "Team name and valid department are required." });
            return;
        }

        try {
            const result = await pool.query(`
                INSERT INTO teams (team_code, team_name, department_id, description)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (team_code) DO UPDATE SET
                    team_name = EXCLUDED.team_name,
                    department_id = EXCLUDED.department_id,
                    description = EXCLUDED.description,
                    updated_at = NOW()
                RETURNING *
            `, [teamCode, teamName, req.body.departmentId, req.body.description || null]);
            res.json({ success: true, data: result.rows[0] });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get("/hierarchies", requireAuth, async (req, res) => {
    const pool = getDatabase();
    if (!pool) return sendDatabaseUnavailable(res);

    try {
        const result = await pool.query(`
            SELECT er.employee_id,
                   er.manager_employee_id,
                   ed.department_id,
                   child.employee_id AS employee_code,
                   manager.employee_id AS manager_code,
                   r.role_code
            FROM employee_reporting er
            INNER JOIN employees child ON child.id = er.employee_id
            LEFT JOIN employees manager ON manager.id = er.manager_employee_id
            LEFT JOIN employee_departments ed
                ON ed.employee_id = er.employee_id
               AND ed.is_primary = TRUE
            LEFT JOIN users u ON u.employee_record_id = child.id
            LEFT JOIN roles r ON r.id = u.role_id
            WHERE er.is_active = TRUE
            ORDER BY ed.department_id, er.effective_from
        `);

        const grouped = new Map<string, any>();
        for (const row of result.rows) {
            const departmentId = row.department_id || "unassigned";
            if (!grouped.has(departmentId)) {
                grouped.set(departmentId, {
                    id: `${departmentId}_hierarchy`,
                    departmentId,
                    layers: [],
                    updatedAt: new Date().toISOString(),
                });
            }
            const document = grouped.get(departmentId);
            const parentLayer = document.layers.find((layer: any) =>
                layer.employeeIds.includes(row.manager_code)
            );
            let layer = document.layers.find((item: any) => item.roleId === row.role_code);
            if (!layer) {
                layer = {
                    id: `role_${row.role_code}`,
                    parentId: parentLayer?.id || null,
                    roleId: row.role_code,
                    employeeIds: [],
                };
                document.layers.push(layer);
            }
            if (!layer.employeeIds.includes(row.employee_code)) {
                layer.employeeIds.push(row.employee_code);
            }
        }

        res.json(Array.from(grouped.values()));
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

router.post(
    "/hierarchies",
    requireAuth,
    requirePermission("hierarchy.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        const layers = Array.isArray(req.body.layers) ? req.body.layers : [];
        try {
            const employeeCodes = layers.flatMap((layer: any) => Array.isArray(layer.employeeIds) ? layer.employeeIds : []);
            for (const employeeCode of employeeCodes) {
                const childResult = await pool.query(
                    `SELECT id FROM employees WHERE employee_id = $1 LIMIT 1`,
                    [employeeCode]
                );
                const childId = childResult.rows[0]?.id;
                if (!childId) continue;

                const childLayer = layers.find((layer: any) => layer.employeeIds?.includes(employeeCode));
                const parentLayer = layers.find((layer: any) => layer.id === childLayer?.parentId);
                const managerCode = parentLayer?.employeeIds?.[0];
                const managerResult = managerCode
                    ? await pool.query(`SELECT id FROM employees WHERE employee_id = $1 LIMIT 1`, [managerCode])
                    : { rows: [] };
                const managerId = managerResult.rows[0]?.id || null;

                await pool.query(`
                    UPDATE employee_reporting
                    SET is_active = FALSE,
                        effective_to = CURRENT_DATE,
                        updated_at = NOW()
                    WHERE employee_id = $1
                      AND relationship_type = 'PRIMARY'
                      AND is_active = TRUE
                `, [childId]);

                if (managerId && managerId !== childId) {
                    await pool.query(`
                        INSERT INTO employee_reporting (
                            employee_id, manager_employee_id, relationship_type
                        )
                        VALUES ($1, $2, 'PRIMARY')
                    `, [childId, managerId]);
                }
            }

            await recordAudit(req, {
                actionCode: "MANAGER_CHANGED",
                entityType: "HIERARCHY",
                metadata: { departmentId: req.body.departmentId, layerCount: layers.length },
            });

            res.json(req.body);
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get(
    "/employees/:id/reporting",
    requireAuth,
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                SELECT er.*, m.employee_id AS manager_employee_id_code
                FROM employee_reporting er
                LEFT JOIN employees m ON m.id = er.manager_employee_id
                WHERE er.employee_id = $1
                  AND er.is_active = TRUE
                ORDER BY er.effective_from DESC
            `, [req.params.id]);
            res.json({ success: true, data: result.rows });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.post(
    "/employees/:id/reporting",
    requireAuth,
    requirePermission("hierarchy.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const managerId = req.body.managerEmployeeId || null;
            const result = await pool.query(`
                INSERT INTO employee_reporting (
                    employee_id,
                    manager_employee_id,
                    relationship_type,
                    effective_from
                )
                VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE))
                RETURNING *
            `, [
                req.params.id,
                managerId,
                req.body.relationshipType || "PRIMARY",
                req.body.effectiveFrom || null,
            ]);

            await recordAudit(req, {
                actionCode: "MANAGER_CHANGED",
                entityType: "EMPLOYEE_REPORTING",
                entityId: result.rows[0].id,
                metadata: { employeeId: req.params.id, managerId },
            });

            res.status(201).json({ success: true, data: result.rows[0] });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.put(
    "/employees/:id/reporting/:relationId",
    requireAuth,
    requirePermission("hierarchy.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                UPDATE employee_reporting
                SET manager_employee_id = $1,
                    relationship_type = $2,
                    effective_from = $3,
                    effective_to = $4,
                    is_active = $5,
                    updated_at = NOW()
                WHERE id = $6 AND employee_id = $7
                RETURNING *
            `, [
                req.body.managerEmployeeId || null,
                req.body.relationshipType || "PRIMARY",
                req.body.effectiveFrom || new Date().toISOString().slice(0, 10),
                req.body.effectiveTo || null,
                req.body.isActive !== false,
                req.params.relationId,
                req.params.id,
            ]);

            if (!result.rows[0]) {
                res.status(404).json({ success: false, message: "Reporting relationship not found." });
                return;
            }

            res.json({ success: true, data: result.rows[0] });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.delete(
    "/employees/:id/reporting/:relationId",
    requireAuth,
    requirePermission("hierarchy.manage"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            await pool.query(`
                UPDATE employee_reporting
                SET is_active = FALSE,
                    effective_to = CURRENT_DATE,
                    updated_at = NOW()
                WHERE id = $1 AND employee_id = $2
            `, [req.params.relationId, req.params.id]);
            res.json({ success: true });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

router.get(
    "/audit-logs",
    requireAuth,
    requirePermission("audit.view"),
    async (req, res) => {
        const pool = getDatabase();
        if (!pool) return sendDatabaseUnavailable(res);

        try {
            const result = await pool.query(`
                SELECT *
                FROM audit_logs
                ORDER BY created_at DESC
                LIMIT 200
            `);
            res.json({ success: true, data: result.rows });
        } catch (error: any) {
            res.status(500).json({ success: false, message: error.message });
        }
    }
);

export default router;
