// One-off import: loads data/templates/{1_landlords,2_properties,3_leases,4_transactions}.csv
// into Supabase in dependency order. Safe to re-run: rows that already exist
// (matched by natural key) are skipped, and all references are resolved and
// validated before anything is written.
//
//   npx tsx scripts/import-family-data.ts [--dry-run]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from '../src/db/client';

const DRY_RUN = process.argv.includes('--dry-run');
const DIR = resolve(process.cwd(), 'data/templates');

const CATEGORIES = new Set([
  'rent', 'common_fee', 'agency', 'maintenance',
  'tax', 'utilities', 'insurance', 'deposit', 'other',
]);

// ── CSV parsing (BOM- and quote-aware) ────────────────────────
function parseCsv(path: string): Record<string, string>[] {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f.trim() !== '')) rows.push(row); }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

function parseAmount(s: string): number {
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`bad amount: "${s}"`);
  return n;
}

// Dates: ISO YYYY-MM-DD passes through; M/D/YYYY (Excel) is converted.
function parseDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`bad date: "${s}" (expected YYYY-MM-DD or M/D/YYYY)`);
  const [, mo, d, y] = m;
  if (Number(mo) > 12) throw new Error(`bad date: "${s}" (month > 12 — is this D/M/YYYY?)`);
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function main() {
  const landlordsCsv = parseCsv(resolve(DIR, '1_landlords.csv'));
  const propertiesCsv = parseCsv(resolve(DIR, '2_properties.csv'));
  const leasesCsv = parseCsv(resolve(DIR, '3_leases.csv'));
  const txnsCsv = parseCsv(resolve(DIR, '4_transactions.csv'));
  const today = new Date().toISOString().slice(0, 10);

  // ── Validate everything up front (no writes yet) ────────────
  const ownerNames = new Set(landlordsCsv.map((r) => r.display_name));
  const propNames = new Set(propertiesCsv.map((r) => r.property_name));
  const errors: string[] = [];

  for (const [i, p] of propertiesCsv.entries()) {
    if (!ownerNames.has(p.owner_name)) errors.push(`2_properties row ${i + 2}: unknown owner "${p.owner_name}"`);
  }
  for (const [i, l] of leasesCsv.entries()) {
    if (!propNames.has(l.property_name)) errors.push(`3_leases row ${i + 2}: unknown property "${l.property_name}"`);
    try { parseDate(l.start_date); parseDate(l.end_date); } catch (e) { errors.push(`3_leases row ${i + 2}: ${(e as Error).message}`); }
    if (!['fixed', 'rent_plus_utilities'].includes(l.billing_type)) errors.push(`3_leases row ${i + 2}: bad billing_type "${l.billing_type}"`);
  }
  for (const [i, t] of txnsCsv.entries()) {
    const isPool = !t.owner_name && !t.property_name;
    if (t.owner_name && !ownerNames.has(t.owner_name)) errors.push(`4_transactions row ${i + 2}: unknown owner "${t.owner_name}"`);
    if (t.property_name && !propNames.has(t.property_name)) errors.push(`4_transactions row ${i + 2}: unknown property "${t.property_name}"`);
    if (!t.owner_name && t.property_name) errors.push(`4_transactions row ${i + 2}: property without owner`);
    if (!['in', 'out'].includes(t.direction)) errors.push(`4_transactions row ${i + 2}: bad direction "${t.direction}"`);
    if (!CATEGORIES.has(t.category)) errors.push(`4_transactions row ${i + 2}: bad category "${t.category}"`);
    try { parseDate(t.date); } catch (e) { errors.push(`4_transactions row ${i + 2}: ${(e as Error).message}`); }
    try { parseAmount(t.amount); } catch (e) { errors.push(`4_transactions row ${i + 2}: ${(e as Error).message}`); }
    void isPool;
  }
  if (errors.length) {
    console.error(`VALIDATION FAILED (${errors.length}):`);
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }
  console.log(`validated: ${landlordsCsv.length} landlords, ${propertiesCsv.length} properties, ${leasesCsv.length} leases, ${txnsCsv.length} transactions`);
  if (DRY_RUN) { console.log('dry run — nothing written'); return; }

  // ── 1. Landlords (skip existing by display_name) ────────────
  const { data: exL, error: e1 } = await db.from('landlords').select('id, display_name');
  if (e1) throw e1;
  const landlordId = new Map<string, string>((exL ?? []).map((l) => [l.display_name as string, l.id as string]));
  const newLandlords = landlordsCsv.filter((r) => !landlordId.has(r.display_name));
  if (newLandlords.length) {
    const { data, error } = await db.from('landlords')
      .insert(newLandlords.map((r) => ({ display_name: r.display_name })))
      .select('id, display_name');
    if (error) throw error;
    for (const l of data!) landlordId.set(l.display_name, l.id);
  }
  console.log(`landlords: +${newLandlords.length} inserted, ${landlordsCsv.length - newLandlords.length} already present`);

  // ── 2. Properties (skip existing by name) ───────────────────
  const { data: exP, error: e2 } = await db.from('properties').select('id, name');
  if (e2) throw e2;
  const propertyId = new Map<string, string>((exP ?? []).map((p) => [p.name as string, p.id as string]));
  const newProps = propertiesCsv.filter((r) => !propertyId.has(r.property_name));
  if (newProps.length) {
    const { data, error } = await db.from('properties')
      .insert(newProps.map((r) => ({
        landlord_id: landlordId.get(r.owner_name)!,
        name: r.property_name,
        building: r.building || null,
        unit_no: r.unit_no || null,
        purchase_price: r.purchase_price ? parseAmount(r.purchase_price) : null,
      })))
      .select('id, name');
    if (error) throw error;
    for (const p of data!) propertyId.set(p.name, p.id);
  }
  console.log(`properties: +${newProps.length} inserted, ${propertiesCsv.length - newProps.length} already present`);

  // ── 3. Leases (skip existing by property + tenant + start) ──
  const { data: exLs, error: e3 } = await db.from('leases').select('property_id, tenant_name, start_date');
  if (e3) throw e3;
  const leaseKey = (propId: string, tenant: string, start: string) => `${propId}|${tenant}|${start}`;
  const existingLeases = new Set((exLs ?? []).map((l) => leaseKey(l.property_id, l.tenant_name, l.start_date)));
  const leaseRows = leasesCsv.map((r) => {
    const start = parseDate(r.start_date);
    const end = parseDate(r.end_date);
    let dueDay = Number(r.due_day);
    if (dueDay > 28) { console.warn(`  note: lease "${r.property_name}" / ${r.tenant_name}: due_day ${dueDay} clamped to 28 (schema limit)`); dueDay = 28; }
    return {
      property_id: propertyId.get(r.property_name)!,
      tenant_name: r.tenant_name,
      rent_amount: parseAmount(r.rent_amount),
      deposit_amount: r.deposit_amount ? parseAmount(r.deposit_amount) : null,
      due_day: dueDay,
      billing_type: r.billing_type,
      start_date: start,
      end_date: end,
      expected_payer_name: r.expected_payer_name || null,
      status: end < today ? 'ended' : 'active',
    };
  }).filter((r) => !existingLeases.has(leaseKey(r.property_id, r.tenant_name, r.start_date)));
  if (leaseRows.length) {
    const { error } = await db.from('leases').insert(leaseRows);
    if (error) throw error;
  }
  console.log(`leases: +${leaseRows.length} inserted, ${leasesCsv.length - leaseRows.length} already present`);

  // ── 4. Transactions ──────────────────────────────────────────
  // No natural key exists for manual rows, so instead of per-row dedupe we
  // refuse to double-import: if manual verified rows already exist, stop.
  const { count, error: e4 } = await db.from('transactions')
    .select('id', { count: 'exact', head: true }).eq('source', 'manual');
  if (e4) throw e4;
  if ((count ?? 0) > 0) {
    console.log(`transactions: SKIPPED — ${count} manual transactions already in DB (delete them first to re-import)`);
    return;
  }
  const txnRows = txnsCsv.map((r) => ({
    landlord_id: r.owner_name ? landlordId.get(r.owner_name)! : null,
    property_id: r.property_name ? propertyId.get(r.property_name)! : null,
    direction: r.direction,
    category: r.category,
    amount: parseAmount(r.amount),
    txn_datetime: `${parseDate(r.date)}T12:00:00+07:00`,
    source: 'manual',
    verify_status: 'verified',
    note: r.note || null,
  }));
  const { error: e5 } = await db.from('transactions').insert(txnRows);
  if (e5) throw e5;
  console.log(`transactions: +${txnRows.length} inserted`);

  // ── Verify totals against the DB ─────────────────────────────
  const { data: check, error: e6 } = await db.from('transactions')
    .select('direction, amount').eq('source', 'manual');
  if (e6) throw e6;
  const sumIn = check!.filter((t) => t.direction === 'in').reduce((s, t) => s + Number(t.amount), 0);
  const sumOut = check!.filter((t) => t.direction === 'out').reduce((s, t) => s + Number(t.amount), 0);
  console.log(`DB check: ${check!.length} rows, in=${sumIn.toFixed(2)}, out=${sumOut.toFixed(2)}`);
}

main().catch((e) => { console.error('IMPORT FAILED:', e); process.exit(1); });
