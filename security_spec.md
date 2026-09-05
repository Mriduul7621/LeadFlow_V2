# Security Specification and Data Invariants

This document outlines the strict secure access control framework designed for the overhauled Shanta Life Lead Dashboard, implementing Zero-Trust Attribute-Based Access Control (ABAC) driven by the dynamic organizational hierarchy.

---

## 1. Data Invariants

1. **System Admin Universal Gate:** Users with the dynamic role `superadmin` or the system role ID `ADMIN` possess global unrestricted access bypassing standard hierarchy and department checks.
2. **Access Isolation by Department:** Except for users with `Organization` visibility scope or `superadmin` credentials, users are restricted to viewing and manipulating resource data belonging to their assigned `departmentId`.
3. **Data Visibility Scoping Constraints:**
   - **Own Data View (`Own`):** Users can only read/write documents where the record's `assignedTo` matches their personal `employeeId`.
   - **Down the Team View (`DownTeam`):** Users can read/write documents where the record's `assignedTo` is present inside their cached `subordinates` array.
   - **Full Team View (`FullTeam`):** Users can read/write documents where the record's `assignedTo` is owned by an employee with the same `departmentId`.
   - **Organizational View (`Organization`):** Unrestricted access across all departments.
4. **Self-Access Privilege Escapes Blocked:** Users are strictly forbidden from editing or escalating their own `role`, `status`, `departmentId`, `reportingChain`, or `subordinates` settings.
5. **Onboarding Enforcement:** If a user profile contains `mustChangePassword == true`, they are blocked from performing standard API/Firestore operations until they complete the forced password rotation.
6. **Immutable Historical Anchors:** Timestamps such as `creationDate` and identifying links like `id`, `employeeId` cannot be mutated after initial document write.

---

## 2. The "Dirty Dozen" Attack Payloads (Adversarial Tests)

Here are twelve adversarial payloads designed to break our database security. Each of these payloads must be blocked, returning an explicit `PERMISSION_DENIED` error.

### Attack 1: Self-Role Elevation Bypass (Identity Spoofing)
An authenticated Relationship Officer (`RO`) attempts to elevate their own system capability to `superadmin` in their profile.
```json
// Path: /users/ro_user_uid
{
  "role": "superadmin"
}
```
*Expected Result: Blocked. User matches request.auth.uid but is attempt-writing a restricted custom claim/role attribute.*

### Attack 2: Invisible Shadow Field Addition (Anti-Update-Gap)
An authenticated user attempts to write a document using an un-modeled field `isSystemSuperAdmin` to bypass standard access checks.
```json
// Path: /users/ro_user_uid
{
  "name": "Jane Doe",
  "employeeId": "RO123",
  "email": "jane@shanta.com",
  "role": "ro_role",
  "status": "Active",
  "createdDate": "2026-06-10T23:24:39Z",
  "mustChangePassword": false,
  "isSystemSuperAdmin": true // GHOST FIELD
}
```
*Expected Result: Blocked. Schema validation checks fail due to strict size match / exact keys.*

### Attack 3: Department Hopping (Data Leak)
An RM in `Sales` attempts to view leads belonging to the `Customer Relations` department.
```json
// Query: leads.where('departmentId', '==', 'dept_customer_relations')
```
*Expected Result: Blocked. User is checked against their own user profile's departmentId or subordinates.*

### Attack 4: Unauthorized Hierarchy Write
A standard user attempts to bypass the Admin panel and write directly to a hierarchy setup to insert themselves as a supervisor.
```json
// Path: /hierarchies/dept_sales_hierarchy
{
  "departmentId": "dept_sales",
  "layers": [
    { "roleId": "sales_manager", "employeeIds": ["ATTACKER_ID"] }
  ]
}
```
*Expected Result: Blocked. Only verified dynamic admins with write permissions on user_management can create/modify hierarchies.*

### Attack 5: PII Identity Scraping (Scraping Threat)
An authenticated Relationship Officer attempts to execute a blanket read (without filters) on the entire users roster directory to extract contacts.
```json
// Query: users
```
*Expected Result: Blocked. Standard list reads must be strictly governed by direct supervisor permissions or filtered queries matching subordinates.*

### Attack 6: Orphaned Lead Injection
An attacker attempts to insert a custom lead assigned to a non-existent Employee ID or an employee in a different department.
```json
// Path: /leads/lead_999
{
  "id": "lead_999",
  "prospectName": "Target Account",
  "mobile": "01700000000",
  "assignedTo": "NON_EXISTENT_ID",
  "currentStatus": "Untouched",
  "projectedNCP": 100000,
  "collectedNCP": 0,
  "creationDate": "2026-06-10T23:24:39Z"
}
```
*Expected Result: Blocked. Relational integrity rules require exists() checks on assigned employee.*

### Attack 7: Status Shortcutting / Skipping Transitions
An agent attempts to transition a lead's status directly from `Untouched` to `Converted` without recording follow-ups.
```json
// Path: /leads/lead_555
{
  "currentStatus": "Converted"
}
```
*Expected Result: Blocked. Transition guards must confirm a valid state transition or check action permissions to override.*

### Attack 8: Denied-Onboarding Action (Gate Lockout)
A newly boarded user who has NOT yet rotated their temporary password (`mustChangePassword == true`) attempts to query the Leads pipeline.
```json
// Query: leads
```
*Expected Result: Blocked. Temporal onboarding state blocks standard reads/writes until password reset completes.*

### Attack 9: Overriding CreatedDate (Temporal Spoofing)
An employee attempts to change a lead's original `creationDate` back into the past to alter active performance metrics.
```json
// Path: /leads/lead_abc
{
  "id": "lead_abc",
  "creationDate": "2020-01-01T00:00:00Z" // MUTATION
}
```
*Expected Result: Blocked. Historical creation date fields remain strictly read-only and immutable.*

### Attack 10: Denial of Wallet Resource Poisoning
An attacker attempts to write a document with an ID that is 500KB of random junk characters to blow up storage indices.
```json
// Path: /leads/<500KB_ID_JUNK_CHARACTERS>
```
*Expected Result: Blocked. String identifier size is capped at 128 characters.*

### Attack 11: Fake Claim Spoofing (Client Claim Injection)
An attacker injects a mock claim `custom_token_admin` on the client application to bypass client-side gates.
```json
// Attempting read with mock claim
```
*Expected Result: Blocked. Security rules bypass client tokens to verify role against trusted `/roles/$(roleId)` documents.*

### Attack 12: Terminated Record Mod (State Poisoning)
An employee attempts to update the SUM value of a lead that has reached the final status `Converted`.
```json
// Path: /leads/lead_finished
{
  "sumAssured": 5000000
}
```
*Expected Result: Blocked. Terminal locks prevent mutations once a lead has reached a finalized pipeline stage.*

---

## 3. Test Verification Strategy

The security rules are validated via comprehensive testing using the Firebase emulator. The suite evaluates security compliance against both optimal pathways and malicious payloads:

```ts
import { initializeTestEnvironment, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';

let testEnv: RulesTestEnvironment;

describe('Zero-Trust Security Matrix', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'ai-studio-bab68fae-dddf-4064-a9c1-9392af0e4c7f',
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8')
      }
    });
  });

  afterAll(async () => {
    await testEnv.cleanup();
  });

  it('blocks self-assigned role elevation (Attack 1)', async () => {
    const unprivilegedContext = testEnv.authenticatedContext('ro_uid', { email: 'ro@shanta.com' });
    await expect(
      unprivilegedContext.firestore().collection('users').doc('ro_uid').update({ role: 'superadmin' })
    ).rejects.toThrow();
  });

  it('rejects custom claim bypass attempts (Attack 11)', async () => {
    const unprivilegedContext = testEnv.authenticatedContext('ro_uid', { custom_token_admin: true });
    await expect(
      unprivilegedContext.firestore().collection('roles').doc('superadmin').get()
    ).rejects.toThrow();
  });
});
```
