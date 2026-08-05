import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { getPool, initializeDatabase } from './server/db.ts';
import * as dotenv from 'dotenv';
import {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
  requireFeaturePermission,
} from './server/auth.ts';
import { getScopedEmployeeIds } from './server/authz.ts';

// Load environment variables
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// Lazy Database Initializer Middleware for Serverless Compatibility
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await initializeDatabase();
      dbInitialized = true;
    } catch (err) {
      console.error('⚠️ Database initialization failed:', err);
    }
  }
  next();
});

  // ==========================================
  // Supabase PostgreSQL API REST Routes (CRUD)
  // ==========================================

  // Check if database is connected
  app.get('/api/db-status', (req, res) => {
    const pool = getPool();
    if (!pool) {
      return res.json({ connected: false, message: 'DATABASE_URL is not set.' });
    }
    res.json({ connected: true, message: 'Connected to Supabase PostgreSQL Database.' });
  });

  // --- USERS CRUD ---
  // Check if an ADMIN user exists in the database
  app.get('/api/users/check-admin', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ exists: false });
    try {
      const result = await pool.query("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN'");
      const count = parseInt(result.rows[0].count, 10);
      res.json({ exists: count > 0 });
    } catch (err: any) {
      console.error('Error checking admin presence:', err);
      res.status(500).json({ error: 'Database check failed', details: err.message });
    }
  });

  // Helper: DB row -> API shape. Password hash is NEVER included.
  function formatUserRow(row: any) {
    return {
      id: row.id,
      name: row.name,
      employeeId: row.employee_id,
      email: row.email,
      role: row.role,
      designation: row.designation,
      status: row.status,
      createdDate: row.created_date,
      teamId: row.team_id || '',
      departmentId: row.department_id || '',
      primaryDepartmentId: row.department_id || '',
      managerId: row.manager_id || '',
      reportingManagerId: row.manager_id || '',
      employmentStatus: row.employment_status || row.status,
      joiningDate: row.joining_date || '',
      mustChangePassword: !!row.must_change_password,
      avatarUrl: row.avatar_url || '',
      phone: row.mobile || '',
    };
  }

  // Get all users - scoped to what the requester is allowed to see
  // (Own / DownTeam / FullTeam / Organization), based on their role's
  // configured data-visibility and the manager reporting chain.
  app.get('/api/users', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM users');
      let rows = result.rows;

      const scopedIds = await getScopedEmployeeIds(req.currentUser!.employeeId, req.currentUser!.role);
      if (scopedIds) {
        rows = rows.filter(r => scopedIds.has(r.employee_id));
      }

      res.json(rows.map(formatUserRow));
    } catch (err: any) {
      console.error('Error fetching users:', err);
      res.status(500).json({ error: 'Database fetch failed', details: err.message });
    }
  });

  // Create or update user.
  // Anyone can bootstrap the very first ADMIN account when none exists yet
  // (first-run setup screen). Every other write requires an authenticated
  // ADMIN, or a role explicitly granted the user_management edit permission.
  app.post('/api/users', async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const payload = req.body;
      const isAdminRole = (payload.role || '').toUpperCase() === 'ADMIN';

      let bootstrapAllowed = false;
      if (isAdminRole) {
        const adminCountRes = await pool.query("SELECT COUNT(*) as count FROM users WHERE UPPER(role) = 'ADMIN'");
        bootstrapAllowed = parseInt(adminCountRes.rows[0].count, 10) === 0;
      }

      if (!bootstrapAllowed) {
        const header = req.headers['authorization'] || '';
        const token = Array.isArray(header) ? header[0] : header;
        const match = /^Bearer\s+(.+)$/.exec(token || '');
        const decoded = match ? verifyToken(match[1]) : null;
        if (!decoded) {
          return res.status(401).json({ error: 'Authentication required.' });
        }
        if (decoded.role.toUpperCase() !== 'ADMIN') {
          const roleRes = await pool.query('SELECT feature_permissions FROM roles WHERE UPPER(role_id) = UPPER($1)', [decoded.role]);
          const fp = roleRes.rows[0]?.feature_permissions ? JSON.parse(roleRes.rows[0].feature_permissions) : {};
          const canManageUsers = fp?.user_management?.user_create || fp?.user_management?.user_edit;
          if (!canManageUsers) {
            return res.status(403).json({ error: 'You do not have permission to manage users.' });
          }
        }
      }

      // Preserve existing password hash unless a new plaintext password was supplied.
      const existing = await pool.query('SELECT password FROM users WHERE id = $1', [payload.id]);
      let passwordToStore: string | null = existing.rows[0]?.password || null;
      if (payload.password && payload.password.length > 0) {
        passwordToStore = isBcryptHash(payload.password) ? payload.password : await hashPassword(payload.password);
      }

      const query = `
        INSERT INTO users (
          id, name, employee_id, email, role, designation, status, created_date, password,
          department_id, team_id, manager_id, employment_status, joining_date,
          must_change_password, avatar_url, mobile
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          employee_id = EXCLUDED.employee_id,
          email = EXCLUDED.email,
          role = EXCLUDED.role,
          designation = EXCLUDED.designation,
          status = EXCLUDED.status,
          created_date = EXCLUDED.created_date,
          password = EXCLUDED.password,
          department_id = EXCLUDED.department_id,
          team_id = EXCLUDED.team_id,
          manager_id = EXCLUDED.manager_id,
          employment_status = EXCLUDED.employment_status,
          joining_date = EXCLUDED.joining_date,
          must_change_password = EXCLUDED.must_change_password,
          avatar_url = EXCLUDED.avatar_url,
          mobile = EXCLUDED.mobile
        RETURNING *
      `;
      const values = [
        payload.id, payload.name, payload.employeeId, payload.email, payload.role,
        payload.designation, payload.status, payload.createdDate, passwordToStore,
        payload.departmentId || payload.primaryDepartmentId || null,
        payload.teamId || null,
        payload.managerId || payload.reportingManagerId || null,
        payload.employmentStatus || payload.status || null,
        payload.joiningDate || null,
        !!payload.mustChangePassword,
        payload.avatarUrl || null,
        payload.phone || payload.mobile || null,
      ];
      const result = await pool.query(query, values);
      res.status(200).json(formatUserRow(result.rows[0]));
    } catch (err: any) {
      console.error('Error upserting user:', err);
      res.status(500).json({ error: 'Upsert failed', details: err.message });
    }
  });

  // Sync users list (bulk push of the client's offline cache). Only an
  // authenticated ADMIN may push writes; non-admin callers still receive
  // the scoped list back (read-only) so the app keeps working offline.
  app.post('/api/users/sync', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localUsers, deletedUserIds } = req.body;
      let syncCount = 0;
      const isAdmin = (req.currentUser?.role || '').toUpperCase() === 'ADMIN';

      if (isAdmin) {
        if (Array.isArray(deletedUserIds) && deletedUserIds.length > 0) {
          await pool.query('DELETE FROM users WHERE id = ANY($1)', [deletedUserIds]);
        }

        if (Array.isArray(localUsers)) {
          for (const user of localUsers) {
            const existing = await pool.query('SELECT password FROM users WHERE id = $1', [user.id]);
            let passwordToStore: string | null = existing.rows[0]?.password || null;
            if (user.password && user.password.length > 0) {
              passwordToStore = isBcryptHash(user.password) ? user.password : await hashPassword(user.password);
            }
            const query = `
              INSERT INTO users (
                id, name, employee_id, email, role, designation, status, created_date, password,
                department_id, team_id, manager_id, employment_status, joining_date,
                must_change_password, avatar_url, mobile
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                employee_id = EXCLUDED.employee_id,
                email = EXCLUDED.email,
                role = EXCLUDED.role,
                designation = EXCLUDED.designation,
                status = EXCLUDED.status,
                created_date = EXCLUDED.created_date,
                password = EXCLUDED.password,
                department_id = EXCLUDED.department_id,
                team_id = EXCLUDED.team_id,
                manager_id = EXCLUDED.manager_id,
                employment_status = EXCLUDED.employment_status,
                joining_date = EXCLUDED.joining_date,
                must_change_password = EXCLUDED.must_change_password,
                avatar_url = EXCLUDED.avatar_url,
                mobile = EXCLUDED.mobile
            `;
            await pool.query(query, [
              user.id, user.name, user.employeeId, user.email, user.role,
              user.designation, user.status, user.createdDate, passwordToStore,
              user.departmentId || user.primaryDepartmentId || null,
              user.teamId || null,
              user.managerId || user.reportingManagerId || null,
              user.employmentStatus || user.status || null,
              user.joiningDate || null,
              !!user.mustChangePassword,
              user.avatarUrl || null,
              user.phone || user.mobile || null,
            ]);
            syncCount++;
          }
        }
      }

      const latestUsers = await pool.query('SELECT * FROM users');
      let rows = latestUsers.rows;
      const scopedIds = await getScopedEmployeeIds(req.currentUser!.employeeId, req.currentUser!.role);
      if (scopedIds) {
        rows = rows.filter(r => scopedIds.has(r.employee_id));
      }

      res.json({ success: true, processed: syncCount, cloudUsers: rows.map(formatUserRow) });
    } catch (err: any) {
      console.error('Users sync failed:', err);
      res.status(500).json({ error: 'Users sync failed', details: err.message });
    }
  });

  // Delete user - ADMIN only
  app.delete('/api/users/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { id } = req.params;
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete user failed:', err);
      res.status(500).json({ error: 'Delete failed', details: err.message });
    }
  });

  // --- AUTHENTICATION ---
  // Real server-side login: verifies the password against the bcrypt hash
  // stored in the database and issues a signed session token. Replaces the
  // previous client-side "fetch all users with passwords and compare in the
  // browser" flow (which also shipped a hardcoded master password).
  app.post('/api/auth/login', async (req, res) => {
    const pool = getPool();
    if (!pool) {
      return res.status(503).json({ error: 'Database not connected. Cannot authenticate.' });
    }
    try {
      const { employeeId, password } = req.body;
      if (!employeeId || !password) {
        return res.status(400).json({ error: 'Employee ID and password are required.' });
      }
      const result = await pool.query(
        'SELECT * FROM users WHERE UPPER(employee_id) = UPPER($1) OR UPPER(email) = UPPER($1)',
        [employeeId]
      );
      const row = result.rows[0];
      if (!row) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      if (row.status && row.status.toUpperCase() === 'INACTIVE') {
        return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
      }

      let valid = false;
      if (isBcryptHash(row.password)) {
        valid = await verifyPassword(password, row.password);
      } else if (row.password) {
        // Legacy plaintext record (pre-security-fix data) - verify directly,
        // then transparently upgrade it to a bcrypt hash going forward.
        valid = row.password === password;
        if (valid) {
          const upgraded = await hashPassword(password);
          await pool.query('UPDATE users SET password = $1 WHERE id = $2', [upgraded, row.id]);
        }
      }

      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }

      const token = signToken({ id: row.id, employeeId: row.employee_id, role: row.role });
      res.json({ token, user: formatUserRow(row) });
    } catch (err: any) {
      console.error('Login failed:', err);
      res.status(500).json({ error: 'Login failed', details: err.message });
    }
  });

  // Change own password (must be authenticated as the account itself, or ADMIN)
  app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: 'Database not connected.' });
    try {
      const { userId, currentPassword, newPassword } = req.body;
      if (!newPassword || newPassword.length < 5) {
        return res.status(400).json({ error: 'New password must be at least 5 characters.' });
      }
      const isSelf = req.currentUser!.id === userId;
      const isAdmin = req.currentUser!.role.toUpperCase() === 'ADMIN';
      if (!isSelf && !isAdmin) {
        return res.status(403).json({ error: 'You may only change your own password.' });
      }

      const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: 'User not found.' });

      if (isSelf) {
        const ok = isBcryptHash(row.password)
          ? await verifyPassword(currentPassword || '', row.password)
          : row.password === currentPassword;
        if (!ok) {
          return res.status(401).json({ error: 'Current password is incorrect.' });
        }
      }

      const newHash = await hashPassword(newPassword);
      await pool.query('UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2', [newHash, userId]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Change password failed:', err);
      res.status(500).json({ error: 'Failed to change password', details: err.message });
    }
  });


  // --- LEADS CRUD ---
  // Helper: DB row -> API shape for a lead. Central place so GET/sync
  // never drift out of sync with each other again.
  function formatLeadRow(row: any) {
    let history = [];
    try {
      history = row.status_history ? JSON.parse(row.status_history) : [];
    } catch (e) {
      history = [];
    }
    let customFields: Record<string, any> = {};
    try {
      customFields = row.custom_fields ? JSON.parse(row.custom_fields) : {};
    } catch (e) {
      customFields = {};
    }
    let assignmentHistory: any[] = [];
    try {
      assignmentHistory = row.assignment_history ? JSON.parse(row.assignment_history) : [];
    } catch (e) {
      assignmentHistory = [];
    }
    let documents: any[] = [];
    try {
      documents = row.documents ? JSON.parse(row.documents) : [];
    } catch (e) {
      documents = [];
    }
    return {
      id: row.id,
      prospectName: row.prospect_name,
      mobile: row.mobile,
      mobileNumber: row.mobile_number,
      email: row.email,
      profession: row.profession,
      occupation: row.occupation,
      residenceAddress: row.residence_address,
      officeAddress: row.office_address,
      familyMember: row.family_member,
      maritalStatus: row.marital_status,
      hasChild: !!row.has_child,
      noOfChildren: row.no_of_children,
      area: row.area,
      division: row.division,
      district: row.district,
      thana: row.upazila, // DB column kept as `upazila` for backward compat; API/TS field is `thana`
      source: row.source,
      campaignName: row.campaign_name,
      productName: row.product_name,
      otherInfo: row.other_info,
      assignedTo: row.assigned_to,
      assignedBy: row.assigned_by,
      assignedDate: row.assigned_date,
      currentStatus: row.current_status,
      projectedNCP: row.projected_ncp ? Number(row.projected_ncp) : 0,
      collectedNCP: row.collected_ncp ? Number(row.collected_ncp) : 0,
      lastFollowUpDate: row.last_follow_up_date,
      nextFollowUpDate: row.next_follow_up_date,
      nextCallDate: row.next_call_date,
      meetingDate: row.meeting_date,
      sumAssured: row.sum_assured ? Number(row.sum_assured) : 0,
      priority: row.priority,
      meetingType: row.meeting_type,
      lossReason: row.loss_reason,
      followUpType: row.followup_type,
      creationDate: row.creation_date,
      timestamp: row.timestamp || row.creation_date,
      statusHistory: history,
      customFields,
      assignmentHistory,
      documents,
    };
  }

  const LEAD_COLUMNS = [
    'id', 'prospect_name', 'mobile', 'mobile_number', 'email', 'profession', 'occupation',
    'residence_address', 'office_address', 'family_member', 'marital_status', 'has_child', 'no_of_children',
    'area', 'division', 'district', 'upazila', 'source', 'campaign_name', 'product_name', 'other_info',
    'assigned_to', 'assigned_by', 'assigned_date', 'current_status', 'projected_ncp', 'collected_ncp',
    'last_follow_up_date', 'next_follow_up_date', 'next_call_date', 'meeting_date', 'sum_assured',
    'priority', 'meeting_type', 'loss_reason', 'followup_type', 'creation_date', 'status_history', 'timestamp', 'custom_fields',
    'assignment_history', 'documents',
  ];

  function leadUpsertQuery() {
    const placeholders = LEAD_COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = LEAD_COLUMNS.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(',\n          ');
    return `
        INSERT INTO leads (${LEAD_COLUMNS.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT (id) DO UPDATE SET
          ${updateSet}
        RETURNING *
      `;
  }

  function leadUpsertValues(lead: any) {
    return [
      lead.id, lead.prospectName || '', lead.mobile || '', lead.mobileNumber || '', lead.email || '',
      lead.profession || '', lead.occupation || '', lead.residenceAddress || '', lead.officeAddress || '',
      lead.familyMember || '', lead.maritalStatus || '', !!lead.hasChild, lead.noOfChildren || '',
      lead.area || '', lead.division || '', lead.district || '', lead.thana || '', lead.source || '',
      lead.campaignName || '', lead.productName || '', lead.otherInfo || '',
      lead.assignedTo || '', lead.assignedBy || '', lead.assignedDate || '', lead.currentStatus || '',
      lead.projectedNCP || 0, lead.collectedNCP || 0,
      lead.lastFollowUpDate || '', lead.nextFollowUpDate || '', lead.nextCallDate || '', lead.meetingDate || '',
      lead.sumAssured || 0, lead.priority || '', lead.meetingType || '', lead.lossReason || '', lead.followUpType || '',
      lead.creationDate || '', JSON.stringify(lead.statusHistory || []), lead.timestamp || new Date().toISOString(),
      JSON.stringify(lead.customFields || {}),
      JSON.stringify(lead.assignmentHistory || []), JSON.stringify(lead.documents || []),
    ];
  }

  // Get all leads - scoped to what the requester is allowed to see.
  app.get('/api/leads', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM leads ORDER BY timestamp DESC');
      const scopedIds = await getScopedEmployeeIds(req.currentUser!.employeeId, req.currentUser!.role);
      let rows = result.rows;
      if (scopedIds) {
        rows = rows.filter(r => scopedIds.has(r.assigned_to) || scopedIds.has(r.assigned_by));
      }
      res.json(rows.map(formatLeadRow));
    } catch (err: any) {
      console.error('Error fetching leads:', err);
      res.status(500).json({ error: 'Database fetch failed', details: err.message });
    }
  });

  // Create / Update lead (Upsert)
  app.post('/api/leads', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const result = await pool.query(leadUpsertQuery(), leadUpsertValues(req.body));
      res.json({ success: true, lead: formatLeadRow(result.rows[0]) });
    } catch (err: any) {
      console.error('Error upserting lead:', err);
      res.status(500).json({ error: 'Upsert failed', details: err.message });
    }
  });

  // Bidirectional Leads sync
  app.post('/api/leads/sync', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localLeads, deletedLeadIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedLeadIds) && deletedLeadIds.length > 0) {
        await pool.query('DELETE FROM leads WHERE id = ANY($1)', [deletedLeadIds]);
      }

      if (Array.isArray(localLeads)) {
        const query = leadUpsertQuery().replace('RETURNING *', ''); // bulk path doesn't need the row back
        for (const lead of localLeads) {
          await pool.query(query, leadUpsertValues(lead));
          syncCount++;
        }
      }

      const result = await pool.query('SELECT * FROM leads ORDER BY timestamp DESC');
      res.json({ success: true, processed: syncCount, cloudLeads: result.rows.map(formatLeadRow) });
    } catch (err: any) {
      console.error('Leads sync failed:', err);
      res.status(500).json({ error: 'Leads sync failure', details: err.message });
    }
  });

  // Delete lead
  app.delete('/api/leads/:id', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete lead failed:', err);
      res.status(500).json({ error: 'Delete failed', details: err.message });
    }
  });

  // Delete campaign leads
  app.delete('/api/leads/campaign/:campaignName', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, count: 0 });
    try {
      const result = await pool.query('DELETE FROM leads WHERE LOWER(TRIM(campaign_name)) = LOWER(TRIM($1))', [req.params.campaignName]);
      res.json({ success: true, count: result.rowCount });
    } catch (err: any) {
      console.error('Delete campaign leads failed:', err);
      res.status(500).json({ error: 'Delete failure', details: err.message });
    }
  });

  // Clear all leads
  app.post('/api/leads/clear-all', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM leads');
      res.json({ success: true });
    } catch (err: any) {
      console.error('Clear leads failed:', err);
      res.status(500).json({ error: 'Clear failed', details: err.message });
    }
  });


  // --- WORKFLOW ENGINE (Phase 3) ---
  function formatWorkflowRuleRow(row: any) {
    let allowedNext: string[] | null = null;
    try {
      allowedNext = row.allowed_next_statuses ? JSON.parse(row.allowed_next_statuses) : null;
    } catch {
      allowedNext = null;
    }
    return {
      id: row.id,
      status: row.status,
      allowedNextStatuses: allowedNext, // null = unrestricted (any status allowed)
      requiresLossReason: !!row.requires_loss_reason,
      requiresMeetingType: !!row.requires_meeting_type,
      requiresFollowUpType: !!row.requires_followup_type,
      requiresNote: !!row.requires_note,
      isSystem: !!row.is_system,
      createdDate: row.created_date,
    };
  }

  app.get('/api/workflow-rules', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM workflow_rules ORDER BY status ASC');
      res.json(result.rows.map(formatWorkflowRuleRow));
    } catch (err: any) {
      console.error('Error fetching workflow rules:', err);
      res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
  });

  app.post('/api/workflow-rules', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { status, allowedNextStatuses, requiresLossReason, requiresMeetingType, requiresFollowUpType, requiresNote } = req.body;
      if (!status) return res.status(400).json({ error: 'status is required.' });
      const id = req.body.id || `wf_${String(status).trim().replace(/\s+/g, '_')}`;

      const result = await pool.query(
        `INSERT INTO workflow_rules (id, status, allowed_next_statuses, requires_loss_reason, requires_meeting_type, requires_followup_type, requires_note, is_system, created_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE((SELECT is_system FROM workflow_rules WHERE id = $1), FALSE), $8)
         ON CONFLICT (id) DO UPDATE SET
           allowed_next_statuses = EXCLUDED.allowed_next_statuses,
           requires_loss_reason = EXCLUDED.requires_loss_reason,
           requires_meeting_type = EXCLUDED.requires_meeting_type,
           requires_followup_type = EXCLUDED.requires_followup_type,
           requires_note = EXCLUDED.requires_note
         RETURNING *`,
        [
          id, status,
          Array.isArray(allowedNextStatuses) ? JSON.stringify(allowedNextStatuses) : null,
          !!requiresLossReason, !!requiresMeetingType, !!requiresFollowUpType, !!requiresNote,
          req.body.createdDate || new Date().toISOString(),
        ]
      );
      res.json(formatWorkflowRuleRow(result.rows[0]));
    } catch (err: any) {
      console.error('Save workflow rule failed:', err);
      res.status(500).json({ error: 'Save failed', details: err.message });
    }
  });

  app.delete('/api/workflow-rules/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM workflow_rules WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete workflow rule failed:', err);
      res.status(500).json({ error: 'Delete failed', details: err.message });
    }
  });

  // --- DYNAMIC FORM BUILDER (Phase 2) ---
  function formatFormFieldRow(row: any) {
    return {
      id: row.id,
      fieldKey: row.field_key,
      label: row.label,
      fieldType: row.field_type,
      section: row.section,
      isMandatory: !!row.is_mandatory,
      isVisible: !!row.is_visible,
      sortOrder: row.sort_order ?? 0,
      metadataTypeKey: row.metadata_type_key || null,
      placeholder: row.placeholder || '',
      isSystem: !!row.is_system,
      createdDate: row.created_date,
    };
  }

  app.get('/api/form-fields', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM form_fields ORDER BY section ASC, sort_order ASC');
      res.json(result.rows.map(formatFormFieldRow));
    } catch (err: any) {
      console.error('Error fetching form fields:', err);
      res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
  });

  app.post('/api/form-fields', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { fieldKey, label, fieldType, section, isMandatory, isVisible, sortOrder, metadataTypeKey, placeholder } = req.body;
      const id = req.body.id || `ff_${String(fieldKey).trim().replace(/\s+/g, '_')}_${Date.now()}`;

      let effectiveSortOrder = sortOrder;
      if (effectiveSortOrder === undefined || effectiveSortOrder === null) {
        const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max FROM form_fields WHERE section = $1', [section || 'Additional']);
        effectiveSortOrder = parseInt(maxRes.rows[0].max, 10) + 1;
      }

      const result = await pool.query(
        `INSERT INTO form_fields (id, field_key, label, field_type, section, is_mandatory, is_visible, sort_order, metadata_type_key, placeholder, is_system, created_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE((SELECT is_system FROM form_fields WHERE id = $1), FALSE), $11)
         ON CONFLICT (id) DO UPDATE SET
           label = EXCLUDED.label,
           field_type = EXCLUDED.field_type,
           section = EXCLUDED.section,
           is_mandatory = EXCLUDED.is_mandatory,
           is_visible = EXCLUDED.is_visible,
           sort_order = EXCLUDED.sort_order,
           metadata_type_key = EXCLUDED.metadata_type_key,
           placeholder = EXCLUDED.placeholder
         RETURNING *`,
        [id, fieldKey, label, fieldType || 'text', section || 'Additional', !!isMandatory, isVisible !== false, effectiveSortOrder, metadataTypeKey || null, placeholder || '', req.body.createdDate || new Date().toISOString()]
      );
      res.json(formatFormFieldRow(result.rows[0]));
    } catch (err: any) {
      console.error('Add/update form field failed:', err);
      res.status(500).json({ error: 'Save failed', details: err.message });
    }
  });

  app.delete('/api/form-fields/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { id } = req.params;
      const existing = await pool.query('SELECT is_system FROM form_fields WHERE id = $1', [id]);
      if (existing.rows[0]?.is_system) {
        return res.status(400).json({ error: 'System fields cannot be deleted - you can hide them instead.' });
      }
      await pool.query('DELETE FROM form_fields WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete form field failed:', err);
      res.status(500).json({ error: 'Delete failed', details: err.message });
    }
  });

  app.post('/api/form-fields/reorder', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds must be an array.' });
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await pool.query('UPDATE form_fields SET sort_order = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
      }
      res.json({ success: true });
    } catch (err: any) {
      console.error('Reorder form fields failed:', err);
      res.status(500).json({ error: 'Reorder failed', details: err.message });
    }
  });

  // --- METADATA ENGINE ---
  // Helper: DB row -> API shape for an option/metadata-value.
  function formatOptionRow(row: any) {
    let meta: any = {};
    try {
      meta = row.meta ? JSON.parse(row.meta) : {};
    } catch {
      meta = {};
    }
    return {
      id: row.id,
      type: row.type,
      value: row.value,
      label: row.label || row.value,
      status: row.status,
      sortOrder: row.sort_order ?? 0,
      meta,
      createdDate: row.created_date,
    };
  }

  // List the registry of admin-configurable metadata types
  // (Profession, Lead Source, Lead Status, Loss Reason, ...).
  app.get('/api/metadata-types', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM metadata_types ORDER BY sort_order ASC, label ASC');
      res.json(result.rows.map(r => ({
        key: r.key,
        label: r.label,
        description: r.description,
        isSystem: !!r.is_system,
        sortOrder: r.sort_order,
      })));
    } catch (err: any) {
      console.error('Error fetching metadata types:', err);
      res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
  });

  // Create a new custom metadata type (e.g. Admin adds "Industry").
  app.post('/api/metadata-types', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { key, label, description } = req.body;
      if (!key || !label) {
        return res.status(400).json({ error: 'key and label are required.' });
      }
      const normalizedKey = String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const countRes = await pool.query('SELECT COUNT(*) as count FROM metadata_types');
      const nextOrder = parseInt(countRes.rows[0].count, 10) + 1;
      const result = await pool.query(
        `INSERT INTO metadata_types (key, label, description, is_system, sort_order)
         VALUES ($1, $2, $3, FALSE, $4)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description
         RETURNING *`,
        [normalizedKey, label, description || '', nextOrder]
      );
      res.json(result.rows[0]);
    } catch (err: any) {
      console.error('Create metadata type failed:', err);
      res.status(500).json({ error: 'Create failed', details: err.message });
    }
  });

  // Delete a custom metadata type (system types like lead_status can't be removed).
  app.delete('/api/metadata-types/:key', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { key } = req.params;
      const existing = await pool.query('SELECT is_system FROM metadata_types WHERE key = $1', [key]);
      if (existing.rows[0]?.is_system) {
        return res.status(400).json({ error: 'This is a system metadata type and cannot be deleted.' });
      }
      await pool.query('DELETE FROM metadata_types WHERE key = $1', [key]);
      await pool.query('DELETE FROM options WHERE type = $1', [key]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete metadata type failed:', err);
      res.status(500).json({ error: 'Delete failed', details: err.message });
    }
  });

  // --- OPTIONS (metadata VALUES) CRUD ---
  // Get all options, sorted for consistent dropdown/pipeline ordering.
  app.get('/api/options', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM options ORDER BY type ASC, sort_order ASC, value ASC');
      res.json(result.rows.map(formatOptionRow));
    } catch (err: any) {
      console.error('Error fetching options:', err);
      res.status(500).json({ error: 'Fetch failed', details: err.message });
    }
  });

  // Add / Update a metadata value (label, sort order, and arbitrary
  // per-type metadata like a status color or "requires note" flag).
  app.post('/api/options', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { type, value, status, label, sortOrder, meta } = req.body;
      const id = req.body.id || `${type}_${String(value).trim().replace(/\s+/g, '_')}`;

      // Auto-assign the next sort order if not provided, so new values
      // land at the end of the list instead of all defaulting to 0.
      let effectiveSortOrder = sortOrder;
      if (effectiveSortOrder === undefined || effectiveSortOrder === null) {
        const maxRes = await pool.query('SELECT COALESCE(MAX(sort_order), 0) as max FROM options WHERE type = $1', [type]);
        effectiveSortOrder = parseInt(maxRes.rows[0].max, 10) + 1;
      }

      const query = `
        INSERT INTO options (id, type, value, label, status, sort_order, meta, created_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          value = EXCLUDED.value,
          label = EXCLUDED.label,
          status = EXCLUDED.status,
          sort_order = EXCLUDED.sort_order,
          meta = EXCLUDED.meta
        RETURNING *
      `;
      const result = await pool.query(query, [
        id, type, value, label || value, status || 'Active', effectiveSortOrder,
        meta ? JSON.stringify(meta) : null,
        req.body.createdDate || new Date().toISOString(),
      ]);
      res.json(formatOptionRow(result.rows[0]));
    } catch (err: any) {
      console.error('Add option failed:', err);
      res.status(500).json({ error: 'Add failure', details: err.message });
    }
  });

  // Bulk reorder values within a type (drag/reorder in the admin UI).
  app.post('/api/options/reorder', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { orderedIds } = req.body; // array of option ids, in the new desired order
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: 'orderedIds must be an array.' });
      }
      for (let i = 0; i < orderedIds.length; i++) {
        await pool.query('UPDATE options SET sort_order = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
      }
      res.json({ success: true });
    } catch (err: any) {
      console.error('Reorder options failed:', err);
      res.status(500).json({ error: 'Reorder failed', details: err.message });
    }
  });

  // Options sync
  app.post('/api/options/sync', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localOptions, deletedOptionIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedOptionIds) && deletedOptionIds.length > 0) {
        await pool.query('DELETE FROM options WHERE id = ANY($1)', [deletedOptionIds]);
      }

      if (Array.isArray(localOptions)) {
        for (const opt of localOptions) {
          const { id, type, value, status, label, sortOrder, meta } = opt;
          const query = `
            INSERT INTO options (id, type, value, label, status, sort_order, meta, created_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              type = EXCLUDED.type,
              value = EXCLUDED.value,
              label = EXCLUDED.label,
              status = EXCLUDED.status,
              sort_order = EXCLUDED.sort_order,
              meta = EXCLUDED.meta
          `;
          await pool.query(query, [
            id, type, value, label || value, status || 'Active', sortOrder ?? 0,
            meta ? JSON.stringify(meta) : null,
            opt.createdDate || new Date().toISOString(),
          ]);
          syncCount++;
        }
      }

      const latest = await pool.query('SELECT * FROM options ORDER BY type ASC, sort_order ASC');
      res.json({ success: true, processed: syncCount, cloudOptions: latest.rows.map(formatOptionRow) });
    } catch (err: any) {
      console.error('Options sync failed:', err);
      res.status(500).json({ error: 'Options sync failed', details: err.message });
    }
  });

  // Delete option
  app.delete('/api/options/:type/:value', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      const { type, value } = req.params;
      const id = `${type}_${value.trim().replace(/\s+/g, '_')}`;
      await pool.query('DELETE FROM options WHERE id = $1', [id]);
      res.json({ success: true });
    } catch (err: any) {
      console.error('Delete option failed:', err);
      res.status(500).json({ error: 'Delete option failed', details: err.message });
    }
  });


  // --- DEPARTMENTS CRUD ---
  // Get departments
  app.get('/api/departments', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM departments');
      const formatted = result.rows.map(row => ({
        id: row.id,
        name: row.name,
        createdDate: row.created_date
      }));
      res.json(formatted);
    } catch (err) {
      console.error('Error fetching departments:', err);
      res.json([]);
    }
  });

  // Save/Upsert department
  app.post('/api/departments', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { id, name, createdDate } = req.body;
      const query = `
        INSERT INTO departments (id, name, created_date)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          created_date = EXCLUDED.created_date
      `;
      await pool.query(query, [id, name, createdDate]);
      res.json(req.body);
    } catch (err) {
      console.error('Error saving department:', err);
      res.status(500).json({ error: 'Save failed' });
    }
  });

  // Delete department
  app.delete('/api/departments/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM departments WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting department:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Departments sync
  app.post('/api/departments/sync', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localDepartments, deletedDepartmentIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedDepartmentIds) && deletedDepartmentIds.length > 0) {
        await pool.query('DELETE FROM departments WHERE id = ANY($1)', [deletedDepartmentIds]);
      }

      if (Array.isArray(localDepartments)) {
        for (const dept of localDepartments) {
          const { id, name, createdDate } = dept;
          const query = `
            INSERT INTO departments (id, name, created_date)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              created_date = EXCLUDED.created_date
          `;
          await pool.query(query, [id, name, createdDate]);
          syncCount++;
        }
      }

      const latest = await pool.query('SELECT * FROM departments');
      const formatted = latest.rows.map(row => ({
        id: row.id,
        name: row.name,
        createdDate: row.created_date
      }));
      res.json({ success: true, processed: syncCount, cloudDepartments: formatted });
    } catch (err: any) {
      console.error('Departments sync failed:', err);
      res.status(500).json({ error: 'Departments sync failed', details: err.message });
    }
  });


  // --- HIERARCHIES CRUD ---
  // Get hierarchies
  app.get('/api/hierarchies', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM hierarchies');
      const formatted = result.rows.map(row => {
        let layers = [];
        try {
          layers = row.layers ? JSON.parse(row.layers) : [];
        } catch (e) {
          layers = [];
        }
        return {
          id: row.id,
          departmentId: row.department_id,
          layers,
          updatedAt: row.updated_at
        };
      });
      res.json(formatted);
    } catch (err) {
      console.error('Error fetching hierarchies:', err);
      res.json([]);
    }
  });

  // Save hierarchy
  app.post('/api/hierarchies', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { id, departmentId, layers, updatedAt } = req.body;
      const layersJson = JSON.stringify(layers || []);
      const query = `
        INSERT INTO hierarchies (id, department_id, layers, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          department_id = EXCLUDED.department_id,
          layers = EXCLUDED.layers,
          updated_at = EXCLUDED.updated_at
      `;
      await pool.query(query, [id, departmentId, layersJson, updatedAt]);
      res.json(req.body);
    } catch (err) {
      console.error('Error saving hierarchy:', err);
      res.status(500).json({ error: 'Save failed' });
    }
  });

  // Hierarchies sync
  app.post('/api/hierarchies/sync', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localHierarchies, deletedHierarchyIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedHierarchyIds) && deletedHierarchyIds.length > 0) {
        await pool.query('DELETE FROM hierarchies WHERE id = ANY($1)', [deletedHierarchyIds]);
      }

      if (Array.isArray(localHierarchies)) {
        for (const hier of localHierarchies) {
          const { id, departmentId, layers, updatedAt } = hier;
          const layersJson = JSON.stringify(layers || []);
          const query = `
            INSERT INTO hierarchies (id, department_id, layers, updated_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (id) DO UPDATE SET
              department_id = EXCLUDED.department_id,
              layers = EXCLUDED.layers,
              updated_at = EXCLUDED.updated_at
          `;
          await pool.query(query, [id, departmentId, layersJson, updatedAt]);
          syncCount++;
        }
      }

      const latest = await pool.query('SELECT * FROM hierarchies');
      const formatted = latest.rows.map(row => {
        let layers = [];
        try {
          layers = row.layers ? JSON.parse(row.layers) : [];
        } catch (e) {}
        return {
          id: row.id,
          departmentId: row.department_id,
          layers,
          updatedAt: row.updated_at
        };
      });
      res.json({ success: true, processed: syncCount, cloudHierarchies: formatted });
    } catch (err: any) {
      console.error('Hierarchies sync failed:', err);
      res.status(500).json({ error: 'Hierarchies sync failed', details: err.message });
    }
  });


  // --- ROLES/PERMISSIONS CRUD ---
  // Get all roles
  app.get('/api/roles', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM roles');
      const formatted = result.rows.map(row => {
        let menuAccess = {};
        let actions = {};
        let featurePermissions = {};
        try {
          menuAccess = row.menu_access ? JSON.parse(row.menu_access) : {};
        } catch (e) {}
        try {
          actions = row.actions ? JSON.parse(row.actions) : {};
        } catch (e) {}
        try {
          featurePermissions = row.feature_permissions ? JSON.parse(row.feature_permissions) : {};
        } catch (e) {}
        return {
          roleId: row.role_id,
          roleName: row.role_name,
          menuAccess,
          dataVisibility: row.data_visibility,
          actions,
          featurePermissions
        };
      });
      res.json(formatted);
    } catch (err) {
      console.error('Error fetching roles:', err);
      res.json([]);
    }
  });

  // Save/Upsert role
  app.post('/api/roles', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { roleId, roleName, menuAccess, dataVisibility, actions, featurePermissions } = req.body;
      const menuAccessJson = JSON.stringify(menuAccess || {});
      const actionsJson = JSON.stringify(actions || {});
      const featurePermissionsJson = JSON.stringify(featurePermissions || {});
      const query = `
        INSERT INTO roles (role_id, role_name, menu_access, data_visibility, actions, feature_permissions)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (role_id) DO UPDATE SET
          role_name = EXCLUDED.role_name,
          menu_access = EXCLUDED.menu_access,
          data_visibility = EXCLUDED.data_visibility,
          actions = EXCLUDED.actions,
          feature_permissions = EXCLUDED.feature_permissions
      `;
      await pool.query(query, [roleId, roleName, menuAccessJson, dataVisibility, actionsJson, featurePermissionsJson]);
      res.json(req.body);
    } catch (err) {
      console.error('Error saving role:', err);
      res.status(500).json({ error: 'Save failed' });
    }
  });

  // Delete role
  app.delete('/api/roles/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM roles WHERE role_id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting role:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Roles sync
  app.post('/api/roles/sync', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localRoles, deletedRoleIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedRoleIds) && deletedRoleIds.length > 0) {
        await pool.query('DELETE FROM roles WHERE role_id = ANY($1)', [deletedRoleIds]);
      }

      if (Array.isArray(localRoles)) {
        for (const role of localRoles) {
          const { roleId, roleName, menuAccess, dataVisibility, actions, featurePermissions } = role;
          const menuAccessJson = JSON.stringify(menuAccess || {});
          const actionsJson = JSON.stringify(actions || {});
          const featurePermissionsJson = JSON.stringify(featurePermissions || {});
          const query = `
            INSERT INTO roles (role_id, role_name, menu_access, data_visibility, actions, feature_permissions)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (role_id) DO UPDATE SET
              role_name = EXCLUDED.role_name,
              menu_access = EXCLUDED.menu_access,
              data_visibility = EXCLUDED.data_visibility,
              actions = EXCLUDED.actions,
              feature_permissions = EXCLUDED.feature_permissions
          `;
          await pool.query(query, [roleId, roleName, menuAccessJson, dataVisibility, actionsJson, featurePermissionsJson]);
          syncCount++;
        }
      }

      const latest = await pool.query('SELECT * FROM roles');
      const formatted = latest.rows.map(row => {
        let menuAccess = {};
        let actions = {};
        let featurePermissions = {};
        try {
          menuAccess = row.menu_access ? JSON.parse(row.menu_access) : {};
        } catch (e) {}
        try {
          actions = row.actions ? JSON.parse(row.actions) : {};
        } catch (e) {}
        try {
          featurePermissions = row.feature_permissions ? JSON.parse(row.feature_permissions) : {};
        } catch (e) {}
        return {
          roleId: row.role_id,
          roleName: row.role_name,
          menuAccess,
          dataVisibility: row.data_visibility,
          actions,
          featurePermissions
        };
      });
      res.json({ success: true, processed: syncCount, cloudRoles: formatted });
    } catch (err: any) {
      console.error('Roles sync failed:', err);
      res.status(500).json({ error: 'Roles sync failed', details: err.message });
    }
  });


  // --- TEAMS CRUD ---
  // Get all teams
  app.get('/api/teams', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query('SELECT * FROM teams');
      const formatted = result.rows.map(row => {
        let memberIds = [];
        try {
          memberIds = row.member_ids ? JSON.parse(row.member_ids) : [];
        } catch (e) {}
        return {
          id: row.id,
          name: row.name,
          leaderId: row.leader_id,
          leaderName: row.leader_name,
          memberIds,
          createdDate: row.created_date,
          departmentId: row.department_id
        };
      });
      res.json(formatted);
    } catch (err) {
      console.error('Error fetching teams:', err);
      res.json([]);
    }
  });

  // Save/Upsert team
  app.post('/api/teams', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { id, name, leaderId, leaderName, memberIds, createdDate, departmentId } = req.body;
      const memberIdsJson = JSON.stringify(memberIds || []);
      const query = `
        INSERT INTO teams (id, name, leader_id, leader_name, member_ids, created_date, department_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          leader_id = EXCLUDED.leader_id,
          leader_name = EXCLUDED.leader_name,
          member_ids = EXCLUDED.member_ids,
          created_date = EXCLUDED.created_date,
          department_id = EXCLUDED.department_id
      `;
      await pool.query(query, [id, name, leaderId, leaderName, memberIdsJson, createdDate, departmentId]);
      res.json(req.body);
    } catch (err) {
      console.error('Error saving team:', err);
      res.status(500).json({ error: 'Save failed' });
    }
  });

  // Delete team
  app.delete('/api/teams/:id', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting team:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Teams sync
  app.post('/api/teams/sync', requireAuth, requireRole('ADMIN'), async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true, processed: 0 });
    try {
      const { localTeams, deletedTeamIds } = req.body;
      let syncCount = 0;

      if (Array.isArray(deletedTeamIds) && deletedTeamIds.length > 0) {
        await pool.query('DELETE FROM teams WHERE id = ANY($1)', [deletedTeamIds]);
      }

      if (Array.isArray(localTeams)) {
        for (const team of localTeams) {
          const { id, name, leaderId, leaderName, memberIds, createdDate, departmentId } = team;
          const memberIdsJson = JSON.stringify(memberIds || []);
          const query = `
            INSERT INTO teams (id, name, leader_id, leader_name, member_ids, created_date, department_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO UPDATE SET
              name = EXCLUDED.name,
              leader_id = EXCLUDED.leader_id,
              leader_name = EXCLUDED.leader_name,
              member_ids = EXCLUDED.member_ids,
              created_date = EXCLUDED.created_date,
              department_id = EXCLUDED.department_id
          `;
          await pool.query(query, [id, name, leaderId, leaderName, memberIdsJson, createdDate, departmentId]);
          syncCount++;
        }
      }

      const latest = await pool.query('SELECT * FROM teams');
      const formatted = latest.rows.map(row => {
        let memberIds = [];
        try {
          memberIds = row.member_ids ? JSON.parse(row.member_ids) : [];
        } catch (e) {}
        return {
          id: row.id,
          name: row.name,
          leaderId: row.leader_id,
          leaderName: row.leader_name,
          memberIds,
          createdDate: row.created_date,
          departmentId: row.department_id
        };
      });
      res.json({ success: true, processed: syncCount, cloudTeams: formatted });
    } catch (err: any) {
      console.error('Teams sync failed:', err);
      res.status(500).json({ error: 'Teams sync failed', details: err.message });
    }
  });


  // --- NOTIFICATIONS CRUD ---
  // Get all notifications for a specific user
  // Notification history for a single lead (Lead Timeline - Phase 4).
  app.get('/api/notifications/leads/:leadId', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json([]);
    try {
      const result = await pool.query(
        'SELECT * FROM notifications WHERE lead_id = $1 ORDER BY date DESC',
        [req.params.leadId]
      );
      const formatted = result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        title: row.title,
        message: row.message,
        leadId: row.lead_id,
        read: row.read,
        date: row.date
      }));
      res.json(formatted);
    } catch (err) {
      console.error('Error fetching lead notification history:', err);
      res.json([]);
    }
  });


  // Create notifications
  app.post('/api/notifications', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json(req.body);
    try {
      const { id, userId, title, message, leadId, read, date } = req.body;
      const query = `
        INSERT INTO notifications (id, user_id, title, message, lead_id, read, date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          title = EXCLUDED.title,
          message = EXCLUDED.message,
          lead_id = EXCLUDED.lead_id,
          read = EXCLUDED.read,
          date = EXCLUDED.date
      `;
      await pool.query(query, [id, userId, title, message, leadId, read || false, date]);
      res.json(req.body);
    } catch (err) {
      console.error('Error creating notification:', err);
      res.status(500).json({ error: 'Create failed' });
    }
  });

  // Mark specific notification as read
  app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('UPDATE notifications SET read = TRUE WHERE id = $1', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error marking notification as read:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Mark all notifications for user as read
  app.post('/api/notifications/users/:userId/read-all', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('UPDATE notifications SET read = TRUE WHERE user_id = $1', [req.params.userId]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error marking all notifications read:', err);
      res.status(500).json({ error: 'Operation failed' });
    }
  });

  // Delete all notifications for user
  app.delete('/api/notifications/users/:userId', requireAuth, async (req, res) => {
    const pool = getPool();
    if (!pool) return res.json({ success: true });
    try {
      await pool.query('DELETE FROM notifications WHERE user_id = $1', [req.params.userId]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting user notifications:', err);
      res.status(500).json({ error: 'Delete failed' });
    }
  });


  // ==========================================
  // Vite HMR and Single-Page Application (SPA) Serving
  // ==========================================
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    }).then((vite) => {
      app.use(vite.middlewares);
      console.log('⚡ Vite development middleware applied.');
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Full-Stack application running on http://0.0.0.0:${PORT}`);
      });
    }).catch((err) => {
      console.error('Failed to create Vite server:', err);
    });
  } else if (!process.env.VERCEL) {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Full-Stack application running on http://0.0.0.0:${PORT}`);
    });
  }

export default app;
