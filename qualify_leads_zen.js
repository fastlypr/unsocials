#!/usr/bin/env node
/**
 * qualify_leads_zen.js — Direct runner. Qualifies Unsocials leads by calling the
 * OpenCode Zen HTTP API directly (https://opencode.ai/zen/v1/chat/completions).
 * No `opencode` binary and no `opencode serve` required — runs anywhere Node
 * 18+ runs. Shared logic lives in lib.js.
 *
 * Usage:
 *   node qualify_leads_zen.js leads.csv
 *   LIMIT=5 node qualify_leads_zen.js "Unsocials 2200 - Leads.csv"
 *
 * Env (see .env.example):
 *   OPENCODE_API_KEY   (required) your OpenCode Zen API key
 *   OPENCODE_MODEL     model, e.g. "opencode/deepseek-v4-flash" (the leading
 *                      "opencode/" is stripped for the Zen API). Or set ZEN_MODEL.
 *   ZEN_MODEL          bare Zen model id override, e.g. "deepseek-v4-flash-free"
 *   ZEN_BASE_URL       default https://opencode.ai/zen/v1
 *   OPENCODE_TIMEOUT   per-lead timeout seconds (default 600)
 *   NOTION_TOKEN/NOTION_DB_ID  optional — also write to Notion if both set
 *   RESULTS_DIR (default ./results), RESUME (default 1), LIMIT (default 0=all)
 */
'use strict';

const path = require('node:path');
const L = require('./lib');

// Default to the OpenCode Go endpoint (subscription). The regular pay-as-you-go
// Zen endpoint is https://opencode.ai/zen/v1 — set ZEN_BASE_URL to override.
function zenBaseUrl() { return process.env.ZEN_BASE_URL || 'https://opencode.ai/zen/go/v1'; }
function zenModel() {
  const m = process.env.ZEN_MODEL || process.env.OPENCODE_MODEL || 'deepseek-v4-pro';
  return m.replace(/^opencode(-go)?\//, ''); // strip opencode/ or opencode-go/ prefix
}

async function checkAuth(key) {
  const res = await fetch(`${zenBaseUrl()}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`OpenCode Zen rejected the key (HTTP ${res.status}). Check OPENCODE_API_KEY.`);
  }
  if (!res.ok) {
    console.warn(`WARN: /models returned HTTP ${res.status}; continuing anyway.`);
    return;
  }
  const data = await res.json().catch(() => null);
  const ids = ((data && (data.data || data.models)) || []).map((m) => m.id || m.name);
  const model = zenModel();
  console.log(`OpenCode Zen reachable. Using model: ${model}${ids.length && !ids.includes(model) ? `  (WARN: not in model list — available: ${ids.join(', ')})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One chat completion with timeout + retry on 429/5xx. Returns the text. */
async function zenComplete(key, prompt, timeoutSec) {
  const model = zenModel();
  const maxAttempts = 4;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
    try {
      const res = await fetch(`${zenBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (res.ok) {
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error(`no content in response: ${text.slice(0, 200)}`);
        return content;
      }
      // Retry on rate limit / server errors; fail fast on client errors.
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        const backoff = Math.min(30, 2 ** attempt) * 1000;
        if (attempt < maxAttempts) { await sleep(backoff); continue; }
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    } catch (err) {
      lastErr = err.name === 'AbortError' ? `timed out after ${timeoutSec}s` : err.message;
      if (err.name === 'AbortError') throw new Error(lastErr);
      if (attempt < maxAttempts) { await sleep(Math.min(30, 2 ** attempt) * 1000); continue; }
      throw new Error(lastErr);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr || 'unknown Zen error');
}

async function qualifyLead(key, prompt, opts) {
  try {
    const raw = await zenComplete(key, prompt, opts.timeoutSec);
    const parsed = L.parseLeadOutput(raw);
    return { ok: true, parsed, raw, error: '' };
  } catch (err) {
    return { ok: false, parsed: null, raw: '', error: err.message };
  }
}

async function main() {
  const envFile = L.loadDotenv();
  if (envFile) console.log(`Loaded environment from ${envFile}`);

  const source = process.argv[2] || process.env.SHEET_URL || process.env.LEADS_FILE;
  if (!source) { console.error('Usage: node qualify_leads_zen.js <leads.json|leads.csv|google-sheet-url>  (or set SHEET_URL / LEADS_FILE)'); process.exit(2); }
  const key = process.env.OPENCODE_API_KEY;
  if (!key) { console.error('OPENCODE_API_KEY must be set (your OpenCode Zen key).'); process.exit(2); }

  const token = process.env.NOTION_TOKEN, dbId = process.env.NOTION_DB_ID;
  const notionEnabled = !!(token && dbId);
  const opts = { timeoutSec: Number(process.env.OPENCODE_TIMEOUT || 600) };
  const resultsDir = process.env.RESULTS_DIR || path.join(process.cwd(), 'results');
  const resume = !/^(0|false|no)$/i.test(process.env.RESUME || '1');

  await checkAuth(key);

  const { body: instructions, file: promptFile } = L.loadPromptFile();
  console.log(`Loaded qualification prompt from ${promptFile} (${instructions.length} chars).`);

  let rawRows = await L.loadLeads(source);
  if (rawRows.length === 0) { console.log('No leads to process.'); return; }
  console.log(`Loaded ${rawRows.length} lead(s) from ${L.isGoogleSheetUrl(source) ? 'Google Sheet' : source}.`);
  const limit = Number(process.env.LIMIT || 0);
  if (limit > 0 && rawRows.length > limit) { rawRows = rawRows.slice(0, limit); console.log(`LIMIT=${limit}: processing only the first ${limit} lead(s).`); }

  const schemaMap = notionEnabled ? await L.loadSchema(token, dbId) : null;
  console.log(notionEnabled ? 'Notion: enabled (writing pages + CSV).' : 'Notion: disabled (no NOTION_TOKEN/NOTION_DB_ID) — CSV only.');

  const files = L.makeResultFiles(resultsDir);
  const processed = resume ? L.readProcessedIds(Object.values(files)) : new Set();
  if (resume && processed.size) console.log(`Resume on: skipping ${processed.size} already-processed lead(s).`);
  console.log(`Results dir: ${resultsDir}`);

  const counts = { total: rawRows.length, qualified: 0, needs_review: 0, disqualified: 0, errors: 0, skipped: 0 };

  for (let i = 0; i < rawRows.length; i++) {
    const idx = i + 1;
    const row = rawRows[i];
    const id = L.leadId(row);

    if (resume && processed.has(id)) { counts.skipped++; console.log(`${idx}/${rawRows.length} (skip, already done) ${id}`); continue; }

    const lead = L.normalizeLead(row);
    const pass = L.passthroughFields(row);
    const source = L.sourceFields(row);
    const prompt = L.buildPrompt(lead, instructions);

    // Live progress line BEFORE the (30-90s) reasoning call, so a slow lead
    // never looks like a hang.
    process.stdout.write(`${idx}/${rawRows.length} qualifying ${lead.companyName || '<lead>'} … `);
    const t0 = Date.now();
    const { ok, parsed, raw, error } = await qualifyLead(key, prompt, opts);
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    if (!ok) {
      counts.errors++;
      console.log(`-> error (${error}) (${secs}s)`);
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, ...source, error });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    const status = parsed.qualification_status || '';
    const company = parsed.company_name || lead.companyName || '<no company>';

    let notionErr = '';
    if (notionEnabled) {
      try { await L.createPage(token, dbId, L.buildProperties(parsed, schemaMap)); }
      catch (err) { notionErr = err.message; }
    }
    if (notionErr) {
      counts.errors++;
      console.log(`-> error (notion: ${notionErr}) (${secs}s)`);
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, ...source, error: `notion: ${notionErr}` });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    const bucket = L.classifyStatus(status);
    L.appendCsvRow(files[bucket], L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, ...source, error: '' });
    const k = status.toLowerCase().replace(/\s+/g, '_');
    if (k === 'qualified') counts.qualified++;
    else if (k === 'needs_review') counts.needs_review++;
    else if (k === 'disqualified') counts.disqualified++;
    console.log(`-> ${status || '<no status>'} [${bucket}] (${secs}s)`);

    if (idx < rawRows.length) await sleep(1000);
  }

  console.log('---\nSummary:');
  console.log(`  total:        ${counts.total}`);
  console.log(`  qualified:    ${counts.qualified}`);
  console.log(`  needs_review: ${counts.needs_review}`);
  console.log(`  disqualified: ${counts.disqualified}`);
  console.log(`  errors:       ${counts.errors}`);
  console.log(`  skipped:      ${counts.skipped}`);
  console.log(`Results: ${files.qualified}`);
  console.log(`         ${files.review}`);
  console.log(`         ${files.errors}`);
}

main().catch((err) => { console.error(`Fatal: ${err.message}`); process.exit(1); });
