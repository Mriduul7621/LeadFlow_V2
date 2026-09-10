# LeadFlow — যা যা ঠিক করা হয়েছে (Summary of Fixes)

## ১. TypeScript Compile Errors (ঠিক করা হয়েছে ✅)
`RolePermission` টাইপ ৪টা ফাইলে ইমপোর্ট হচ্ছিল কিন্তু কোথাও ডিফাইন করা ছিল না —
`npx tsc --noEmit` এ ৪টা এরর দিচ্ছিল। `src/types/index.ts`-এ সঠিক শেপসহ
(`roleId, roleName, menuAccess, dataVisibility, actions, featurePermissions`)
টাইপটা যোগ করা হয়েছে। এখন `tsc --noEmit` এবং `vite build` — দুটোই ক্লিন পাস করে।

## ২. ডেটা-লিক বাগ: হায়ারার্কি ভিজিবিলিটি কাজই করত না (ঠিক করা হয়েছে ✅)
Admin প্যানেল থেকে কোনো রোলের Data Visibility `DownTeam` বা `FullTeam` সেট করলে,
`leadService.ts`-এর ফিল্টার ফাংশন পুরনো `'Team'/'Department'` নাম চেক করত (নতুন
নাম চিনত না), ফলে কোনো `if` না মিলে **নিঃশব্দে সব লিড রিটার্ন** করত। মানে হায়ারার্কি
সেটিংস সেভ হলেও বাস্তবে প্রয়োগ হতো না — যে কেউ পুরো organization-এর লিড দেখতে
পেত। এটা ঠিক করতে নতুন `src/utils/dataScope.ts` বানানো হয়েছে (single source of
truth), এবং `leadService.ts` তা ব্যবহার করছে।

## ৩. সিকিউরিটি — সবচেয়ে গুরুত্বপূর্ণ অংশ (ঠিক করা হয়েছে ✅)
আগের অবস্থা ছিল:
- `Login.tsx`-এ **হার্ডকোডেড ব্যাকডোর**: username `ADMIN` + password `shanta123`
  সবসময় কাজ করত, ফ্রন্টএন্ড বান্ডলে বেক করা — যে কেউ browser dev tools দিয়ে
  দেখলেই পেয়ে যেত।
- পাসওয়ার্ড ছাড়াই কোনো ইউজারের ডিফল্ট পাসওয়ার্ড ছিল `shanta123` (`localDb.ts`,
  `UserManagement.tsx`) — একাধিক জায়গায় এই একই দুর্বল ফলব্যাক ছিল।
- সব পাসওয়ার্ড **plaintext** এ ডাটাবেসে সেভ হতো এবং `GET /api/users`
  **কোনো authentication ছাড়াই** পুরো ইউজার লিস্ট পাসওয়ার্ডসহ ফেরত দিত।
- `server.ts`-এর **কোনো API route-এ কোনো auth middleware ছিল না** — frontend-এর
  permission UI যাই দেখাক, ব্যাকএন্ড API সরাসরি কল করে যে কেউ user/role/lead
  create-update-delete করতে পারত।
- `bcrypt` প্যাকেজ ছিল কিন্তু কোথাও ব্যবহারই হয়নি।

এখন যা করা হয়েছে:
- `server/auth.ts` — bcrypt দিয়ে পাসওয়ার্ড হ্যাশ/ভেরিফাই, এবং signed session
  token (HMAC-SHA256) ইস্যু/ভেরিফাই করার মিডলওয়্যার (`requireAuth`,
  `requireRole`, `requireFeaturePermission`)।
- নতুন `POST /api/auth/login` — পাসওয়ার্ড শুধু সার্ভারে bcrypt দিয়ে ভেরিফাই হয়,
  ব্রাউজারে কখনো পাসওয়ার্ড পাঠানো হয় না। পুরনো plaintext পাসওয়ার্ড থাকলে প্রথম
  সফল লগইনেই স্বয়ংক্রিয়ভাবে bcrypt হ্যাশে upgrade হয়ে যায়।
- `POST /api/auth/change-password` — নিজের পাসওয়ার্ড বদলানোর জন্য secure endpoint।
- সব API route-এ `requireAuth` বসানো হয়েছে; users/roles/departments/hierarchies/
  teams-এর write অপারেশনে `requireRole('ADMIN')` (প্রথম Admin অ্যাকাউন্ট বানানোর
  জন্য শুধু bootstrap কেসে ছাড় দেওয়া আছে — অ্যাপ প্রথমবার সেটআপ করার সময়)।
- `GET /api/users` ও `GET /api/leads` এখন requester-এর হায়ারার্কি scope অনুযায়ী
  সার্ভার-সাইডে ফিল্টার হয় (`server/authz.ts`) — শুধু client-side নয়, এটাই আসল
  security boundary।
- পাসওয়ার্ড ফিল্ড এখন **কখনো API রেসপন্সে ফেরত যায় না**।
- হার্ডকোডেড `shanta123` ব্যাকডোর ও সব fallback default password সরানো হয়েছে;
  নতুন ইউজার তৈরি করলে এখন randomly-generated temporary password দেওয়া হয়
  (admin-কে একবার দেখানো হয়, প্রথম লগইনে বদলাতে বাধ্য করা হয়)।
- `DATABASE_URL` (যাতে DB পাসওয়ার্ড থাকে) আর সার্ভার লগে প্রিন্ট হয় না।

## ৪. এন্টারপ্রাইজ হায়ারার্কি — DB-তে সত্যিকারের persist হচ্ছিল না (ঠিক করা হয়েছে ✅)
`users` টেবিলে `department_id`, `team_id`, `manager_id` কলামই ছিল না — UI থেকে
কাউকে কোনো টিম/ডিপার্টমেন্ট/ম্যানেজারের অধীনে অ্যাসাইন করলে সেটা শুধু browser
`localStorage`-এ থাকত, PostgreSQL-এ কখনো সেভ হতো না। `server/db.ts`-এ এই কলাম ও
আরও কিছু (`employment_status`, `joining_date`, `must_change_password`,
`avatar_url`, `mobile`) migration-safe ভাবে (`ALTER TABLE ... ADD COLUMN IF NOT
EXISTS`) যোগ করা হয়েছে, আর `server.ts`-এর users create/update/sync route এখন এই
সব ফিল্ড সঠিকভাবে সেভ করে।

## ৫. মৃত/অসম্পূর্ণ কোড পরিষ্কার
`server/schema/` ফোল্ডারে ৪টা খালি (0 বাইট) ও ২টা আংশিক ফাইল ছিল যেগুলো
কোথাও ইমপোর্ট-ই হতো না (আসল স্কিমা `server/db.ts`-এ ইনলাইন ছিল) — বিভ্রান্তিকর
dead code হিসেবে পুরো ফোল্ডার সরানো হয়েছে।

## এন্টারপ্রাইজ পারমিশন সিস্টেম কীভাবে কাজ করে
- **৪টা visibility scope**: `Own` (শুধু নিজের) → `DownTeam` (নিজের পুরো
  reporting chain / টিম) → `FullTeam` (পুরো ডিপার্টমেন্ট) → `Organization`
  (পুরো কোম্পানি, CEO/Admin/Business Head লেভেল)।
- Admin প্যানেল (`UserManagement.tsx` → Role Editor) থেকে প্রতিটা রোলের জন্য এই
  স্কোপ + মেনু অ্যাক্সেস + ফিচার পারমিশন সেট করা যায়।
- হায়ারার্কি চলে `managerId` (reporting manager) চেইন ও `departmentId` দিয়ে —
  `TeamHierarchy.tsx` পেজে ভিজ্যুয়ালি অর্গ চার্ট দেখা যায়।
- **গুরুত্বপূর্ণ**: এখন থেকে এই স্কোপ সার্ভার সাইডেও (`server/authz.ts`) এনফোর্স
  হয়, শুধু UI-তে হাইড করে না — তাই কেউ browser থেকে সরাসরি API কল করেও অন্যের
  ডেটা দেখতে পারবে না।

## প্রোডাকশনে যাওয়ার আগে যা করা উচিত
1. `.env`-এ `SESSION_SECRET` সেট করা আছে (এই ডেলিভারিতে জেনারেট করে দেওয়া
   হয়েছে) — এটা env variable হিসেবে রাখুন, কখনো git-এ commit করবেন না।
2. বান্ডেল সাইজ বড় (~1.9MB) — চাইলে পরে code-splitting করে অপ্টিমাইজ করা যায়
   (এটা functional bug না, শুধু পারফরম্যান্স অপটিমাইজেশন)।
3. `SESSION_SECRET` env var ছাড়া সার্ভার restart হলে সব ইউজারকে আবার লগইন
   করতে হবে (token invalidate হয়ে যাবে) — env var সেট থাকলে এই সমস্যা হবে না।
4. এই কাজে সার্ভার আসলে রান করে DB-তে টেস্ট করা হয়নি (production ডাটাবেস, তাই
   ঝুঁকি এড়াতে শুধু compile/build verify করা হয়েছে) — deploy করার পরে একবার
   login flow, user create, আর role visibility ম্যানুয়ালি টেস্ট করে নেবেন।

---

# Phase 1 — Metadata Engine (নতুন সংযোজন)

## যা বানানো হয়েছে

**Backend:**
- `metadata_types` রেজিস্ট্রি টেবিল (কোন কোন dropdown/field type Admin কনফিগার
  করতে পারবে তার তালিকা) + `options` টেবিল extend করা হয়েছে `label`,
  `sort_order`, `meta` (JSON) কলাম দিয়ে।
- বিদ্যমান key গুলোর সাথে align করা হয়েছে যাতে কিছু না ভাঙে: `Area`, `Source`,
  `Product`, `Campaign`, `Profession`, `FollowUpStatus` (এটাই বাস্তবে "Lead
  Status"), `MaritalStatus` — এবং নতুন যোগ হয়েছে `Occupation`, `MeetingType`,
  `LossReason`, `FollowUpType`, `Priority`।
- `FollowUpStatus`-কে `is_system: true` মার্ক করা হয়েছে (delete করা যাবে না)
  — ডিফল্ট ১১টা স্ট্যাটাস + রং (color) + isWon/isLost/isTerminal মেটাডেটাসহ
  DB init-এর সময় সিড হয়।
- নতুন endpoints: `GET/POST/DELETE /api/metadata-types`,
  `POST /api/options/reorder`; `/api/options` এখন label/sortOrder/meta
  সাপোর্ট করে।
- **গুরুত্বপূর্ণ বাড়তি ফিক্স**: audit করে দেখা গেল Lead-এর অনেক ফিল্ড
  (profession, email, address, marital status, area, division ইত্যাদি)
  আসলে PostgreSQL-এ কখনোই সেভ হতো না — শুধু browser-এর localStorage-এ
  থাকত (cloud sync হলে এসব ডেটা হারিয়ে যেত)। `leads` টেবিলে সব প্রয়োজনীয়
  কলাম যোগ করে, আর server.ts-এর leads GET/POST/sync একটা কেন্দ্রীভূত
  `formatLeadRow`/`leadUpsertQuery` হেল্পার দিয়ে rewrite করে এটা ঠিক করা
  হয়েছে।

**Frontend:**
- `src/services/metadataService.ts` — cache-সহ ইউনিফাইড মেটাডেটা ক্লায়েন্ট
  (types + values + reorder + toggle active/inactive)।
- `src/utils/leadStatusMeta.ts` — Lead Status-এর রং/অর্ডার এখন কেন্দ্রীয়ভাবে
  এই util থেকে আসে, safe fallback সহ (ডেটা লোড হওয়ার আগ পর্যন্ত ডিফল্ট ব্যবহার
  হয়, তাই কোনো পেজ ভাঙে না)।
- `Settings.tsx` → নতুন **"Metadata Manager"** UI: dynamic type list (আর
  hardcoded array না), নতুন custom type তৈরি করা যায়, প্রতিটা value-র জন্য
  reorder (up/down), active/inactive toggle, delete, আর Lead Status-এর জন্য
  আলাদা color picker।
- `Dashboard.tsx` ও `LeadList.tsx`-এর hardcoded status color/order
  switch-case এখন নতুন metadata engine থেকে আসে।
- `LeadStatus` টাইপ হার্ডকোডেড union থেকে `string`-এ পরিবর্তন করা হয়েছে
  (admin-configurable করার জন্য দরকার ছিল)।
- `LeadGenerate.tsx` (মূল Lead তৈরির ফর্ম) এ নতুন **Occupation** ও
  **Priority** dropdown যোগ করা হয়েছে, Metadata Engine থেকে dynamically
  লোড হয়।

## এই Phase-এ যা ইচ্ছাকৃতভাবে বাকি রাখা হয়েছে
- **Meeting Type, Loss Reason, Follow-up Type** — backend + Admin Manager
  থেকে এগুলো এখন পুরোপুরি কনফিগারযোগ্য, DB-তে persist হওয়ার জায়গাও প্রস্তুত
  (`meeting_type`, `loss_reason`, `followup_type` কলাম)। কিন্তু এগুলো
  স্বাভাবিকভাবে status-change মুহূর্তে (যেমন "Meeting Fixed" বা "Not
  Interested" মার্ক করার সময়) UI-তে দেখানো উচিত — সেই workflow-integration
  ইচ্ছাকৃতভাবে **Phase 3 (Workflow Engine)** ও **Phase 4 (Lead Timeline)**-এ
  রাখা হয়েছে, যেহেতু সেটা Dashboard.tsx ও LeadList.tsx-এর বড়, জটিল
  status-update modal-এ integrate করতে হবে (risk কমাতে আলাদা ধাপে করা
  ভালো)।
- Dynamic Form Builder (Phase 2) এখনো শুরু হয়নি — এই ধাপ সেটার ভিত্তি তৈরি
  করেছে মাত্র।

## Deploy-এর পর যা টেস্ট করে দেখবেন
1. Settings > Metadata Manager থেকে একটা নতুন value যোগ করে দেখুন সেটা
   Lead Generate ফর্মের dropdown-এ দেখা যাচ্ছে কিনা।
2. Lead Status-এর কোনো একটার রং বদলে দেখুন Dashboard/LeadList-এ badge-এর
   রং বদলায় কিনা।
3. একটা নতুন লিড তৈরি করে, page refresh করে দেখুন profession/email/address
   এর মতো ফিল্ডগুলো টিকে আছে কিনা (আগে এগুলো cloud sync-এ হারিয়ে যেত)।

---

# Phase 2 — Dynamic Form Builder (নতুন সংযোজন)

## যা বানানো হয়েছে

**Backend:**
- `form_fields` টেবিল — প্রতিটা Lead Generate ফর্ম ফিল্ডের কনফিগ রাখে:
  `label`, `fieldType` (text/number/dropdown/date/textarea/checkbox),
  `section`, `isMandatory`, `isVisible`, `sortOrder`, আর dropdown টাইপ
  হলে কোন Metadata Type থেকে ভ্যালু আসবে (`metadataTypeKey`)।
- বিদ্যমান ১৭টা ফিল্ড (prospectName, mobile, profession, occupation,
  priority, maritalStatus, noOfChildren, familyMember, division, district,
  thana, residenceAddress, officeAddress, source, productName, campaignName,
  otherInfo) `is_system: true` হিসেবে সিড করা হয়েছে — Admin এগুলো ডিলিট করতে
  পারবে না, কিন্তু mandatory/visible/order স্বাধীনভাবে বদলাতে পারবে।
- `leads` টেবিলে নতুন `custom_fields` (JSON) কলাম — Admin-এর তৈরি করা যেকোনো
  নতুন ফিল্ডের মান এখানে key-value আকারে জমা থাকে (প্রতিটার জন্য আলাদা কলাম
  বানাতে হয় না)।
- নতুন endpoints: `GET/POST/DELETE /api/form-fields`,
  `POST /api/form-fields/reorder` — সবগুলো লেখা-অপারেশন Admin-only।

**Frontend:**
- `src/services/formBuilderService.ts` — ফিল্ড কনফিগের client, cache সহ।
- `Settings.tsx` → নতুন **"Form Builder"** ট্যাব:
  - "New Field" বাটনে ক্লিক করে Admin নতুন ফিল্ড তৈরি করতে পারবে (label, type,
    dropdown হলে কোন Metadata Type থেকে value আসবে, mandatory কিনা)
  - প্রতিটা ফিল্ডের পাশে: Required/Optional toggle, up/down দিয়ে reorder,
    visible/hidden toggle (Power আইকন), আর non-system ফিল্ডের জন্য delete
- `src/pages/LeadGenerate.tsx` (মূল Lead তৈরির ফর্ম) সম্পূর্ণ **dynamic**
  করা হয়েছে:
  - Zod validation schema এখন `buildLeadSchema()` দিয়ে **runtime-এ তৈরি
    হয়** Admin-এর mandatory সেটিং অনুযায়ী — কোনো ফিল্ড Optional করে দিলে
    ফর্ম আর সেটা চাইবে না, Required করলে দিলে বাধ্য করবে।
  - প্রতিটা built-in ফিল্ড এখন Admin-এর visibility সেটিং মেনে চলে (hidden
    করলে ফর্ম থেকে সেই field আসলেই সরে যায়)।
  - `prospectName` আর `mobile` — এই দুইটা ফিল্ড ইচ্ছাকৃতভাবে সবসময় visible
    রাখা হয়েছে (Admin visibility সেটিং দিয়ে এগুলো হাইড করা যাবে না), যাতে
    ভুলবশত পুরো লিড তৈরি প্রক্রিয়া ভেঙে না যায় — এটা একটা সুরক্ষা গার্ডরেল।
  - **বাড়তি বাগ ফিক্স**: `residenceAddress`, `officeAddress`, `otherInfo`,
    `familyMember` — এই ৪টা ফিল্ড ফর্মের validation schema-তে ছিল কিন্তু UI-তে
    কখনো render-ই হতো না (orphan fields, ব্যবহারকারী এগুলো পূরণ করতেই পারত
    না)। এখন এগুলো visible এবং Admin visibility/mandatory নিয়ন্ত্রণ করতে
    পারবে।
  - Admin-এর তৈরি নতুন custom field automatically একটা নতুন **"Additional
    Information"** সেকশনে render হয়, field type অনুযায়ী সঠিক input (text/
    number/dropdown/date/textarea/yes-no) দেখায়, আর মান
    `lead.customFields` এ জমা হয়ে cloud database-এ সেভ হয়।

## এই Phase-এ যা ইচ্ছাকৃতভাবে বাকি রাখা হয়েছে
- **Field reordering শুধু নিজ নিজ Section-এর মধ্যে কাজ করে** (Identity,
  Location, Business, Additional) — এক section থেকে আরেক section-এ কোনো
  built-in field সরানো যায় না, কারণ Location section-এর division/district/
  thana ফিল্ডগুলোর নিজস্ব cascading (একটার উপর আরেকটা নির্ভরশীল) লজিক আছে যা
  সেই section-এর কাঠামোর সাথে জড়িত। Custom field-গুলো সবসময় "Additional"
  section-এ যোগ হয়।
- Dashboard.tsx / LeadList.tsx-এর **Lead Edit** modal এখনো পুরনো
  static ফর্ম ব্যবহার করে (শুধু LeadGenerate.tsx-এর মূল creation ফর্ম dynamic
  করা হয়েছে) — Edit modal dynamic করা একটা ঝুঁকিপূর্ণ, বড় সার্জারি হবে সেই
  বিশাল ফাইলগুলোতে, তাই এটা পরবর্তী ধাপে (Workflow Engine-এর সাথে) করা
  যুক্তিসঙ্গত হবে।

## Deploy-এর পর যা টেস্ট করে দেখবেন
1. Settings > Form Builder থেকে কোনো একটা ফিল্ড (যেমন Priority) "Required"
   করে দিয়ে দেখুন Lead Generate ফর্ম সেটা ছাড়া সাবমিট আটকায় কিনা।
2. কোনো একটা ফিল্ড হাইড (Power বাটন) করে দেখুন Lead Generate ফর্ম থেকে সেটা
   আসলেই সরে যাচ্ছে কিনা।
3. "New Field" দিয়ে একটা কাস্টম dropdown ফিল্ড বানিয়ে (কোনো Metadata Type
   বেছে) দেখুন সেটা "Additional Information" সেকশনে দেখা যাচ্ছে কিনা, আর
   লিড তৈরি করে সেভ হচ্ছে কিনা।

---

# Phase 3 — Workflow Engine (নতুন সংযোজন)

## যা বানানো হয়েছে

**Backend:**
- `workflow_rules` টেবিল — প্রতিটা Lead Status-এর জন্য: (ক) সেই status
  থেকে কোন কোন status-এ যাওয়া যাবে (`allowedNextStatuses` — NULL মানে
  **unrestricted**, অর্থাৎ যেকোনো status-এ যাওয়া যাবে), আর (খ) সেই
  status-এ ঢুকতে কী কী তথ্য বাধ্যতামূলক (Loss Reason / Meeting Type /
  Follow-up Type / Note)।
- **ইচ্ছাকৃতভাবে ডিফল্টভাবে unrestricted (permissive)** রাখা হয়েছে — মানে
  deploy করার সাথে সাথে বিদ্যমান behavior একদম অপরিবর্তিত থাকবে, Admin
  ইচ্ছা করলেই কোনো status-এর জন্য transition সীমাবদ্ধ করতে পারবে।
- ডিফল্ট সিড: "Not Interested" status → Loss Reason বাধ্যতামূলক,
  "Meeting Fixed" status → Meeting Type বাধ্যতামূলক (এই দুটো metadata
  type Phase 1-এ তৈরি হয়েছিল কিন্তু কখনো UI-তে ব্যবহার হয়নি — এখন প্রথমবার
  কাজে লাগলো)।
- নতুন endpoints: `GET/POST/DELETE /api/workflow-rules`।

**Frontend:**
- `src/services/workflowService.ts` — rules fetch + `getAllowedNextStatuses()`
  ও `getRequirements()` হেল্পার।
- `Settings.tsx` → নতুন **"Workflow"** ট্যাব:
  - প্রতিটা status-এর জন্য কার্ড: কোন কোন status-এ যাওয়া যাবে তা বাটন
    ক্লিক করে টগল করা যায় (প্রথমবার ক্লিক করলে সেই status "restricted" মোডে
    চলে যায়, "Reset to Unrestricted" দিয়ে আবার সব খুলে দেওয়া যায়)
  - "Requires Loss Reason / Meeting Type / Follow-up Type / Note" চেকবক্স
- **`Dashboard.tsx`-এর মূল Status Update মডালে ইন্টিগ্রেশন**:
  - Status dropdown এখন শুধু workflow rule-এ allowed status গুলো দেখায়
    (unrestricted status হলে সব দেখায়, আগের মতোই)
  - নির্বাচিত target status-এ Loss Reason বা Meeting Type বাধ্যতামূলক হলে,
    সেই dropdown স্বয়ংক্রিয়ভাবে ফর্মে দেখা যায় এবং submit-এর আগে validate হয়
  - এই মান `lead.statusHistory` এর প্রতিটা এন্ট্রিতে এবং `lead.lossReason`
    / `lead.meetingType` ফিল্ডে সেভ হয়

## এই Phase-এ যা ইচ্ছাকৃতভাবে বাকি রাখা হয়েছে
- Dashboard.tsx-এর status modal-এ আগে থেকেই বেশ কিছু জটিল, hardcoded
  business-rule validation ছিল (Converted-এর জন্য Product+Sum Assured+NCP
  বাধ্যতামূলক, "Meeting Completed" থেকে sub-status নির্বাচন ইত্যাদি) —
  এগুলো **ইচ্ছাকৃতভাবে অক্ষত রাখা হয়েছে** এবং নতুন engine সেগুলোর *উপরে*
  additively যোগ হয়েছে, প্রতিস্থাপন করেনি। পুরো মডালটাকে সম্পূর্ণ
  generic/dynamic করে ফেলা এই মুহূর্তে বেশি ঝুঁকিপূর্ণ, তাই সেটা করা হয়নি।
- `LeadList.tsx`-এর quick status-change অংশে workflow rule এখনো integrate
  করা হয়নি — শুধু Dashboard.tsx-এর প্রধান modal-এ করা হয়েছে।
- Follow-up Type ও Note requirement flags backend/admin-UI-তে আছে কিন্তু
  এখনো কোনো UI ফর্মে wire করা হয়নি (Loss Reason ও Meeting Type-এর মতো)।

## Deploy-এর পর যা টেস্ট করে দেখবেন
1. Settings > Workflow-এ কোনো status-এর জন্য "Not Interested"-কে target
   list থেকে বাদ দিয়ে দেখুন Dashboard-এর status dropdown থেকে সেটা সরে
   যাচ্ছে কিনা।
2. একটা লিডকে "Meeting Fixed" status-এ পরিবর্তন করার সময় Meeting Type
   না দিয়ে submit করে দেখুন এটা আটকায় কিনা।

---

# Phase 4 — Lead Timeline + Activity Engine (নতুন সংযোজন)

## যা বানানো হয়েছে

**Lead Timeline (Lead360 পেজ):**
- নতুন রুট `/leads/:id` → `Lead360.tsx` পেজ — একটা লিডের সম্পূর্ণ প্রোফাইল
  ও ইতিহাস এক জায়গায় দেখা যায়।
- একটা একীভূত (unified), সময়ানুক্রমিক টাইমলাইনে চারটা উৎস থেকে ইভেন্ট
  মিশিয়ে দেখানো হয়:
  - **Status history** (আগে থেকেই ছিল — status change, remarks, loss
    reason, meeting type সব একসাথে)
  - **Assignment history** (নতুন — `assignment_history` কলাম যোগ করে,
    কোনো লিড এক employee থেকে আরেক employee-তে assign হলে এখন প্রতিটা
    পরিবর্তন লগ হয়ে থাকে; আগে শুধু বর্তমান assignedTo দেখা যেত, ইতিহাস
    হারিয়ে যেত)
  - **Document history** (নতুন — হালকা মেটাডেটা রেফারেন্স হিসেবে;
    **সততার সাথে বলা দরকার**: এটা প্রকৃত ফাইল আপলোড/স্টোরেজ সিস্টেম না,
    যেহেতু প্রজেক্টে কোনো S3/Supabase Storage bucket সংযুক্ত নেই। এটা
    শুধু নাম+নোট/লিংক রেফারেন্স রাখে যাতে অন্তত ট্র্যাক থাকে কোন ডকুমেন্ট
    কবে যোগ হয়েছে — প্রকৃত ফাইল storage যোগ করতে হলে সেটা আলাদা infra
    সিদ্ধান্ত)
  - **Notification history** (নতুন — নতুন `GET /api/notifications/leads/:leadId`
    endpoint দিয়ে, `SystemNotification`-এ আগে থেকেই থাকা `leadId` ফিল্ড
    ব্যবহার করে)
- টাইমলাইনে টাইপ অনুযায়ী ফিল্টার (All/Status/Assignment/Document/
  Notification) আছে।
- `AllLeads.tsx` ও `LeadList.tsx`-এ প্রতিটা লিড রো-তে একটা ছোট
  "Timeline" বাটন যোগ করা হয়েছে, যেখান থেকে সরাসরি Lead360-এ যাওয়া যায়।

**Activity Engine:**
- `src/utils/activityEngine.ts` — প্রতিটা লিডের `nextFollowUpDate`,
  `nextCallDate`, `meetingDate` থেকে "activity" হিসেব করে ৬টা ক্যাটাগরিতে
  ভাগ করে: **Today, Tomorrow, Upcoming, Overdue, Missed, Completed**।
- নতুন `/activities` পেজ ও sidebar-এ "Activities" মেনু আইটেম — প্রতিটা
  ক্যাটাগরির কার্ড, ক্লিক করলে সেই ক্যাটাগরির activity list দেখা যায়, আর
  প্রতিটা আইটেম ক্লিক করলে সংশ্লিষ্ট লিডের Lead360 টাইমলাইনে চলে যায়।

## এই Phase-এ যা ইচ্ছাকৃতভাবে বাকি/সীমিত রাখা হয়েছে (সততার সাথে বলা প্রয়োজন)
- **"Cancelled" ক্যাটাগরি বানানো হয়নি** — বর্তমান ডেটা মডেলে কোনো লিডকে
  "বাতিল" করার আলাদা কনসেপ্টই নেই (শুধু status pipeline আছে, resolution
  ছাড়া বন্ধ করার কোনো ব্যবস্থা নেই)। ভুয়া/অর্থহীন ডেটা দিয়ে এই ক্যাটাগরি
  সাজানোর চেয়ে বাদ রাখাই সৎ সিদ্ধান্ত মনে হয়েছে।
- **"Escalated" ক্যাটাগরিও বানানো হয়নি** — এটা প্রকৃত অর্থবহ হতে হলে
  Notification Engine-এর escalation chain (Phase 5) লাগবে, যেটা এখনো
  তৈরি হয়নি।
- Document history-তে প্রকৃত ফাইল আপলোড/ডাউনলোড নেই, শুধু রেফারেন্স/নোট।
- "Missed" বনাম "Overdue"-এর সীমারেখা একটা সরল থ্রেশহোল্ড (৩ দিন) দিয়ে
  ঠিক করা হয়েছে (`MISSED_THRESHOLD_DAYS` constant, `activityEngine.ts`
  ফাইলে) — চাইলে এটা পরে কনফিগারযোগ্য করা যাবে।

## Deploy-এর পর যা টেস্ট করে দেখবেন
1. কোনো একটা লিড অন্য employee-কে reassign করে Lead360-এ গিয়ে দেখুন
   "Assignment History" ঠিকমতো লগ হচ্ছে কিনা।
2. `/activities` পেজে গিয়ে দেখুন আপনার visible লিডগুলোর pending follow-up
   ঠিক ক্যাটাগরিতে (Today/Overdue ইত্যাদি) দেখা যাচ্ছে কিনা।
3. Lead360-এ "Add Document" দিয়ে একটা রেফারেন্স যোগ করে দেখুন টাইমলাইনে
   দেখা যাচ্ছে কিনা এবং refresh-এর পরও টিকে থাকছে কিনা।




# STEP 4A — Server-authoritative Lead Follow-up / Status Activity (নতুন সংযোজন)

## সমস্যা কী ছিল
Status change আগে browser থেকেই author হতো: `leadService.updateLeadStatus()`
lead fetch করে, `statusHistory` client-side বানাতো, actor/date payload-এ
নিজে দিতো, আর পুরো lead টা `POST /api/leads`-এ পাঠাতো। `getLead()` আবার
পুরো `/api/leads` list টেনে একটা lead খুঁজতো। ফলে — actor/date spoofable,
দুইজন একসাথে save করলে history হারাতো, পুরো array বারবার round-trip হতো,
এবং server-side কোনো authoritative append path-ই ছিল না।

## যা বানানো হয়েছে
- **নতুন migration `037_lead_activities.ts`** (`runMigrations.ts`-এ
  registered — নাহলে cold start-এ চিন্তা করত না) — append-only `lead_activities`
  টেবিল (`lead_id`, `activity_type`, `status`, `remarks`, date/meeting/NCP/
  product/lossReason fields, `created_by`, `created_at`) + `lead_id`/
  `created_at` index। FK: `leads(id)` ON DELETE CASCADE, `users(id)`
  ON DELETE SET NULL।
- **নতুন endpoint `POST /api/leads/:id/follow-up`** — একটাই authoritative
  path। `requireAuth`, existing `leads.edit` permission (fail closed),
  existing visibility (Organization / FullTeam / DownTeam / Own) অক্ষরে
  অক্ষরে reuse করা হয়েছে। `BEGIN → SELECT … FOR UPDATE → lead current state
  update → activity insert → COMMIT`; যেকোনো failure-এ ROLLBACK (কোনো
  partial activity নেই, কোনো fake success নেই)।
- **`GET /api/leads/:id`** — direct single-lead read; soft-deleted lead
  ফেরত দেয় না, অনুপস্থিত ও অদৃশ্য দুটোই 404 (record leak নেই)।
- **`GET /api/leads/:id/activities`** — একই visibility, reverse chronological।
- **Audit authority:** `changedBy`, `updatedBy`, `createdBy`, `actor`, `date`,
  `timestamp`, `statusHistory`, `assignmentHistory` body-এ থাকলেই `400` —
  silently ignore-ও না, accept-ও না। actor session user থেকে, event time
  server clock থেকে। Status resolve হয় ঠিক bulk import-এর canonical
  FollowUpStatus dictionary দিয়েই (`resolveImportStatus`) — unknown status
  স্পষ্টভাবে fail করে, কখনো `Untouched`-এ convert হয় না।
- **Partial update:** field omit করলে পুরনো value থাকে, explicit `null` দিলে
  শুধু ওই field-টাই clear হয়। `leads.notes` (import-এর "Final Remarks")
  follow-up remark-এ overwrite হয় না।
- **Client:** `updateLeadStatus()` এখন শুধু business field পাঠায়; cache
  update হয় server commit confirm করার পরেই। `getLead()` এখন
  `GET /api/leads/:id` ব্যবহার করে — পুরো list আর টানে না।
  `updateLead()` history array round-trip করে না। Offline/localStorage
  status-write helper (`localDb.updateLeadStatus`) সরিয়ে দেওয়া হয়েছে।
- **Lead360** এখন server-এর activity stream পড়ে; legacy `status_history`
  শুধু activity-table-এর আগের event-গুলোর জন্য দেখানো হয় (`activityId`
  দিয়ে de-dup) — তাই কিছুই ডুবে যায় না, কিছুই ডাবল দেখায় না। Page-এর
  visual design অপরিবর্তিত।

## compatibility (গুরুত্বপূর্ণ)
- Legacy imported spreadsheet কখনো `lead_activities`-তে backfill করা হয়নি —
  ওটা current-state snapshot, trustworthy event history না।
- `leads.status_history` UI compatibility-র জন্য থাকছে, কিন্তু এখন server
  সেটাকে **SQL-এর ভেতরেই** append করে (client-supplied array দিয়ে replace
  নয়)। `LEAD_UPSERT_SQL`-এ preserve-on-empty guard যোগ হয়েছে, তাই history
  না পাঠালে পুরনো history মুছে যায় না।
- Bulk import, auth, visibility, hierarchy — কোনো behavior-ই বদলায়নি
  (সব pre-existing টেস্ট সবুজ)।

## টেস্ট ও রেজাল্ট
- `server/tests/lead-follow-up-activity-integration.test.ts` (36 টেস্ট) —
  আসল PGlite PostgreSQL + আসল router; migration 037 নিজে চালিয়েই টেবিল
  তৈরি হয়। A–S, V + rollback, concurrency, spoof rejection, migration
  registration guard সহ।
- `server/tests/lead-follow-up-client-service.test.ts` (9 টেস্ট) — আসল
  browser service গুলো আসল HTTP + DB-এর বিরুদ্ধে; T (list fetch হয় না),
  Q (history/actor পাঠানো হয় না), U (DB failure = reject, cache অক্ষত)।
- `npm test` → **172 টেস্ট, 0 fail** (আগের 127 + নতুন 45) ·
  `npx tsc --noEmit` clean · `npx vite build` clean · `npm run build` clean ·
  `npm run verify:serverless` clean (037 trace+compile-এর ভেতর আছে)।

বিস্তারিত doc: `docs/LEAD_FOLLOW_UP_ACTIVITY.md`
