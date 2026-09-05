import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Language = 'en' | 'bn';

interface LanguageState {
  language: Language;
  setLanguage: (lang: Language) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: 'en', // Defaulting to English as requested
      setLanguage: (lang) => set({ language: lang }),
    }),
    {
      name: 'leadflow-language',
    }
  )
);
