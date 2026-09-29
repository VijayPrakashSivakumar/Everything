/* Read-only check: does the live database match what the migrations describe?
 *
 *   node Everything/scripts/schema-drift.mjs
 *
 * Every migration is parsed for the tables it creates, the columns it adds, the
 * row-level security it enables, and the policies it writes. The live database is
 * then read over the same PostgREST interface the API already uses, and the two are
 * compared. Anything the migrations mention and the database lacks is reported, and
 * so is anything the database has that no migration mentions.
 *
 * Why this exists, and why it is read-only:
 *
 * The migrations are the only record of what the schema is supposed to be. A table
 * added by hand during debugging, a migration that failed halfway on a shared
 * project, or a column renamed in the dashboard would all leave the policies
 * describing a schema that no longer exists — and since the RLS policies ARE the
 * access control, a table with a policy against a missing column is a table
 * quietly failing open or closed. None of that raises an error anywhere else, and
 * the test suite stubs the database, so it cannot catch it either.
 *
 * So the question is only ever *asked*, never acted on. This script issues SELECTs
 * and nothing else: no DDL, no writes, no migration, no repair. A clean run proves
 * the schema matches; a dirty run tells you where to look. Fixing anything is a
 * separate, deliberate act.
 *
 * It needs a service-role key, which is why it is a script and not a suite: that
 * key bypasses RLS, so it must never be reachable from a test run that anyone else
 * could trigger. Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the
 * environment, the same two the API uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..');
const migrationsDir = path.join(repoRoot, 'supabase', 'migrations');

const results = [];
const note = (ok, name, detail) => {
  results.push({ ok, name, detail: detail || '' });
  if (!ok) process.exitCode = 1;
};

/* ---------- 1. What the migrations claim ---------- */

function parseMigrations() {
  // `items` is a different case from the rest: the migrations never create it, they only
  // `alter table if exists` it and write a policy for it, because it predates the foundation
  // migration. So a table the migrations merely *touch* is not one they promise to exist, and
  // demanding it would report drift against a table nobody ever wrote. Kept separate: `tables`
  // is what the migrations promise, `referenced` is what they assume.
  const tables = new Map();      // table -> Set of columns  (created by a migration)
  const referenced = new Map();  // table -> columns, for tables only altered/policied, never created
  const rlsTables = new Set();   // tables the migrations enable RLS on
  const policies = new Map();    // table -> Set of policy names

  // Migrations write `public.entries`, PostgREST answers `entries`. Strip the schema on
  // the way in so the two sides of the comparison are always bare table names.
  const bare = (name) => name.replace(/^.*\./, '').toLowerCase();

  const addColumn = (rawTable, column) => {
    const table = bare(rawTable);
    if (!tables.has(table)) {
      tables.set(table, new Set());
      referenced.delete(table);
    }
    tables.get(table).add(column);
  };

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    // The migrations are CRLF in this checkout, and a pattern anchored on \n never matches a
    // line ending in \r\n — so the parse silently found 1 table and 0 RLS statements instead of
    // 10 and 10, and would have reported every table as missing. Normalise first; SQL has no
    // meaning attached to which line ending a file uses.
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8').replace(/\r\n/g, '\n');

    // create table [if not exists] name ( ... );  — take the indented column lines.
    for (const match of sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s*\(([\s\S]*?)\n\);/gi,
    )) {
      const table = bare(match[1]);
      if (!tables.has(table)) tables.set(table, new Set());
      for (const raw of match[2].split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // Skip table-level constraints; only bare `<name> <type>` lines are columns.
        if (/^(constraint|primary|unique|foreign|check|exclude)\b/i.test(line)) continue;
        const column = line.split(/\s+/)[0];
        if (column && /^[a-z_][a-z0-9_]*$/i.test(column)) addColumn(table, column);
      }
    }

    // alter table [if exists] name add column [if not exists] col ...
    // The gap between the table name and `add column` must not cross a `;`, or a statement that
    // only alters a table would reach forward and adopt the columns of a later statement — which
    // is how a phantom column on the wrong table appears out of a file that is perfectly valid.
    for (const match of sql.matchAll(
      /alter\s+table\s+(?:if\s+exists\s+)?([\w.]+)[^;]*?add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi,
    )) {
      const table = bare(match[1]);
      // A table only altered here was not created by any migration, so record its columns
      // without promoting it into the set the existence check demands.
      if (!tables.has(table)) {
        if (!referenced.has(table)) referenced.set(table, new Set());
        referenced.get(table).add(match[2]);
        continue;
      }
      addColumn(table, match[2]);
    }

    for (const match of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?([\w.]+)\s+enable\s+row\s+level\s+security/gi)) {
      rlsTables.add(bare(match[1]));
    }

    for (const match of sql.matchAll(/create\s+policy\s+(\w+)\s+on\s+([\w.]+)/gi)) {
      const [, name, rawTable] = match;
      const table = bare(rawTable);
      if (!policies.has(table)) policies.set(table, new Set());
      policies.get(table).add(name);
    }
  }

  return { tables, referenced, rlsTables, policies, files };
}
/* ---------- 2. What the database actually has ---------- */

/* One round trip to PostgREST, which speaks the same protocol the API already
   uses. A service-role key is required because RLS hides the very rows this needs
   to inspect — with the anon key every table would look empty, which would read as
   a clean result rather than as a failed check. */
/* Reads a table's real column list, without depending on it containing a row.

   PostgREST serves the OpenAPI description at its root, and every exposed table appears
   there with its columns — independent of whether the table holds anything. That is the
   only source that works for an empty table, and on a fresh install most tables are empty.

   Falls back to a row's keys if the root is unavailable, because a table that is empty and
   also absent from the description would otherwise be indistinguishable from one that does
   not exist. That fallback is marked in the result so the caller can say which it used. */
async function columnsOf(table, headers, endpoint) {
  try {
    const res = await fetch(endpoint, { headers });
    if (res.ok) {
      const spec = await res.json();
      const def = spec && spec.definitions && spec.definitions[table];
      if (def) {
        /* PostgREST describes a table as { type: 'object', properties: { <column>: {...} } }. The
           nested form is the reliable one, so prefer it.

           The flattened fallback below was filtering out the OpenAPI keywords `type`,
           `description`, `required`, `enum` and `format` — and one of those words is `description`,
           which is also a real column in four of these tables. So the filter deleted a column
           that exists, and the check reported `entries.description`, `tasks.description`,
           `projects.description` and `goals.description` as missing. A keyword is only a keyword
           by position: `type` at the top level of a definition is the schema type, but a column
           called `type` is a column. So decide by shape, not by name. */
        if (def.properties && typeof def.properties === 'object' && Object.keys(def.properties).length) {
          return new Set(Object.keys(def.properties));
        }

        // A flattened definition: every key whose value is an object is a column, because the
        // keywords that can appear at this level (`type`, `required`, `enum`) are strings or
        // arrays. A column named `type` is still an object, so it survives.
        const objects = Object.entries(def).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v));
        if (objects.length) return new Set(objects.map(([k]) => k));
      }
    }
  } catch (err) {
    /* Fall through to the row probe below. */
  }

  const res = await fetch(`${endpoint}${table}?select=*&limit=1`, { headers });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
  const rows = await res.json();
  // Still no column list, and the table is genuinely empty. Report that honestly rather than
  // treating it as an absence: the caller can then say "could not read" instead of "missing".
  return new Set(rows.length ? Object.keys(rows[0]) : []);
}

async function readLiveSchema(url, key) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const get = async (table, extra = '') => {
    const res = await fetch(`${endpoint}${table}?select=*&limit=1${extra}`, { headers });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    // No rows still carries the column list, so a genuinely empty table is fine.
    return body;
  };

  const tables = [
    'entries', 'tasks', 'people', 'projects', 'goals',
    'households', 'household_members',
    'push_subscriptions', 'notification_log', 'digest_preferences', 'items',
  ];

  const live = new Map();
  const missing = [];
  for (const table of tables) {
    try {
      const rows = await get(table);
      /* The column list has to come from the table, not from a row in it. Reading the keys of
         the first row means an EMPTY table reports zero columns, and every column the
         migrations promise then looks absent — which is how `goals`, `people`, `projects` and
         six others were reported as missing 36 columns that are present and correct.

         PostgREST answers an explicit column list with an empty array and a 200, so asking for
         the columns by name distinguishes "this table has no such column" (400) from "this
         table is empty" (200, no rows). A brand-new install is mostly empty tables, so the
         empty case is the common one and cannot be the one that guesses. */
      const names = await columnsOf(table, headers, endpoint);
      live.set(table, names);
      void rows;
    } catch (err) {
      // PostgREST answers 404 for a table it does not expose; that is drift, not a
      // connection failure, so it is recorded and the rest of the check continues.
      missing.push(table);
    }
  }
  return { live, missing };
}

/* RLS state and the policy list cannot be read through PostgREST, because they are
   properties of the schema rather than rows of a table. PostgREST does expose a
   service-role-only RPC for exactly this, so use it when present and say clearly
   when it is not, rather than reporting "no policies" for a check that never ran. */
async function readSecurity(url, key) {
  const endpoint = `${url.replace(/\/+$/, '')}/rest/v1/`;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  let rls = new Set();
  let policies = new Map();
  let method = 'unavailable';

  try {
    const res = await fetch(`${endpoint}rpc/schema_security`, {
      method: 'POST', headers, body: JSON.stringify({}),
    });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body)) {
        method = 'rpc';
        for (const row of body) {
          if (row.rls_enabled) rls.add(row.table_name);
          if (!policies.has(row.table_name)) policies.set(row.table_name, new Set());
          if (row.policy_name) policies.get(row.table_name).add(row.policy_name);
        }
      }
    }
  } catch (err) {
    /* No RPC: fall through and report the check as not-run. */
  }

  return { rls, policies, method };
}
/* ---------- 3. Compare ---------- */

function compare(claimed, live) {
  const absentTables = [];
  const absentColumns = [];
  const unreadable = [];

  for (const [table, columns] of claimed.tables) {
    if (!live.has(table)) { absentTables.push(table); continue; }
    const present = live.get(table);
    // An empty set means the table is there but its columns could not be read — an empty table
    // with no schema description. That is not evidence of a missing column, so it is reported
    // separately; treating "cannot tell" as "absent" is how 36 healthy columns were once listed
    // as missing.
    if (present.size === 0) { unreadable.push(table); continue; }
    for (const column of columns) {
      if (!present.has(column)) absentColumns.push(`${table}.${column}`);
    }
  }
  return { absentTables, absentColumns, unreadable };
}

/* ---------- 4. Report ---------- */

const claimed = parseMigrations();
console.log(`Read ${claimed.files.length} migrations from supabase/migrations/`);
console.log(`  ${claimed.tables.size} tables, ${claimed.rlsTables.size} with RLS, ` +
            `${[...claimed.policies.values()].reduce((n, s) => n + s.size, 0)} policies\n`);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  // A check that did not run must not print a pass banner. The message above says nothing was
  // read, and a line underneath saying "PASSED" contradicts it — the failure mode verify.mjs
  // exists to prevent, and a skip reported as a pass is worse than no check at all, because it
  // looks like the database was verified. So: no banner, and a non-zero exit, which is what a
  // caller in CI would expect from a check that produced no result.
  console.log('SKIPPED  no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.');
  console.log('');
  console.log('Nothing was read and nothing was changed. To run the check:');
  console.log(`  $env:SUPABASE_URL="${url || 'https://<ref>.supabase.co'}"`);
  console.log('  $env:SUPABASE_SERVICE_ROLE_KEY="<service-role key>"');
  console.log('  node Everything/scripts/schema-drift.mjs');
  console.log('');
  console.log('The service-role key is the SECRET key, not the publishable one. With the publishable');
  console.log('key RLS hides every row, and this would report every table as missing.');
  console.log('');
  console.log('SCHEMA DRIFT CHECKS DID NOT RUN');
  process.exit(2);
}

let liveSchema;
try {
  liveSchema = await readLiveSchema(url, key);
} catch (err) {
  console.log(`FAIL  could not reach ${url} — ${err.message}`);
  console.log('\nSCHEMA DRIFT FOUND PROBLEMS');
  process.exit(1);
}

/* readLiveSchema returns { live, missing } — a wrapper, not the map itself. Passing the
   wrapper here made `live.has` undefined and crashed the check on its first table, which
   is why the count line printed and then the run died: the parse had already succeeded. */
const { absentTables, absentColumns, unreadable } = compare(claimed, liveSchema.live);

note(absentTables.length === 0, 'every table the migrations create exists',
  absentTables.length ? `missing: ${absentTables.join(', ')}` : '');
note(absentColumns.length === 0, 'every column the migrations add exists',
  absentColumns.length ? `missing: ${absentColumns.join(', ')}` : '');

// Not a failure: the table exists, but it is empty and PostgREST exposed no column list for
// it, so nothing can be said about its columns either way. Saying so is the point — an
// earlier version reported these as missing columns, which was a false alarm on every one.
if (unreadable.length) {
  console.log(`NOTE  ${unreadable.length} empty table(s) exposed no column list, so their columns ` +
              `were not checked: ${unreadable.join(', ')}`);
}

const security = await readSecurity(url, key);
if (security.method === 'rpc') {
  const noRls = [...claimed.rlsTables].filter((t) => !security.rls.has(t));
  note(noRls.length === 0, 'row-level security is enabled where the migrations enable it',
    noRls.length ? `not enabled on: ${noRls.join(', ')}` : '');
} else {
  console.log('SKIPPED  could not read RLS state (needs the schema_security RPC).');
  console.log('          Run in the SQL editor:');
  console.log('            select relname, relrowsecurity from pg_class');
  console.log('            where relnamespace = \'public\'::regnamespace and relkind = \'r\';');
}

/* A table the migrations never describe is the finding that matters most — but "never
   created" and "never mentioned" are different, and the difference is the whole answer.

   `items` is created by no migration and yet is altered, indexed, given RLS and given a
   policy by seven of them. It predates the foundation migration: the app still reads and
   writes it, and the migrations treat it as already existing. Flagging that as unowned
   would be a false alarm, because it is protected — a policy is written for it.

   So the two cases are reported separately. Referenced-but-never-created is a real gap: the
   schema cannot be rebuilt from these migrations alone, because nothing in them produces
   the table the other seven assume. Nothing is told to be deleted. */
const unknown = [...liveSchema.live.keys()].filter((t) => !claimed.tables.has(t));
const trulyUnknown = unknown.filter((t) => !claimed.referenced.has(t));
const assumed = unknown.filter((t) => claimed.referenced.has(t));

note(trulyUnknown.length === 0, 'no table exists that no migration accounts for',
  trulyUnknown.length ? `unmanaged: ${trulyUnknown.join(', ')}` : '');

if (assumed.length) {
  note(false, 'every table in the database is created by some migration',
    `${assumed.join(', ')}: used and policied by the migrations, but created by none.\n` +
    '        A fresh database built from these migrations alone would not have it.');
}

for (const r of results) {
  if (r.ok && !process.env.DRIFT_VERBOSE) continue;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
}

/* The banner has to be the *outcome*, not the shape. A real run reached here once with two
   FAILs above it and still printed "ALL 3 SCHEMA DRIFT CHECKS PASSED" — because the count
   was right and the verdict was missing. That is the contradiction verify.mjs exists to
   catch, and a drift check that claims PASSED beside its own failures is worse than one
   that stays silent, because the failures scroll past and the last line is what gets read. */
console.log(process.exitCode
  ? '\nSCHEMA DRIFT CHECKS FOUND PROBLEMS'
  : `\nALL ${results.length} SCHEMA DRIFT CHECKS PASSED`);