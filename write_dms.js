#!/usr/bin/env node
/**
 * write_dms.js — Write cold outreach DMs for qualified leads using NVIDIA NIM.
 * Updates results/qualified.csv IN PLACE by filling a new `dm_text` column.
 * Reads the DM-writing prompt from DM.md.
 *
 * Usage:
 *   node write_dms.js
 *   LIMIT=5 node write_dms.js
 *   CONCURRENCY=5 node write_dms.js
 *
 * Env (.env):
 *   NVIDIA_API_KEY   (required) NVIDIA NIM key (nvapi-...)
 *   NVIDIA_MODEL     default: openai/gpt-oss-120b
 *   NVIDIA_BASE_URL  default: https://integrate.api.nvidia.com/v1
 *   NVIDIA_TIMEOUT   per-DM timeout seconds (default 300)
 *   NVIDIA_RPM       requests/minute cap, shared across workers (default 40)
 *   RESULTS_DIR      default: ./results
 *   CONCURRENCY      default: 1
 *   LIMIT            default: 0 (all qualified rows without a DM yet)
 *
 * Resume: rows whose `dm_text` is already non-empty are skipped automatically.
 * Errors are logged to stderr; the row's dm_text stays empty so the next run
 * retries it.
 *
 * IMPORTANT: do not run this while qualify_leads_zen.js is still writing to
 * qualified.csv — they'd race on the same file.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');

// lead_sub_category -> business_type_plural
const BIZ_TYPE_PLURAL = {
  'Hotel': 'hotels', 'Resort': 'resorts', 'Serviced Apartment': 'serviced apartments',
  'Villa': 'villas', 'Hospitality Brand': 'hospitality brands',
  'Restaurant': 'restaurants', 'Cafe': 'cafes', 'Bar': 'bars',
  'Cloud Kitchen': 'cloud kitchens', 'Dining Group': 'dining groups',
  'F&B Brand': 'F&B brands',
  'Real Estate Developer': 'developers', 'Property Group': 'property groups',
  'Real Estate Agency': 'real estate agencies', 'Project Launch': 'project launches',
  'Salon': 'salons', 'Gym': 'gyms', 'Spa': 'spas', 'Studio': 'studios',
  'Wellness Brand': 'wellness brands', 'Lifestyle Brand': 'lifestyle brands',
};

function loadDmPrompt() {
  const candidates = [path.join(__dirname, 'DM.md'), path.join(process.cwd(), 'DM.md')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/=+\s*BEGIN INSTRUCTIONS\s*=+/i);
    const body = (m ? raw.slice(m.index + m[0].length) : raw).trim();
    if (!body) throw new Error(`${file} has no instructions below BEGIN INSTRUCTIONS.`);
    return { body, file };
  }
  throw new Error('DM.md not found.');
}

function computeMarketLine(location) {
  if (!location) return '';
  const parts = location.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function computeHookFallback(subCategory, city, marketLine) {
  if (!subCategory) return '';
  if (subCategory === 'Outside ICP' || subCategory === 'Unclear') return '';
  const type = subCategory.toLowerCase();
  const loc = city || marketLine;
  if (!loc) return '';
  return `saw you run a ${type} in ${loc}`;
}

function buildPrompt(promptBody, vars) {
  const block = Object.entries(vars).map(([k, v]) => `${k}: ${v || ''}`).join('\n');
  return `${promptBody}\n\n--\n\nNow write the DM for this lead:\n\n${block}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Shared rate limiter: spaces requests evenly across all workers so total
 *  throughput stays under NVIDIA's RPM cap (40 rpm on the free tier). */
let _earliestNextRequest = 0;
async function rateLimit(minIntervalMs) {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, _earliestNextRequest);
  _earliestNextRequest = slot + minIntervalMs;
  if (slot > now) await sleep(slot - now);
}

async function callNvidia(prompt, opts) {
  const maxAttempts = 4;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rateLimit(opts.minIntervalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutSec * 1000);
    try {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 1, top_p: 1, max_tokens: 4096, stream: false,
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error(`empty content: ${text.slice(0, 200)}`);
        return content.trim();
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        if (attempt < maxAttempts) { await sleep(Math.min(30, 2 ** attempt) * 1000); continue; }
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
      lastErr = err.name === 'AbortError' ? `timed out after ${opts.timeoutSec}s` : err.message;
      if (err.name === 'AbortError') throw new Error(lastErr);
      if (attempt < maxAttempts) { await sleep(Math.min(30, 2 ** attempt) * 1000); continue; }
      throw new Error(lastErr);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr || 'unknown nvidia error');
}

/** Atomically rewrite the CSV: write to .tmp, then rename. fs.* sync calls
 *  serialize at the event-loop level, so concurrent workers can't corrupt. */
function rewriteCsv(filePath, columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map(c => L.csvEscape(r[c])).join(','));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function main() {
  const envFile = L.loadDotenv();
  if (envFile) console.log(`Loaded environment from ${envFile}`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) { console.error('NVIDIA_API_KEY required in .env'); process.exit(2); }
  const model = process.env.NVIDIA_MODEL || 'openai/gpt-oss-120b';
  const baseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const timeoutSec = Number(process.env.NVIDIA_TIMEOUT || 300);
  const rpm = Math.max(1, Number(process.env.NVIDIA_RPM || 40));
  const minIntervalMs = Math.ceil(60000 / rpm);

  const resultsDir = process.env.RESULTS_DIR || path.join(process.cwd(), 'results');
  const qualifiedCsv = path.join(resultsDir, 'qualified.csv');

  if (!fs.existsSync(qualifiedCsv)) {
    console.error(`Not found: ${qualifiedCsv}. Run qualify_leads_zen.js first.`);
    process.exit(2);
  }

  const { body: promptBody, file: promptFile } = loadDmPrompt();
  console.log(`Loaded DM prompt from ${promptFile} (${promptBody.length} chars).`);

  // Load all rows, ensure every row has every expected column key (parseCsv
  // omits keys absent in the original header — initialize them to '').
  const allRows = L.parseCsv(fs.readFileSync(qualifiedCsv, 'utf8'));
  for (const r of allRows) {
    for (const c of L.CSV_COLUMNS) if (!(c in r)) r[c] = '';
  }
  console.log(`Loaded ${allRows.length} row(s) from ${qualifiedCsv}.`);

  // Queue: Qualified rows whose dm_text is still empty.
  let remaining = allRows.filter(r =>
    (r.qualification_status || '').toLowerCase() === 'qualified' &&
    !(r.dm_text || '').trim()
  );
  const skipped = allRows.filter(r =>
    (r.qualification_status || '').toLowerCase() === 'qualified' &&
    (r.dm_text || '').trim()
  ).length;
  if (skipped) console.log(`Resume: skipping ${skipped} qualified lead(s) that already have a DM.`);

  const limit = Number(process.env.LIMIT || 0);
  if (limit > 0 && remaining.length > limit) { remaining = remaining.slice(0, limit); console.log(`LIMIT=${limit}: processing only the first ${limit}.`); }

  const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1));
  console.log(`Writing ${remaining.length} DM(s) with model=${model}, concurrency=${CONCURRENCY}, rate-limit=${rpm}rpm.`);
  console.log(`Updating ${qualifiedCsv} in place.`);

  // Persist the schema upfront so partial progress is always readable.
  rewriteCsv(qualifiedCsv, L.CSV_COLUMNS, allRows);

  const counts = { total: remaining.length, written: 0, errors: 0 };
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= remaining.length) return;
      const row = remaining[i];
      const idx = i + 1;

      const subCat = row.lead_sub_category || '';
      const city = row.city || '';
      const marketLine = computeMarketLine(row.location || row.companyLocation || '');
      const businessTypePlural = BIZ_TYPE_PLURAL[subCat] || subCat.toLowerCase();
      const hookFallback = computeHookFallback(subCat, city, marketLine);

      const vars = {
        qualification_status: row.qualification_status,
        lead_category: row.lead_category,
        lead_sub_category: subCat,
        qualification_note: row.qualification_note || '',
        first_name: row.first_name || '',
        company_name: row.company_name || '',
        business_type_plural: businessTypePlural,
        city,
        market_line: marketLine,
        hook_fallback: hookFallback,
        title: row.title || '',
        titleDescription: row.titleDescription || '',
        summary: row.summary || '',
        industry: row.industry || '',
        location: row.location || '',
        companyLocation: row.companyLocation || '',
      };

      const prompt = buildPrompt(promptBody, vars);
      const t0 = Date.now();
      try {
        const dm = await callNvidia(prompt, { apiKey, model, baseUrl, timeoutSec, minIntervalMs });
        row.dm_text = dm;
        rewriteCsv(qualifiedCsv, L.CSV_COLUMNS, allRows);
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        counts.written++;
        console.log(`${idx}/${remaining.length} ${row.company_name} -> DM written (${secs}s)`);
      } catch (err) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        counts.errors++;
        // dm_text stays empty so the next run retries this row.
        console.error(`${idx}/${remaining.length} ${row.company_name} -> error: ${err.message} (${secs}s)`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log('---\nSummary:');
  console.log(`  total:   ${counts.total}`);
  console.log(`  written: ${counts.written}`);
  console.log(`  errors:  ${counts.errors}`);
  console.log(`Updated: ${qualifiedCsv}`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
