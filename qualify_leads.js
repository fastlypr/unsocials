#!/usr/bin/env node
/**
 * qualify_leads.js — CLI runner. Qualifies Unsocials leads via the `opencode`
 * CLI (one `opencode run` per lead), writes one Notion page + one CSV row per
 * lead. Shared logic lives in lib.js.
 *
 * Usage:
 *   node qualify_leads.js leads.json
 *   node qualify_leads.js leads.csv
 *   node qualify_leads.js "https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0"
 *   SHEET_URL=... node qualify_leads.js          # or LEADS_FILE=...
 *
 * Env (see .env.example): NOTION_TOKEN, NOTION_DB_ID, OPENCODE_MODEL,
 *   OPENCODE_AGENT, OPENCODE_TIMEOUT, RESULTS_CSV, RESUME.
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const L = require('./lib');

function runOpenCode(prompt, opts) {
  return new Promise((resolve) => {
    const args = ['run'];
    if (opts.model) args.push('-m', opts.model);
    if (opts.agent) args.push('--agent', opts.agent);
    args.push(prompt);

    const child = spawn('opencode', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, stdout, error: `timed out after ${opts.timeoutSec}s` }); }, opts.timeoutSec * 1000);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, stdout, error: `spawn failed: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, stdout, error: '' });
      resolve({ ok: false, stdout, error: `exit ${code}: ${(stderr || stdout || '').trim().slice(0, 300)}` });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const envFile = L.loadDotenv();
  if (envFile) console.log(`Loaded environment from ${envFile}`);

  const source = process.argv[2] || process.env.SHEET_URL || process.env.LEADS_FILE;
  if (!source) { console.error('Usage: node qualify_leads.js <leads.json|leads.csv|google-sheet-url>  (or set SHEET_URL / LEADS_FILE)'); process.exit(2); }
  const token = process.env.NOTION_TOKEN, dbId = process.env.NOTION_DB_ID;
  const notionEnabled = !!(token && dbId);

  const opts = {
    model: process.env.OPENCODE_MODEL || '',
    agent: process.env.OPENCODE_AGENT || '',
    timeoutSec: Number(process.env.OPENCODE_TIMEOUT || 600),
  };
  const resultsDir = process.env.RESULTS_DIR || path.join(process.cwd(), 'results');
  const resume = !/^(0|false|no)$/i.test(process.env.RESUME || '1');

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
    const prompt = L.buildPrompt(lead, instructions);

    const { ok, stdout, error } = await runOpenCode(prompt, opts);
    if (!ok) {
      counts.errors++;
      console.error(`${idx}/${rawRows.length} <unknown> -> error (opencode: ${error})`);
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, error: `opencode: ${error}` });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    let parsed;
    try { parsed = L.parseLeadOutput(stdout); }
    catch (err) {
      counts.errors++;
      console.error(`${idx}/${rawRows.length} <unknown> -> error (parse: ${err.message})`);
      console.error('  --- raw opencode stdout ---\n' + stdout + '\n  --- end raw ---');
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, error: `parse: ${err.message}` });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    const status = parsed.qualification_status || '';
    const company = parsed.company_name || lead.companyName || '<no company>';

    // Optional Notion write. On failure, route the lead to errors.csv so it
    // retries on resume (don't pollute the clean result buckets).
    let notionErr = '';
    if (notionEnabled) {
      try { await L.createPage(token, dbId, L.buildProperties(parsed, schemaMap)); }
      catch (err) { notionErr = err.message; }
    }
    if (notionErr) {
      counts.errors++;
      console.error(`${idx}/${rawRows.length} ${company} -> error (notion: ${notionErr})`);
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, error: `notion: ${notionErr}` });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    // Success: route to the qualified vs disqualified/needs_review bucket.
    const bucket = L.classifyStatus(status);
    L.appendCsvRow(files[bucket], L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, error: '' });
    const key = status.toLowerCase().replace(/\s+/g, '_');
    if (key === 'qualified') counts.qualified++;
    else if (key === 'needs_review') counts.needs_review++;
    else if (key === 'disqualified') counts.disqualified++;
    console.log(`${idx}/${rawRows.length} ${company} -> ${status || '<no status>'} [${bucket}]`);

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
