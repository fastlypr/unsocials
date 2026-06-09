#!/usr/bin/env node
/**
 * write_dms.js — Write cold outreach DMs for qualified leads using NVIDIA NIM.
 * Reads results/qualified.csv (from qualify_leads_zen.js) + DM.md (the prompt).
 * Writes one DM per qualified lead to results/dms.csv.
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
 *   RESULTS_DIR      default: ./results
 *   RESUME           default: 1 (skip already-written DMs)
 *   CONCURRENCY      default: 1
 *   LIMIT            default: 0 (all qualified)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const L = require('./lib');

const DM_CSV_COLUMNS = [
  'lead_id', 'first_name', 'company_name', 'defaultProfileUrl', 'companyUrl',
  'lead_category', 'lead_sub_category', 'business_type_plural', 'city', 'market_line',
  'personal_note', 'personal_hook', 'hook_fallback', 'dm_text', 'error',
];

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

/** Derive market_line from location: "Phuket, Thailand" -> "Thailand", "Bangkok" -> "Bangkok". */
function computeMarketLine(location) {
  if (!location) return '';
  const parts = location.split(',').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/** Rule-based hook_fallback: "saw you run a <type> in <city or market>". */
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

/** POST to NVIDIA's OpenAI-compatible /chat/completions with retry on 429/5xx. */
async function callNvidia(prompt, opts) {
  const maxAttempts = 4;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

async function main() {
  const envFile = L.loadDotenv();
  if (envFile) console.log(`Loaded environment from ${envFile}`);

  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) { console.error('NVIDIA_API_KEY required in .env'); process.exit(2); }
  const model = process.env.NVIDIA_MODEL || 'openai/gpt-oss-120b';
  const baseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  const timeoutSec = Number(process.env.NVIDIA_TIMEOUT || 300);

  const resultsDir = process.env.RESULTS_DIR || path.join(process.cwd(), 'results');
  const qualifiedCsv = path.join(resultsDir, 'qualified.csv');
  const dmsCsv = path.join(resultsDir, 'dms.csv');

  if (!fs.existsSync(qualifiedCsv)) {
    console.error(`Not found: ${qualifiedCsv}. Run qualify_leads_zen.js first.`);
    process.exit(2);
  }

  const { body: promptBody, file: promptFile } = loadDmPrompt();
  console.log(`Loaded DM prompt from ${promptFile} (${promptBody.length} chars).`);

  let rows = L.parseCsv(fs.readFileSync(qualifiedCsv, 'utf8'));
  rows = rows.filter(r => (r.qualification_status || '').toLowerCase() === 'qualified');
  console.log(`Loaded ${rows.length} qualified lead(s) from ${qualifiedCsv}.`);

  const limit = Number(process.env.LIMIT || 0);
  if (limit > 0 && rows.length > limit) { rows = rows.slice(0, limit); console.log(`LIMIT=${limit}: processing only the first ${limit}.`); }

  L.ensureCsvHeader(dmsCsv, DM_CSV_COLUMNS);
  const resume = !/^(0|false|no)$/i.test(process.env.RESUME || '1');
  const processed = resume ? L.readProcessedIds([dmsCsv]) : new Set();
  if (processed.size) console.log(`Resume on: skipping ${processed.size} already-written DM(s).`);

  const remaining = rows.filter(r => !processed.has(r.lead_id));
  const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1));
  console.log(`Writing ${remaining.length} DM(s) with model=${model}, concurrency=${CONCURRENCY}.`);
  console.log(`Output: ${dmsCsv}`);

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
        city: city,
        market_line: marketLine,
        hook_fallback: hookFallback,
        // Raw enrichment fields — the DM.md prompt derives personal_note and
        // personal_hook from these instead of receiving them pre-filled.
        title: row.title || '',
        titleDescription: row.titleDescription || '',
        summary: row.summary || '',
        industry: row.industry || '',
      };

      const prompt = buildPrompt(promptBody, vars);
      const t0 = Date.now();
      try {
        const dm = await callNvidia(prompt, { apiKey, model, baseUrl, timeoutSec });
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        L.appendCsvRow(dmsCsv, DM_CSV_COLUMNS, {
          lead_id: row.lead_id,
          first_name: row.first_name, company_name: row.company_name,
          defaultProfileUrl: row.defaultProfileUrl, companyUrl: row.companyUrl,
          lead_category: row.lead_category, lead_sub_category: subCat,
          business_type_plural: businessTypePlural, city, market_line: marketLine,
          personal_note: '', personal_hook: '', hook_fallback: hookFallback,
          dm_text: dm, error: '',
        });
        counts.written++;
        console.log(`${idx}/${remaining.length} ${row.company_name} -> DM written (${secs}s)`);
      } catch (err) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        counts.errors++;
        console.log(`${idx}/${remaining.length} ${row.company_name} -> error: ${err.message} (${secs}s)`);
        L.appendCsvRow(dmsCsv, DM_CSV_COLUMNS, {
          lead_id: row.lead_id,
          first_name: row.first_name, company_name: row.company_name,
          defaultProfileUrl: row.defaultProfileUrl, companyUrl: row.companyUrl,
          error: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log('---\nSummary:');
  console.log(`  total:   ${counts.total}`);
  console.log(`  written: ${counts.written}`);
  console.log(`  errors:  ${counts.errors}`);
  console.log(`DMs: ${dmsCsv}`);
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
