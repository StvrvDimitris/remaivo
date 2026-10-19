"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { normalizeLanguage, translate, type UILanguage } from "./ui-language";
export { normalizeLanguage } from "./ui-language";
export type { UILanguage } from "./ui-language";

const LanguageContext = createContext<{ language: UILanguage; setLanguage: (language: UILanguage) => void }>({ language: "en", setLanguage: () => {} });
export function LanguageProvider({ children, initialLanguage = "en" }: { children: ReactNode; initialLanguage?: UILanguage }) {
  const [language, setLanguage] = useState<UILanguage>(initialLanguage);
  useEffect(() => { document.documentElement.lang = language; document.cookie = `rmv-lang=${language}; Path=/; Max-Age=31536000; SameSite=Lax`; }, [language]);
  return <LanguageContext.Provider value={{language, setLanguage}}>{children}</LanguageContext.Provider>;
}
export function useTranslation() {
  const context = useContext(LanguageContext);
  const t = useCallback((text: string | undefined) => translate(text ?? "", context.language), [context.language]);
  return { ...context, locale: context.language === "el" ? "el-GR" : "en-IE", t };
}
export function LanguageSelect({ busy = false, onChange }: { busy?: boolean; onChange?: (language: UILanguage) => void }) {
  const { language, setLanguage, t } = useTranslation();
  return <label className="form-field"><span>{t("Language")}</span><select value={language} disabled={busy} onChange={event => { const next = normalizeLanguage(event.target.value); if (onChange) onChange(next); else setLanguage(next); }}><option value="en">English</option><option value="el">Ελληνικά</option></select></label>;
}
