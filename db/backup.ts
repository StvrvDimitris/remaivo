import { env } from "cloudflare:workers";

// All user-owned data, for every profile, including archived records and Plan
// history. Passwords and sign-in sessions are never part of a backup.
const TABLES = [
  "accounts", "categories", "goals", "goal_entries", "installment_payments",
  "installment_plans", "investment_valuation_snapshots", "profiles",
  "recurring_plans", "tags", "transactions", "v3_assignments",
  "v3_bucket_periods", "v3_bucket_templates", "v3_events",
  "v3_occurrences", "v3_payment_links", "v3_periods", "v3_versions",
] as const;
// Tables added after a backup version; older files simply have none of them.
const ADDED_IN: Partial<Record<(typeof TABLES)[number], number>> = { tags: 5 };
// Version 5 backups held tag groups, which became plain tags in version 6.
const DROPPED_IN_6 = { tables: ["tag_groups"], columns: { tags: ["group_id"] } as Record<string, string[]> };

// Version 7 edits transactions in place and posts each round-up as its own
// transfer, so earlier files may hold hidden corrected copies, the spare-change
// pot and their columns; all of these are dropped on restore. A pot that was
// still waiting in the file is not restored.
const DROPPED_IN_7 = { tables: ["spare_events"], columns: { transactions: ["replaces_transaction_id", "spare_change_cents", "spare_excluded"], profiles: ["spare_auto_sweep_threshold_cents"] } as Record<string, string[]> };

const BACKUP_VERSION = 7;
const OLDEST_VERSION = 3;
const MAX_PROFILES = 5;
const OWNER_SUB = "password:owner";
const PROFILE_SUB = "password:%";
// Rows are written in groups so no single statement nears D1's 2 MB value limit.
const ROWS_PER_STATEMENT = 500;

type Table = (typeof TABLES)[number];
type Cell = string | number | null;
type BackupRow = Record<string, Cell>;
type Identity = { user_id: string; display_name: string; avatar_color: string; avatar_icon: string; google_sub: string };

export type BackupProfile = { userId: string; name: string; color: string; icon: string; owner: boolean };

export type BackupEnvelope = {
  format: "remaivo-backup";
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  profiles: BackupProfile[];
  tables: Record<Table, BackupRow[]>;
};

export class BackupError extends Error {
  status = 400;
}

const NOT_A_BACKUP = "This file isn't a Remaivo backup.";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function identities() {
  const { results } = await env.DB.prepare("SELECT user_id, display_name, avatar_color, avatar_icon, google_sub FROM auth_identities WHERE google_sub LIKE ? ORDER BY google_sub <> ?, created_at, rowid")
    .bind(PROFILE_SUB, OWNER_SUB).all<Identity>();
  return results;
}

export async function exportBackup(): Promise<BackupEnvelope> {
  const people = await identities();
  const owners = JSON.stringify(people.map(person => person.user_id));
  const results = await env.DB.batch(TABLES.map(table =>
    env.DB.prepare(`SELECT * FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`).bind(owners)
  ));
  const data = {} as Record<Table, BackupRow[]>;
  TABLES.forEach((table, index) => { data[table] = results[index].results as BackupRow[]; });
  return {
    format: "remaivo-backup",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profiles: people.map(person => ({ userId: person.user_id, name: person.display_name, color: person.avatar_color, icon: person.avatar_icon, owner: person.google_sub === OWNER_SUB })),
    tables: data,
  };
}

type PlannedProfile = BackupProfile & { to: string; isNew: boolean };
type RestorePlan = { exportedAt: string; profiles: PlannedProfile[]; tables: Record<Table, BackupRow[]>; columns: Record<Table, string[]>; kept: Identity[] };

function fileProfiles(file: Record<string, unknown>, user: string, people: Identity[]): BackupProfile[] {
  if (file.version === OLDEST_VERSION) {
    // Exports before 1.3 held one profile. A file from another install has an
    // unknown owner, so it goes to the profile that is restoring it.
    const person = people.find(entry => entry.user_id === file.ownerId) ?? people.find(entry => entry.user_id === user);
    if (typeof file.ownerId !== "string" || !person) throw new BackupError(NOT_A_BACKUP);
    return [{ userId: file.ownerId, name: person.display_name, color: person.avatar_color, icon: person.avatar_icon, owner: false }];
  }
  if (!Array.isArray(file.profiles) || !file.profiles.length) throw new BackupError(NOT_A_BACKUP);
  const profiles = file.profiles as BackupProfile[];
  const malformed = profiles.some(profile => !isObject(profile) || typeof profile.userId !== "string" || !profile.userId || typeof profile.name !== "string" || typeof profile.color !== "string" || typeof profile.icon !== "string");
  if (malformed || profiles.length > MAX_PROFILES || profiles.filter(profile => profile.owner === true).length !== 1) throw new BackupError(NOT_A_BACKUP);
  return profiles;
}

// Checks the whole file before anything is written. Table and column names go
// into SQL, so only names the database itself reports are accepted.
async function planRestore(user: string, file: unknown): Promise<RestorePlan> {
  if (!isObject(file) || file.format !== "remaivo-backup" || typeof file.exportedAt !== "string" || !isObject(file.tables)) throw new BackupError(NOT_A_BACKUP);
  if (typeof file.version !== "number" || file.version < OLDEST_VERSION) throw new BackupError(NOT_A_BACKUP);
  if (file.version > BACKUP_VERSION) throw new BackupError("This backup was made by a newer version of Remaivo. Update this Remaivo first.");

  const people = await identities();
  const owner = people.find(person => person.google_sub === OWNER_SUB);
  const known = (id: string) => people.some(person => person.user_id === id);
  const profiles = fileProfiles(file, user, people).map(profile => {
    const to = profile.owner ? owner?.user_id ?? profile.userId
      : file.version === OLDEST_VERSION && !known(profile.userId) ? user : profile.userId;
    return { ...profile, to, isNew: !known(to) };
  });
  const targets = new Map(profiles.map(profile => [profile.userId, profile.to]));
  if (targets.size !== profiles.length || new Set(targets.values()).size !== profiles.length) throw new BackupError(NOT_A_BACKUP);
  const kept = people.filter(person => !profiles.some(profile => profile.to === person.user_id));
  if (kept.length + profiles.length > MAX_PROFILES) throw new BackupError("Restoring this backup would go over the limit of five profiles. Remove a profile first.");

  const version = file.version;
  const given = { ...(file.tables as Record<string, unknown>) };
  if (version < 7) {
    for (const table of DROPPED_IN_7.tables) delete given[table];
    const strip = (rows: unknown, names: string[]) => Array.isArray(rows) ? rows.map(row => isObject(row) ? Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name))) : row) : rows;
    for (const [table, names] of Object.entries(DROPPED_IN_7.columns)) given[table] = strip(given[table], names);
    if (Array.isArray(given.transactions)) {
      const hidden = new Set((given.transactions as unknown[]).filter(row => isObject(row) && row.status !== undefined && row.status !== "posted").map(row => (row as Record<string, unknown>).id));
      given.transactions = (given.transactions as unknown[]).filter(row => !isObject(row) || !hidden.has(row.id));
      for (const table of ["v3_assignments", "v3_payment_links"]) if (Array.isArray(given[table])) given[table] = (given[table] as unknown[]).filter(row => !isObject(row) || !hidden.has(row.transaction_id));
    }
  }
  if (version < 6) {
    for (const table of DROPPED_IN_6.tables) delete given[table];
    for (const [table, names] of Object.entries(DROPPED_IN_6.columns)) {
      if (!Array.isArray(given[table])) continue;
      // Names were unique per group; keep them unique per profile.
      const seen = new Set<string>();
      given[table] = (given[table] as unknown[]).map(row => {
        if (!isObject(row)) return row;
        const copy = Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name)));
        let name = String(copy.name ?? ""), n = 2;
        while (seen.has(`${copy.user_id}\u0000${name}`)) name = `${copy.name} (${n++})`;
        seen.add(`${copy.user_id}\u0000${name}`);
        return { ...copy, name };
      });
    }
  }
  const source = Object.fromEntries(TABLES.map(table => [table, given[table] === undefined && version < (ADDED_IN[table] ?? 0) ? [] : given[table]]));
  if (Object.keys(given).some(table => !(TABLES as readonly string[]).includes(table)) || TABLES.some(table => !Array.isArray(source[table]))) throw new BackupError(NOT_A_BACKUP);
  const info = await env.DB.batch<{ name: string }>(TABLES.map(table => env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`)));
  const tables = {} as Record<Table, BackupRow[]>;
  const columns = {} as Record<Table, string[]>;
  TABLES.forEach((table, index) => {
    const allowed = new Set(info[index].results.map(column => column.name));
    const used = new Set<string>();
    tables[table] = (source[table] as unknown[]).map(row => {
      if (!isObject(row)) throw new BackupError(NOT_A_BACKUP);
      for (const [name, value] of Object.entries(row)) {
        if (!allowed.has(name)) throw new BackupError("This backup holds data this version of Remaivo no longer uses, so it can't be restored here.");
        if (value !== null && typeof value !== "string" && typeof value !== "number") throw new BackupError(NOT_A_BACKUP);
        used.add(name);
      }
      const target = targets.get(String(row.user_id));
      if (!target) throw new BackupError(NOT_A_BACKUP);
      return { ...row, user_id: target } as BackupRow;
    });
    columns[table] = [...used];
  });
  return { exportedAt: file.exportedAt, profiles, tables, columns, kept };
}

const countFor = (rows: BackupRow[], user: string) => rows.filter(row => row.user_id === user).length;

// What a restore would replace, for the person to check before going ahead.
export async function previewRestore(user: string, file: unknown) {
  const plan = await planRestore(user, file);
  const current = await env.DB.batch<{ user_id: string; total: number }>(["transactions", "accounts"].map(table =>
    env.DB.prepare(`SELECT user_id, COUNT(*) AS total FROM ${table} GROUP BY user_id`)));
  const now = (index: number, id: string) => current[index].results.find(row => row.user_id === id)?.total ?? 0;
  return {
    exportedAt: plan.exportedAt,
    profiles: plan.profiles.map(profile => ({
      name: profile.name,
      isNew: profile.isNew,
      transactions: { now: now(0, profile.to), backup: countFor(plan.tables.transactions, profile.to) },
      accounts: { now: now(1, profile.to), backup: countFor(plan.tables.accounts, profile.to) },
    })),
    kept: plan.kept.map(person => person.display_name),
  };
}

// Replaces the profiles in the file and leaves every other profile alone. A
// batch is one transaction, so any failure leaves the data exactly as it was.
export async function restoreBackup(user: string, file: unknown) {
  const plan = await planRestore(user, file);
  const owners = JSON.stringify(plan.profiles.map(profile => profile.to));
  const statements = [
    // Rows reference each other, so references are checked at the end.
    env.DB.prepare("PRAGMA defer_foreign_keys = on"),
    ...TABLES.map(table => env.DB.prepare(`DELETE FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?))`).bind(owners)),
    ...plan.profiles.map(profile => profile.isNew
      ? env.DB.prepare("INSERT INTO auth_identities (google_sub, user_id, email, display_name, avatar_color, avatar_icon) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(`password:${profile.to}`, profile.to, `${profile.to}@remaivo.local`, profile.name, profile.color, profile.icon)
      : env.DB.prepare("UPDATE auth_identities SET display_name = ?, avatar_color = ?, avatar_icon = ? WHERE user_id = ?")
        .bind(profile.name, profile.color, profile.icon, profile.to)),
  ];
  for (const table of TABLES) {
    const rows = plan.tables[table];
    const names = plan.columns[table];
    const insert = `INSERT INTO ${table} (${names.map(name => `"${name}"`).join(", ")}) SELECT ${names.map((_, index) => `json_extract(value, '$[${index}]')`).join(", ")} FROM json_each(?)`;
    for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
      const values = rows.slice(start, start + ROWS_PER_STATEMENT).map(row => names.map(name => row[name] ?? null));
      statements.push(env.DB.prepare(insert).bind(JSON.stringify(values)));
    }
  }
  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ event: "restore_failed", message: error instanceof Error ? error.message : "unknown" }));
    throw new BackupError("This backup couldn't be restored. Nothing was changed.");
  }
  return { profiles: plan.profiles.length };
}
