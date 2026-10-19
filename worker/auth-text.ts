// Greek for the Worker's own pages (sign-in, profiles, notices). They are built
// in English and translated as a whole, the way the app translates through tr().
const greek: Record<string, string> = {
  "Sign in": "Σύνδεση",
  "Enter your Remaivo password.": "Πληκτρολογήστε τον κωδικό του Remaivo.",
  "Password": "Κωδικός",
  "Welcome to Remaivo": "Καλώς ήρθατε στο Remaivo",
  "Setup code": "Κωδικός εγκατάστασης",
  "You will find it in this server's logs. On Cloudflare: Workers & Pages, your Worker, Logs, Live, then reload this page. With Docker:": "Θα τον βρείτε στα αρχεία καταγραφής του διακομιστή. Στο Cloudflare: Workers & Pages, ο Worker σας, Logs, Live, και μετά ανανεώστε αυτή τη σελίδα. Με Docker:",
  "Your name": "Το όνομά σας",
  "Optional": "Προαιρετικό",
  "Confirm password": "Επιβεβαίωση κωδικού",
  "Set password": "Ορισμός κωδικού",
  "Set up": "Ρύθμιση",
  "That password is not correct.": "Ο κωδικός δεν είναι σωστός.",
  "That setup code is not correct. Check the server's logs for the current code.": "Ο κωδικός εγκατάστασης δεν είναι σωστός. Δείτε τον τρέχοντα κωδικό στα αρχεία καταγραφής του διακομιστή.",
  "The passwords do not match.": "Οι κωδικοί δεν ταιριάζουν.",
  "A password was already set. Please sign in.": "Έχει ήδη οριστεί κωδικός. Συνδεθείτε.",
  "Who's using Remaivo?": "Ποιος χρησιμοποιεί το Remaivo;",
  "Profiles": "Προφίλ",
  "Add profile": "Προσθήκη προφίλ",
  "Edit profile": "Επεξεργασία προφίλ",
  "Edit": "Επεξεργασία",
  "Name": "Όνομα",
  "Colour": "Χρώμα",
  "Icon": "Εικονίδιο",
  "First letter": "Πρώτο γράμμα",
  "Create profile": "Δημιουργία προφίλ",
  "Save": "Αποθήκευση",
  "Cancel": "Ακύρωση",
  "Back to Remaivo": "Πίσω στο Remaivo",
  "Sign out": "Αποσύνδεση",
  "Sign out?": "Αποσύνδεση;",
  "Sign out of Remaivo": "Αποσύνδεση από το Remaivo",
  "Give the profile a name.": "Δώστε όνομα στο προφίλ.",
  "A profile with that name already exists.": "Υπάρχει ήδη προφίλ με αυτό το όνομα.",
  "That profile no longer exists.": "Αυτό το προφίλ δεν υπάρχει πια.",
  "Error": "Σφάλμα",
  "Method not allowed.": "Η μέθοδος δεν επιτρέπεται.",
  "Request origin is not allowed.": "Η προέλευση του αιτήματος δεν επιτρέπεται.",
  "Not found": "Δεν βρέθηκε",
  "Page not found.": "Η σελίδα δεν βρέθηκε.",
  "Password too short": "Πολύ σύντομος κωδικός",
  "Remaivo is updating": "Το Remaivo ενημερώνεται",
  "Its database is being brought up to date. Please try again in a moment.": "Η βάση δεδομένων ενημερώνεται. Δοκιμάστε ξανά σε λίγο.",
  "Too many requests": "Πάρα πολλά αιτήματα",
  "Please wait a minute, then try again.": "Περιμένετε ένα λεπτό και δοκιμάστε ξανά.",
};
const patterns: [RegExp, (...groups: string[]) => string][] = [
  [/^(.+) · Remaivo$/, title => `${translate(title)} · Remaivo`],
  [/^Edit (.+)$/, name => `Επεξεργασία: ${name}`],
  [/^Colour (\d+)$/, n => `Χρώμα ${n}`],
  [/^Use at least (\d+) characters\.$/, n => `Χρησιμοποιήστε τουλάχιστον ${n} χαρακτήρες.`],
  [/^Choose a password to protect this Remaivo server\. Use at least (\d+) characters\.$/, n => `Επιλέξτε κωδικό για να προστατέψετε αυτόν τον διακομιστή Remaivo. Χρησιμοποιήστε τουλάχιστον ${n} χαρακτήρες.`],
  [/^This Remaivo already has (\d+) profiles\.$/, n => `Αυτό το Remaivo έχει ήδη ${n} προφίλ.`],
];
function translate(text: string): string {
  if (greek[text]) return greek[text];
  for (const [pattern, render] of patterns) {
    const match = text.match(pattern);
    if (match) return render(...match.slice(1));
  }
  return text;
}

const decode = (value: string) => value.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replaceAll("&amp;", "&");
const encode = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
// Translates every text run and every aria-label, title and placeholder.
// Entries the dictionary doesn't know (people's names, codes) stay as they are.
export function localize(html: string, language: string) {
  if (language !== "el") return html;
  const swap = (raw: string) => {
    const text = decode(raw).trim();
    if (text.includes("{")) return raw; // the page's CSS
    const translated = text && translate(text);
    return translated && translated !== text ? raw.replace(raw.trim(), encode(translated)) : raw;
  };
  return html.replace('<html lang="en"', '<html lang="el"')
    .replace(/>([^<>]+)</g, (_, text) => `>${swap(text)}<`)
    .replace(/ (aria-label|title|placeholder)="([^"]*)"/g, (_, name, value) => ` ${name}="${swap(value)}"`);
}
