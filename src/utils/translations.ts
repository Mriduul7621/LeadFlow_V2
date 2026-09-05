import { useLanguageStore, Language } from '../store/languageStore';

export const translations = {
  en: {
    // Nav & Sidebar
    navDashboard: "Dashboard",
    navLeadGenerate: "Lead Generate",
    navLeadUpload: "Lead Upload",
    navAllLeads: "All Leads",
    navLeadTracking: "Lead Tracking",
    navExecutionIntell: "Execution Intell.",
    navNcpProgress: "NCP Progress",
    navTrendCharts: "Trend Charts",
    navCampaignBreakdown: "Campaign Breakdown",
    navFollowUpStrategy: "Follow-up Strategy",
    navTaskCalendar: "Task Calendar",
    navTeamProgress: "Team Progress",
    navUserManagement: "User Management",
    navSettings: "Settings",

    // General Words
    loading: "Loading...",
    success: "Success",
    error: "Error",
    systemReady: "System Ready",
    secureNodeOnline: "Secure Node Online",
    setupRequired: "Setup Required",

    // Presentation Screeen
    loginHeading: "LEAD FLOW",
    loginSubheading: "Track and convert leads easily (Lead Tracker)",
    loginDesc: "An easy and smart lead management app for tracking customer leads and sales teams.",
    loginButton: "Login Now",
    initializeConsoleBtn: "Initialize Console",

    // Super Admin Setup
    setupTitle: "Initialize Super Admin",
    setupSub: "First-time system setup",
    fullNameLabel: "Full Name",
    fullNamePlaceholder: "EX: Admin Director",
    employeeIdLabel: "Employee ID",
    employeeIdPlaceholder: "EX: ADMIN or ADM001",
    emailLabel: "Email Address",
    emailPlaceholder: "EX: admin@shantalife.com",
    passwordLabel: "Password",
    passwordPlaceholder: "••••••••",
    confirmPasswordLabel: "Confirm Password",
    registerBtn: "Register Super Admin",

    // Normal Login
    systemLoginTitle: "System Login",
    systemLoginSub: "Login with your ID and password",
    loginEmpIdLabel: "Employee ID",
    loginEmpIdPlaceholder: "Enter ID (e.g. RM001 or ADMIN)",
    loginPasswordLabel: "Password",
    loginPasswordPlaceholder: "Enter your password",
    loginSubmitBtn: "Confirm & Login",
    backToMainBtn: "Go back to previous screen",

    // Department Filter (TeamHierarchy)
    deptFilterActive: "Department Filter Active:",
    deptFilterRelaxed: "Filter Relaxed:",
    deptFilterActiveDesc: "This branch is under the \"{deptName}\" department. Only employees of this department are listed.",
    deptFilterRelaxedDesc: "This branch is under the \"{deptName}\" department. However, since no available employees are registered in this department, all available employees from other departments are shown.",

    // Notifications & UI Info
    sessionExpired: "Session expired due to 30 minutes of inactivity.",
    welcomeMessage: "Welcome back, {name}!",
    masterAdminProtocol: "Master Admin Protocol Authenticated.",
  },
  bn: {
    // Nav & Sidebar
    navDashboard: "ড্যাশবোর্ড",
    navLeadGenerate: "লিড জেনারেট",
    navLeadUpload: "লিড আপলোড",
    navAllLeads: "সকল লিড",
    navLeadTracking: "লিড ট্র্যাকিং",
    navExecutionIntell: "এক্সিকিউশন ইন্টেলিজেন্স",
    navNcpProgress: "NCP প্রগতি",
    navTrendCharts: "ট্রেন্ড চার্ট",
    navCampaignBreakdown: "ক্যাম্পেইন ব্রেকডাউন",
    navFollowUpStrategy: "ফলো-আপ স্ট্র্যাটেজি",
    navTaskCalendar: "টাস্ক ক্যালেন্ডার",
    navTeamProgress: "টিম প্রগতি",
    navUserManagement: "ইউজার ম্যানেজমেন্ট",
    navSettings: "সেটিংস",

    // General Words
    loading: "লোড হচ্ছে...",
    success: "সফল হয়েছে",
    error: "ত্রুটি",
    systemReady: "সিস্টেম প্রস্তুত",
    secureNodeOnline: "সুরক্ষিত নোড অনলাইন",
    setupRequired: "সেটআপ প্রয়োজন",

    // Presentation Screeen
    loginHeading: "লিড ফ্লো",
    loginSubheading: "সহজে লিড ট্র্যাক এবং কনভার্ট করুন (Lead Tracker)",
    loginDesc: "সহজ এবং স্মার্ট উপায়ে আপনার কাস্টমার লিড ও সেলস ট্র্যাক করার ড্যাশবোর্ড।",
    loginButton: "লগইন করুন",
    initializeConsoleBtn: "কনসোল শুরু করুন",

    // Super Admin Setup
    setupTitle: "সুপার এডমিন চালু করুন",
    setupSub: "প্রথমবারের জন্য সিস্টেম সেটআপ",
    fullNameLabel: "সম্পূর্ণ নাম",
    fullNamePlaceholder: "যেমন: এডমিন ডিরেক্টর",
    employeeIdLabel: "কর্মচারী আইডি (Employee ID)",
    employeeIdPlaceholder: "যেমন: ADMIN বা ADM001",
    emailLabel: "ইমেইল অ্যাড্রেস",
    emailPlaceholder: "যেমন: admin@shantalife.com",
    passwordLabel: "পাসওয়ার্ড",
    passwordPlaceholder: "••••••••",
    confirmPasswordLabel: "পাসওয়ার্ড নিশ্চিত করুন",
    registerBtn: "সুপার এডমিন রেজিস্টার করুন",

    // Normal Login
    systemLoginTitle: "সিস্টেম লগইন",
    systemLoginSub: "আপনার আইডি এবং পাসওয়ার্ড দিয়ে লগইন করুন",
    loginEmpIdLabel: "কর্মচারী আইডি (Employee ID)",
    loginEmpIdPlaceholder: "আইডি লিখুন (যেমন: RM001 বা ADMIN)",
    loginPasswordLabel: "পাসওয়ার্ড (Password)",
    loginPasswordPlaceholder: "আপনার পাসওয়ার্ড দিন",
    loginSubmitBtn: "লগইন নিশ্চিত করুন (Login)",
    backToMainBtn: "আগের স্ক্রিনে ফিরে যান",

    // Department Filter (TeamHierarchy)
    deptFilterActive: "বিভাগ ফিল্টার সক্রিয় (Department Filter Active):",
    deptFilterRelaxed: "বিভাগ ফিল্টার শিথিল (Filter Relaxed):",
    deptFilterActiveDesc: "এই শাখাটি \"{deptName}\" বিভাগের অধীনে রয়েছে। শুধুমাত্র এই বিভাগের কর্মচারীরাই তালিকায় উপস্থিত আছেন।",
    deptFilterRelaxedDesc: "এই শাখাটি \"{deptName}\" বিভাগের অধীনে রয়েছে। তবে এই বিভাগে কোনো খালি কর্মচারী রেজিস্টার্ড না থাকায় অন্য বিভাগের সকল খালি কর্মচারীদের তালিকা দেখানো হচ্ছে।",

    // Notifications & UI Info
    sessionExpired: "৩০ মিনিট নিষ্ক্রিয়তার কারণে সেশনের মেয়াদ শেষ হয়েছে।",
    welcomeMessage: "স্বাগতম, {name}!",
    masterAdminProtocol: "মাস্টার এডমিন প্রোটোকল অনুমোদিত হয়েছে।",
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
