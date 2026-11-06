#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPAIR_MIGRATION = '0016_capture_postgres';
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function tableDigest(columns, rows) {
  return sha256(JSON.stringify(columns) + '\n' + rows.sort().join('\n'));
}

function normalizedValue(value, column) {
  if (value === null) return null;
  if (column.data_type === 'bytea') {
    if (!Buffer.isBuffer(value)) throw new Error(`Expected binary data in ${column.table_name}.${column.column_name}`);
    return { bytes: value.length, sha256: sha256(value) };
  }
  if (column.data_type === 'boolean') {
    if (value === true || value === 1 || value === 1n) return true;
    if (value === false || value === 0 || value === 0n) return false;
    throw new Error(`Invalid boolean in ${column.table_name}.${column.column_name}`);
  }
  if (['smallint', 'integer', 'bigint'].includes(column.data_type)) return BigInt(value).toString();
  if (['real', 'double precision'].includes(column.data_type)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Non-finite number in ${column.table_name}.${column.column_name}`);
    return number;
  }
  if (typeof value !== 'string') throw new Error(`Unexpected value type in ${column.table_name}.${column.column_name}`);
  return value;
}

function selectColumn(column) {
  const name = quote(column.column_name);
  if (column.data_type === 'timestamp with time zone') return `(${name} AT TIME ZONE 'UTC')::text AS ${name}`;
  if (['json', 'jsonb', 'numeric', 'smallint', 'integer', 'bigint'].includes(column.data_type)) return `${name}::text AS ${name}`;
  return name;
}

/**
 * Copy a consistent, read-only SQLite snapshot to a completely empty dedicated
 * PostgreSQL database. Defaults to a full import/verification followed by
 * ROLLBACK. No target table is truncated and the source is never modified.
 * Stop the source application before --apply so later SQLite writes aren't lost.
 */
export async function migrateSqliteToPostgres({ sqlitePath, postgresUrl, apply = false, expectedDatabase, schemaPath = path.join(ROOT, 'schema.pg.sql') }) {
  if (!sqlitePath || !postgresUrl) throw new Error('A source SQLite path and PostgreSQL connection URL are required');
  const source = new Database(path.resolve(sqlitePath), { readonly: true, fileMustExist: true });
  source.defaultSafeIntegers(true);
  source.pragma('query_only = ON');
  const client = new pg.Client({ connectionString: postgresUrl, connectionTimeoutMillis: 10_000 });
  let connected = false;
  let inTransaction = false;
  try {
    source.exec('BEGIN');
    const integrity = source.pragma('quick_check');
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') throw new Error('SQLite integrity check failed');
    const foreignErrors = source.pragma('foreign_key_check');
    if (foreignErrors.length) throw new Error(`SQLite has ${foreignErrors.length} foreign-key violations; source was not changed`);
    const sourceTables = source.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (!sourceTables.includes('users') || !sourceTables.includes('bins') || !sourceTables.includes('schema_migrations')) {
      throw new Error('Source is not an initialized RemindMe/OpenBin database');
    }
    await client.connect();
    connected = true;
    const { rows: [identity] } = await client.query('SELECT current_database() AS database, current_user AS owner');
    if (['postgres', 'template0', 'template1'].includes(identity.database)) throw new Error('Use a new dedicated application database, not a PostgreSQL system database');
    if (expectedDatabase && identity.database !== expectedDatabase) throw new Error('Target database name does not match --database-name');
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    inTransaction = true;
    await client.query("SET LOCAL search_path = public, pg_catalog; SET LOCAL TIME ZONE 'UTC'; SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('remindme:sqlite-import'))");
    const { rows: foreignTables } = await client.query(`SELECT 1 FROM information_schema.tables
      WHERE table_schema NOT IN ('public','information_schema') AND table_schema NOT LIKE 'pg_%'
      AND table_type = 'BASE TABLE' LIMIT 1`);
    if (foreignTables.length) throw new Error('Target contains application tables outside public; use a new dedicated database');
    const { rows: existing } = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    for (const table of existing) {
      await client.query(`LOCK TABLE public.${quote(table.table_name)} IN ACCESS EXCLUSIVE MODE`);
      const { rows: [count] } = await client.query(`SELECT COUNT(*)::text AS count FROM public.${quote(table.table_name)}`);
      if (count.count !== '0') throw new Error(`Target is not empty (${table.table_name}); nothing was imported or deleted`);
    }
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.query(fs.readFileSync(schemaPath, 'utf8'));
    const { rows: metadata } = await client.query(`SELECT table_name,column_name,data_type,column_default
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name,ordinal_position`);
    const tableColumns = new Map();
    for (const column of metadata) {
      if (!tableColumns.has(column.table_name)) tableColumns.set(column.table_name, new Map());
      tableColumns.get(column.table_name).set(column.column_name, column);
    }
    for (const table of sourceTables) {
      if (!tableColumns.has(table)) throw new Error(`Source table ${table} has no target schema; refusing to omit data`);
    }
    // Temporarily defer every FK, preserving and restoring its original flags.
    // This handles users <-> locations and arbitrarily ordered nested areas
    // without disabling referential checks or requiring a superuser.
    const { rows: constraints } = await client.query(`SELECT c.conname,c.condeferrable,c.condeferred,t.relname AS table_name
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace WHERE c.contype = 'f' AND n.nspname = 'public'`);
    for (const constraint of constraints) {
      await client.query(`ALTER TABLE public.${quote(constraint.table_name)} ALTER CONSTRAINT ${quote(constraint.conname)} DEFERRABLE INITIALLY DEFERRED`);
    }
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const canonicalCache = new Map();
    async function sourceValue(value, column) {
      if (value === null) return { parameter: null, canonical: null };
      if (['json', 'jsonb', 'timestamp with time zone', 'numeric'].includes(column.data_type)) {
        const raw = typeof value === 'bigint' ? value.toString() : String(value);
        const cacheKey = `${column.data_type}:${raw}`;
        let canonical = canonicalCache.get(cacheKey);
        if (canonical === undefined) {
          // Let PostgreSQL normalize JSONB and timestamps exactly; JS parsing
          // would lose large JSON numbers or sub-millisecond timestamps.
          const expression = column.data_type === 'timestamp with time zone'
            ? "($1::timestamptz AT TIME ZONE 'UTC')::text"
            : `$1::${column.data_type}::text`;
          const result = await client.query(`SELECT ${expression} AS value`, [raw]);
          canonical = result.rows[0].value;
          canonicalCache.set(cacheKey, canonical);
        }
        return { parameter: raw, canonical };
      }
      const canonical = normalizedValue(value, column);
      const parameter = column.data_type === 'bytea' ? value : canonical;
      return { parameter, canonical };
    }
    const tableReports = [];
    // Insert state counters last: item insertion triggers then cannot modify the
    // captured revision/sequence values that must be copied exactly.
    const orderedTables = sourceTables.filter(table => table !== 'bin_capture_state');
    if (sourceTables.includes('bin_capture_state')) orderedTables.push('bin_capture_state');
    for (const table of orderedTables) {
      const sourceColumns = source.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name);
      const columns = sourceColumns.map(name => {
        const column = tableColumns.get(table).get(name);
        if (!column) throw new Error(`Source column ${table}.${name} has no target schema; refusing to omit data`);
        return column;
      });
      const names = sourceColumns.map(quote).join(',');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(',');
      const insert = `INSERT INTO public.${quote(table)} (${names}) VALUES (${placeholders})`;
      const expectedHashes = [];
      let sourceRows = 0;
      let blobBytes = 0;
      for (const row of source.prepare(`SELECT ${names} FROM ${quote(table)}`).iterate()) {
        sourceRows++;
        const parameters = [];
        const canonical = [];
        for (const column of columns) {
          let value = row[column.column_name];
          if (table === 'settings' && row.key === 'db_engine' && column.column_name === 'value') value = 'postgres';
          const normalized = await sourceValue(value, column);
          parameters.push(normalized.parameter);
          canonical.push(normalized.canonical);
          if (Buffer.isBuffer(value)) blobBytes += value.length;
        }
        await client.query(insert, parameters);
        expectedHashes.push(sha256(JSON.stringify(canonical)));
      }
      const { rows: actualRows } = await client.query(`SELECT ${columns.map(selectColumn).join(',')} FROM public.${quote(table)}`);
      const actualHashes = actualRows.map(row => sha256(JSON.stringify(columns.map(column => normalizedValue(row[column.column_name], column)))));
      const expectedDigest = tableDigest(sourceColumns, expectedHashes);
      const actualDigest = tableDigest(sourceColumns, actualHashes);
      if (sourceRows !== actualRows.length || expectedDigest !== actualDigest) throw new Error(`Content verification failed for ${table}; import will be rolled back`);
      tableReports.push({ table, sourceRows, targetRows: actualRows.length, sha256: actualDigest, blobBytes });
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    for (const constraint of constraints) {
      const deferrability = constraint.condeferrable
        ? `DEFERRABLE INITIALLY ${constraint.condeferred ? 'DEFERRED' : 'IMMEDIATE'}` : 'NOT DEFERRABLE';
      await client.query(`ALTER TABLE public.${quote(constraint.table_name)} ALTER CONSTRAINT ${quote(constraint.conname)} ${deferrability}`);
    }
    // Restore SERIAL generators after explicitly preserving numeric IDs.
    for (const column of metadata.filter(column => column.column_default?.startsWith('nextval('))) {
      const { rows: [sequence] } = await client.query('SELECT pg_get_serial_sequence($1,$2) AS name', [`public.${quote(column.table_name)}`, column.column_name]);
      if (!sequence.name) continue;
      const { rows: [maximum] } = await client.query(`SELECT MAX(${quote(column.column_name)})::text AS value FROM public.${quote(column.table_name)}`);
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)', [sequence.name, maximum.value ?? '1', maximum.value !== null]);
    }
    const addedRepairMarker = await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name', [REPAIR_MIGRATION]);
    const engineMarker = await client.query("INSERT INTO settings (key,value) VALUES ('db_engine','postgres') ON CONFLICT (key) DO NOTHING RETURNING key");
    const report = {
      mode: apply ? 'applied' : 'dry-run', database: identity.database,
      verified: true, sourceSnapshot: 'read-only transaction', tables: tableReports,
      totalRows: tableReports.reduce((sum, table) => sum + table.sourceRows, 0),
      totalBlobBytes: tableReports.reduce((sum, table) => sum + table.blobBytes, 0),
      transformations: ['settings.db_engine=postgres', 'SQLite booleans to PostgreSQL BOOLEAN', 'JSONB/timestamps normalized without numeric precision loss'],
      addedMetadata: { migrationMarkers: addedRepairMarker.rowCount, engineMarker: engineMarker.rowCount },
      externalFiles: 'Filesystem-backed photos, attachments, avatars and active scratch files must be copied separately with their recorded paths preserved.',
    };
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    inTransaction = false;
    return report;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    // Avoid printing SQL parameters, keys, image bytes or the connection URL.
    if (error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
      throw new Error(`PostgreSQL rejected the import (SQLSTATE ${error.code}); target transaction rolled back`, { cause: error });
    }
    if (error instanceof Error) throw new Error(error.message, { cause: error });
    throw new Error('Migration failed; target transaction rolled back');
  } finally {
    if (source.inTransaction) source.exec('ROLLBACK');
    source.close();
    if (connected) await client.end();
  }
}

function parseArguments(args) {
  const options = { apply: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--source') options.sqlitePath = args[++index];
    else if (arg === '--database-name') options.expectedDatabase = args[++index];
    else if (arg === '--report') options.reportPath = args[++index];
    else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let reportFd;
  let reportPath;
  let result;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: DATABASE_URL=... node scripts/migrate-sqlite-to-postgres.mjs --source /path/openbin.db [--dry-run|--apply] [--database-name remindme] [--report /path/report.json]\nDefault: full import verification followed by ROLLBACK. Target must be empty. Stop the source app before --apply.');
    } else {
      // Fail before touching PostgreSQL if the report destination already exists
      // or cannot be opened (common when reusing a dry-run command for --apply).
      if (options.reportPath) {
        reportPath = options.reportPath;
        reportFd = fs.openSync(reportPath, 'wx', 0o600);
      }
      result = await migrateSqliteToPostgres({ ...options, postgresUrl: process.env.DATABASE_URL });
      const output = `${JSON.stringify(result, null, 2)}\n`;
      if (reportFd !== undefined) {
        fs.writeFileSync(reportFd, output);
        fs.fsyncSync(reportFd);
      }
      console.log(output);
    }
  } catch (error) {
    if (result?.mode === 'applied') {
      console.log(JSON.stringify(result, null, 2));
      console.error('Migration applied and verified, but writing the report file failed. The target contains the imported data.');
    } else {
      console.error(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    process.exitCode = 1;
  } finally {
    if (reportFd !== undefined) {
      fs.closeSync(reportFd);
      if (!result && reportPath) fs.rmSync(reportPath, { force: true });
    }
  }
}
