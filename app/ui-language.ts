import { greek } from './translations-el';

export type UILanguage = 'en' | 'el';
export function normalizeLanguage(value: unknown): UILanguage { return value === 'el' ? 'el' : 'en'; }
export function translate(text: string, language: UILanguage): string {
  if (language !== 'el') return text;
  if (/^Week [1-4]\+?$/.test(text)) return text.replace('Week', 'Εβδομάδα');
  return greek[text] ?? translateMessage(text) ?? text;
}

// Server messages that include names or dates; names stay as the user wrote them.
function translateMessage(text: string): string | null {
  let match = text.match(/^Choose an active (expense|income) category\.$/);
  if (match) return `Επιλέξτε ενεργή κατηγορία ${match[1] === 'income' ? 'εσόδων' : 'εξόδων'}.`;
  match = text.match(/^Restore the linked (account|category)(?: “(.+)”)? first\.$/);
  if (match) return `Επαναφέρετε πρώτα ${match[1] === 'account' ? 'τον συνδεδεμένο λογαριασμό' : 'τη συνδεδεμένη κατηγορία'}${match[2] ? ` «${match[2]}»` : ''}.`;
  match = text.match(/^“(.+)” already uses one of this bucket’s categories\. Change its categories before restoring this bucket\.$/);
  if (match) return `Ο φάκελος «${match[1]}» χρησιμοποιεί ήδη μία από τις κατηγορίες αυτού του φακέλου. Αλλάξτε τις κατηγορίες του πριν από την επαναφορά.`;
  match = text.match(/^This plan ended on (\d{4}-\d{2}-\d{2})\. Create a new plan if you want it to continue\.$/);
  if (match) return `Αυτό το πλάνο έληξε στις ${match[1]}. Δημιουργήστε νέο πλάνο αν θέλετε να συνεχιστεί.`;
  match = text.match(/^(.+) already belongs to the (.+) bucket\.$/);
  if (match) return `Η κατηγορία «${match[1]}» ανήκει ήδη στον φάκελο «${match[2]}».`;
  return null;
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
  match = text.match(/^(Savings|Investment) contribution rate (increased|decreased) by ([\d.]+) percentage points\.$/);
  if (match) return `Το ποσοστό ${match[1] === 'Savings' ? 'εισφορών αποταμίευσης' : 'επενδυτικών εισφορών'} ${match[2] === 'increased' ? 'αυξήθηκε' : 'μειώθηκε'} κατά ${match[3].replace('.', ',')} ποσοστιαίες μονάδες.`;
  match = text.match(/^Savings rate (improved|fell) by ([\d.]+) percentage points\.$/);
  if (match) return `Το ποσοστό αποταμίευσης ${match[1] === 'improved' ? 'αυξήθηκε' : 'μειώθηκε'} κατά ${match[2].replace('.', ',')} ποσοστιαίες μονάδες.`;
  return translate(text, language);
}

// Historical events use canonical English detail. Localize the presentation,
// never the audit record or user-entered names embedded in it.
export function formatPlanEvent(event: { kind: string; detail: string }, language: UILanguage, currency: string): string {
  const { kind, detail } = event;
  if (language !== 'el') return detail;
  const amount = (value: string) => new Intl.NumberFormat('el-GR', { style: 'currency', currency }).format(Number(value));
  const fixed: Record<string, string> = {
    'Current Plan created from opening balances.': 'Το τρέχον πλάνο δημιουργήθηκε από τα αρχικά υπόλοιπα.',
    'Plan settings updated for the current period. Earlier periods retain their settings.': 'Οι ρυθμίσεις πλάνου ενημερώθηκαν για την τρέχουσα περίοδο. Οι προηγούμενες περίοδοι διατηρούν τις ρυθμίσεις τους.',
    'Bucket protection restored.': 'Η δέσμευση του φακέλου επανήλθε.',
    'Unused bucket protection released to everyday spending.': 'Η αχρησιμοποίητη δέσμευση του φακέλου επέστρεψε στα καθημερινά χρήματα.',
  };
  if (fixed[detail]) return fixed[detail];
  let match: RegExpMatchArray | null;
  if (kind === 'funding' && (match = detail.match(/^Period funding set to (-?[\d.]+)\. No account money was moved\.$/)))
    return `Η χρηματοδότηση περιόδου ορίστηκε σε ${amount(match[1])}. Δεν μετακινήθηκαν χρήματα λογαριασμών.`;
  if (kind === 'allocation' && (match = detail.match(/^(.*) assigned (-?[\d.]+)\. Matching activity and planned payments are covered inside this amount\.$/)))
    return `Στον φάκελο ${match[1]} κατανεμήθηκαν ${amount(match[2])}. Οι αντίστοιχες κινήσεις και προγραμματισμένες πληρωμές καλύπτονται μέσα σε αυτό το ποσό.`;
  if (kind === 'allocation' && (match = detail.match(/^(-?[\d.]+) reassigned from (.*) to (.*) for this period\.$/)))
    return `${amount(match[1])} ανακατανεμήθηκαν από ${match[2] === 'Everyday' ? 'τα καθημερινά χρήματα' : match[2]} προς ${match[3] === 'Everyday' ? 'τα καθημερινά χρήματα' : match[3]} για αυτή την περίοδο.`;
  if (kind === 'payment' && (match = detail.match(/^(.*): (-?[\d.]+) recorded on (\d{4}-\d{2}-\d{2})( by matching existing activity)?\.$/))) {
    const date = new Intl.DateTimeFormat('el-GR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${match[3]}T12:00:00Z`));
    return `${match[1]}: καταγράφηκαν ${amount(match[2])} στις ${date}${match[4] ? ', με σύνδεση υπάρχουσας κίνησης' : ''}.`;
  }
  if (kind === 'schedule' && (match = detail.match(/^(.*): (occurrence skipped|due date changed|marked as done)\.$/)))
    return `${match[1]}: ${match[2] === 'occurrence skipped' ? 'η προγραμματισμένη πληρωμή παραλείφθηκε' : match[2] === 'marked as done' ? 'σημειώθηκε ως ολοκληρωμένη' : 'η προθεσμία πληρωμής άλλαξε'}.`;
  if (kind === 'assignment' && (match = detail.match(/^(.*): funding assignments updated\.$/)))
    return `${match[1]}: οι κατανομές χρηματοδότησης ενημερώθηκαν.`;
  return translate(detail, language);
}
