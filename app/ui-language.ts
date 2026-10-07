import { greek } from './translations-el';

export type UILanguage = 'en' | 'el';
export function normalizeLanguage(value: unknown): UILanguage { return value === 'el' ? 'el' : 'en'; }
export function translate(text: string, language: UILanguage): string {
  if (language !== 'el') return text;
  if (/^Week [1-4]\+?$/.test(text)) return text.replace('Week', 'Εβδομάδα');
  return greek[text] ?? text;
}

// Only call this for generated Insights commentary, never user-entered text.
export function translateInsight(text: string, language: UILanguage): string {
  if (language !== 'el') return text;
  let match = text.match(/^(.*) (increased|decreased) by (.*) \((\d+)%\) versus the comparison period\.$/);
  if (match) return `${match[1]} ${match[2] === 'increased' ? 'αυξήθηκε' : 'μειώθηκε'} κατά ${match[3]} (${match[4]}%) σε σχέση με την περίοδο σύγκρισης.`;
  match = text.match(/^(\d+)% of (income|activity) occurred on weekends\.$/);
  if (match) return `${match[1]}% ${match[2] === 'income' ? 'των εσόδων' : 'των κινήσεων'} καταγράφηκε τα Σαββατοκύριακα.`;
  match = text.match(/^(.*) was the largest description at (\d+)% across (\d+) transactions?\.$/);
  if (match) return `${match[1]} ήταν η μεγαλύτερη περιγραφή με ${match[2]}%, σε ${match[3]} ${match[3] === '1' ? 'συναλλαγή' : 'συναλλαγές'}.`;
  match = text.match(/^Savings rate (improved|fell) by ([\d.]+) percentage points\.$/);
  if (match) return `Το ποσοστό αποταμίευσης ${match[1] === 'improved' ? 'αυξήθηκε' : 'μειώθηκε'} κατά ${match[2].replace('.', ',')} ποσοστιαίες μονάδες.`;
  return translate(text, language);
}
