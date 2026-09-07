import { useLanguageStore, Language } from '../../../store/languageStore';

export const translations = {
  en: {
    // Nav & Sidebar
    navDashboard: "Dashboard",
    navLeadGenerate: "Add New Lead",
    navLeadUpload: "Bulk Upload",
    navAllLeads: "All Leads",
    navLeadTracking: "Lead Tracking",
    navExecutionIntell: "Performance",
    navNcpProgress: "NCP Progress",
    navTrendCharts: "Trends",
    navCampaignBreakdown: "Campaigns",
    navFollowUpStrategy: "Follow-ups",
    navTaskCalendar: "Task Calendar",
    navTeamProgress: "Team",
    navUserManagement: "Users",
    navSettings: "Settings",

    // General Words
    loading: "Loading...",
    success: "Success",
    error: "Error",
    systemReady: "System Ready",
    secureNodeOnline: "Connected",
    setupRequired: "Setup Required",

    // Login Page
    loginHeading: "Lead Flow",
    loginSubheading: "Smart Lead Management System",
    loginDesc: "Track your leads, manage your team, and boost your sales — all in one place.",
    loginButton: "Get Started",
    initializeConsoleBtn: "Start Setup",

    // Super Admin Setup
    setupTitle: "Admin Setup",
    setupSub: "Create the first admin account",
    fullNameLabel: "Full Name",
    fullNamePlaceholder: "e.g. Mohammad Rahim",
    employeeIdLabel: "Employee ID",
    employeeIdPlaceholder: "e.g. ADMIN or ADM001",
    emailLabel: "Email Address",
    emailPlaceholder: "e.g. admin@company.com",
    passwordLabel: "Password",
    passwordPlaceholder: "••••••••",
    confirmPasswordLabel: "Confirm Password",
    registerBtn: "Create Admin Account",

    // Normal Login
    systemLoginTitle: "Welcome Back",
    systemLoginSub: "Login with your credentials",
    loginEmpIdLabel: "Employee ID",
    loginEmpIdPlaceholder: "Enter your ID (e.g. RM001)",
    loginPasswordLabel: "Password",
    loginPasswordPlaceholder: "Enter your password",
    loginSubmitBtn: "Login",
    backToMainBtn: "Back to home",

    // Department Filter (TeamHierarchy)
    deptFilterActive: "Department Filter:",
    deptFilterRelaxed: "Filter Relaxed:",
    deptFilterActiveDesc: "Showing employees from \"{deptName}\" department only.",
    deptFilterRelaxedDesc: "This branch belongs to \"{deptName}\" department. No employees found in this department, showing all available employees.",

    // Notifications & UI Info
    sessionExpired: "Session expired due to inactivity. Please login again.",
    welcomeMessage: "Welcome back, {name}!",
    masterAdminProtocol: "Admin access confirmed.",
  },
  bn: {
    // Nav & Sidebar
    navDashboard: "ড্যাশবোর্ড",
    navLeadGenerate: "নতুন লিড",
    navLeadUpload: "বাল্ক আপলোড",
    navAllLeads: "সকল লিড",
    navLeadTracking: "লিড ট্র্যাকিং",
    navExecutionIntell: "পারফরম্যান্স",
    navNcpProgress: "NCP অগ্রগতি",
    navTrendCharts: "ট্রেন্ড",
    navCampaignBreakdown: "ক্যাম্পেইন",
    navFollowUpStrategy: "ফলো-আপ",
    navTaskCalendar: "টাস্ক ক্যালেন্ডার",
    navTeamProgress: "টিম",
    navUserManagement: "ইউজার",
    navSettings: "সেটিংস",

    // General Words
    loading: "লোড হচ্ছে...",
    success: "সফল",
    error: "ত্রুটি",
    systemReady: "সিস্টেম প্রস্তুত",
    secureNodeOnline: "সংযুক্ত",
    setupRequired: "সেটআপ প্রয়োজন",

    // Login Page
    loginHeading: "লিড ফ্লো",
    loginSubheading: "স্মার্ট লিড ম্যানেজমেন্ট সিস্টেম",
    loginDesc: "আপনার লিড ট্র্যাক করুন, টিম পরিচালনা করুন এবং সেলস বাড়ান — সব এক জায়গায়।",
    loginButton: "শুরু করুন",
    initializeConsoleBtn: "সেটআপ শুরু করুন",

    // Super Admin Setup
    setupTitle: "অ্যাডমিন সেটআপ",
    setupSub: "প্রথম অ্যাডমিন অ্যাকাউন্ট তৈরি করুন",
    fullNameLabel: "সম্পূর্ণ নাম",
    fullNamePlaceholder: "যেমন: মোহাম্মদ রহিম",
    employeeIdLabel: "কর্মচারী আইডি",
    employeeIdPlaceholder: "যেমন: ADMIN বা ADM001",
    emailLabel: "ইমেইল ঠিকানা",
    emailPlaceholder: "যেমন: admin@company.com",
    passwordLabel: "পাসওয়ার্ড",
    passwordPlaceholder: "••••••••",
    confirmPasswordLabel: "পাসওয়ার্ড নিশ্চিত করুন",
    registerBtn: "অ্যাডমিন অ্যাকাউন্ট তৈরি করুন",

    // Normal Login
    systemLoginTitle: "স্বাগতম",
    systemLoginSub: "আপনার আইডি ও পাসওয়ার্ড দিয়ে লগইন করুন",
    loginEmpIdLabel: "কর্মচারী আইডি",
    loginEmpIdPlaceholder: "আপনার আইডি লিখুন (যেমন: RM001)",
    loginPasswordLabel: "পাসওয়ার্ড",
    loginPasswordPlaceholder: "পাসওয়ার্ড দিন",
    loginSubmitBtn: "লগইন",
    backToMainBtn: "হোমে ফিরে যান",

    // Department Filter (TeamHierarchy)
    deptFilterActive: "বিভাগ ফিল্টার:",
    deptFilterRelaxed: "ফিল্টার শিথিল:",
    deptFilterActiveDesc: "শুধুমাত্র \"{deptName}\" বিভাগের কর্মচারীরা দেখানো হচ্ছে।",
    deptFilterRelaxedDesc: "এই শাখাটি \"{deptName}\" বিভাগের অধীনে। এই বিভাগে কোনো কর্মচারী নেই, তাই সকল কর্মচারী দেখানো হচ্ছে।",

    // Notifications & UI Info
    sessionExpired: "নিষ্ক্রিয়তার কারণে সেশন শেষ হয়েছে। আবার লগইন করুন।",
    welcomeMessage: "স্বাগতম, {name}!",
    masterAdminProtocol: "অ্যাডমিন অ্যাক্সেস নিশ্চিত হয়েছে।",
  }
};

export function useTranslation() {
  const { language, setLanguage } = useLanguageStore();

  const t = (key: keyof typeof translations['en'], variables?: Record<string, string>): string => {
    const dict = translations[language] || translations['en'];
    let text = dict[key] || translations['en'][key] || String(key);
    
    if (variables) {
      Object.entries(variables).forEach(([vKey, vVal]) => {
        text = text.replace(`{${vKey}}`, vVal);
      });
    }
    return text;
  };

  return { t, language, setLanguage };
}
