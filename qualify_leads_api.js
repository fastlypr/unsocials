#!/usr/bin/env node
/**
 * qualify_leads_api.js — API runner. Qualifies Unsocials leads via the OpenCode
 * HTTP server (`opencode serve`), writes one Notion page + one CSV row per lead.
 * Shared logic lives in lib.js.
 *
 * Start the server first (separate terminal, same host):
 *   opencode serve
 *
 * Usage:
 *   node qualify_leads_api.js leads.json
 *   node qualify_leads_api.js "https://docs.google.com/spreadsheets/d/XXXX/edit#gid=0"
 *   SHEET_URL=... node qualify_leads_api.js          # or LEADS_FILE=...
 *
 * Env (see .env.example): NOTION_TOKEN, NOTION_DB_ID, OPENCODE_HOST,
 *   OPENCODE_PORT, OPENCODE_USER, OPENCODE_PASSWORD, OPENCODE_MODEL,
 *   OPENCODE_AGENT, OPENCODE_TIMEOUT, RESULTS_CSV, RESUME.
 */
'use strict';

const path = require('node:path');
const L = require('./lib');

function baseUrl() {
  return `http://${process.env.OPENCODE_HOST || '127.0.0.1'}:${process.env.OPENCODE_PORT || '4096'}`;
}
function authHeader() {
  const pass = process.env.OPENCODE_PASSWORD;
  if (!pass) return {};
  const user = process.env.OPENCODE_USER || 'opencode';
  return { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}
async function ocRequest(method, urlPath, body, signal) {
  const res = await fetch(`${baseUrl()}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode ${method} ${urlPath} ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
async function checkHealth() {
  try {
    const data = await ocRequest('GET', '/global/health');
    if (data && data.healthy) { console.log(`OpenCode server reachable at ${baseUrl()} (version ${data.version || 'unknown'}).`); return; }
    throw new Error(`unexpected health payload: ${JSON.stringify(data)}`);
  } catch (err) {
    throw new Error(
      `Cannot reach OpenCode server at ${baseUrl()}: ${err.message}\n` +
      `  Start it in another terminal:  opencode serve\n` +
      `  Or set OPENCODE_HOST / OPENCODE_PORT in .env.`
    );
  }
}
function parseModel(envValue) {
  if (!envValue) return undefined;
  const slash = envValue.indexOf('/');
  if (slash <= 0) return undefined;
  return { providerID: envValue.slice(0, slash), modelID: envValue.slice(slash + 1) };
}

/** Qualify one lead over HTTP. Fresh session per lead (no context bleed).
 *  Returns { ok, parsed, raw, error }. */
async function qualifyLead(prompt, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutSec * 1000);
  try {
    const session = await ocRequest('POST', '/session', { title: 'lead qualification' }, controller.signal);
    if (!session.id) throw new Error(`session create returned no id: ${JSON.stringify(session)}`);

    const body = { parts: [{ type: 'text', content: prompt }] };
    const model = parseModel(opts.model);
    if (model) body.model = model;
    if (opts.agent) body.agent = opts.agent;

    const reply = await ocRequest('POST', `/session/${session.id}/message`, body, controller.signal);
    const raw = (reply?.parts || [])
      .filter((p) => p && p.type === 'text')
      .map((p) => p.content || p.text || '')
      .join('\n');

    ocRequest('DELETE', `/session/${session.id}`).catch(() => {}); // best-effort cleanup

    const parsed = L.parseLeadOutput(raw);
    return { ok: true, parsed, raw, error: '' };
  } catch (err) {
    return { ok: false, parsed: null, raw: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const envFile = L.loadDotenv();
  if (envFile) console.log(`Loaded environment from ${envFile}`);

  const source = process.argv[2] || process.env.SHEET_URL || process.env.LEADS_FILE;
  if (!source) { console.error('Usage: node qualify_leads_api.js <leads.json|leads.csv|google-sheet-url>  (or set SHEET_URL / LEADS_FILE)'); process.exit(2); }
  const token = process.env.NOTION_TOKEN, dbId = process.env.NOTION_DB_ID;
  const notionEnabled = !!(token && dbId);

  const opts = {
    model: process.env.OPENCODE_MODEL || '',
    agent: process.env.OPENCODE_AGENT || '',
    timeoutSec: Number(process.env.OPENCODE_TIMEOUT || 600),
  };
  const resultsDir = process.env.RESULTS_DIR || path.join(process.cwd(), 'results');
  const resume = !/^(0|false|no)$/i.test(process.env.RESUME || '1');

  await checkHealth();

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

    const { ok, parsed, raw, error } = await qualifyLead(prompt, opts);
    if (!ok) {
      counts.errors++;
      console.error(`${idx}/${rawRows.length} <unknown> -> error (${error})`);
      if (raw) console.error('  --- raw opencode response ---\n' + raw + '\n  --- end raw ---');
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, ...source, error });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    const status = parsed.qualification_status || '';
    const company = parsed.company_name || lead.companyName || '<no company>';

    // Optional Notion write. On failure, route to errors.csv so it retries.
    let notionErr = '';
    if (notionEnabled) {
      try { await L.createPage(token, dbId, L.buildProperties(parsed, schemaMap)); }
      catch (err) { notionErr = err.message; }
    }
    if (notionErr) {
      counts.errors++;
      console.error(`${idx}/${rawRows.length} ${company} -> error (notion: ${notionErr})`);
      L.appendCsvRow(files.errors, L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, ...source, error: `notion: ${notionErr}` });
      if (idx < rawRows.length) await sleep(1000);
      continue;
    }

    // Success: route to the qualified vs disqualified/needs_review bucket.
    const bucket = L.classifyStatus(status);
    L.appendCsvRow(files[bucket], L.CSV_COLUMNS, { lead_id: id, ...pass, ...parsed, ...source, error: '' });
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
