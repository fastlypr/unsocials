'use strict';
/**
 * lib.js — shared logic for both qualifier runners (CLI + API).
 *
 * The two runners differ ONLY in how they get the model's text output for one
 * lead. Everything else — loading leads (file or Google Sheet), normalizing
 * sheet columns to the prompt's input fields, building the prompt, parsing the
 * model's `key: value` output, resume/dedup, and Notion writes — lives here so
 * both behave identically.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// .env loader (stdlib only)
// ---------------------------------------------------------------------------
function loadDotenv() {
  const candidates = [path.join(__dirname, '.env'), path.join(process.cwd(), '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const stripped = line.replace(/^export\s+/, '');
      const eq = stripped.indexOf('=');
      if (eq <= 0) continue;
      const key = stripped.slice(0, eq).trim();
      let val = stripped.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
    return file;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output keys / Notion property mapping (skill key -> Notion property name)
// ---------------------------------------------------------------------------
// Qualification-only output. DM-writing variables (business_type_plural,
// market_line, personal_note, personal_hook, hook_fallback) live in a separate
// downstream script that consumes qualified.csv.
const OUTPUT_KEYS = [
  'qualification_status', 'lead_category', 'lead_sub_category', 'qualification_note',
  'first_name', 'company_name', 'city',
];

const PROPERTY_MAP = {
  qualification_status:  'Status',
  lead_category:         'Category',
  lead_sub_category:     'Sub-category',
  qualification_note:    'Note',
  first_name:            'First Name',
  company_name:          'Company',
  city:                  'City',
};

// Presentation source columns shown up-front in the output CSV.
const PASSTHROUGH_KEYS = ['fullName', 'defaultProfileUrl', 'companyUrl'];

// Raw source columns kept verbatim so the downstream DM-writer script has
// everything it needs to generate personal_note / personal_hook / etc.
// Saved AFTER the AI-generated columns so the qualification view stays clean.
const DM_SOURCE_KEYS = ['title', 'titleDescription', 'summary', 'industry', 'location', 'companyLocation'];

// Final CSV column order: lead_id (resume key) | presentation passthrough |
// AI-generated qualification fields | raw DM-source fields | error.
const CSV_COLUMNS = ['lead_id', ...PASSTHROUGH_KEYS, ...OUTPUT_KEYS, ...DM_SOURCE_KEYS, 'error'];

// ---------------------------------------------------------------------------
// Field mapping: your sheet/CSV columns -> the prompt's declared input fields.
// First non-empty source wins. Targets with no source stay "" (= unknown).
// This is the SINGLE source of truth for how leads are fed to the model.
// ---------------------------------------------------------------------------
const FIELD_SOURCES = {
  firstName:                   ['firstName', 'first_name'],
  companyName:                 ['companyName', 'company_name'],
  linkedinHeadline:            ['linkedinHeadline', 'headline'],
  linkedinJobTitle:            ['linkedinJobTitle', 'title'],
  linkedinJobDescription:      ['linkedinJobDescription', 'titleDescription'],
  linkedinDescription:         ['linkedinDescription', 'summary'],
  companyIndustry:             ['companyIndustry', 'industry'],
  // titleDescription is often a venue/company blurb (e.g. "Sole Mio is an
  // upscale adult-only hotel..."), which is exactly what personal_hook needs.
  // Routed here too so the hook generator has concrete material to work with.
  linkedinCompanyDescription:  ['linkedinCompanyDescription', 'titleDescription'],
  linkedinCompanyTagline:      ['linkedinCompanyTagline'],
  linkedinCompanySpecialities: ['linkedinCompanySpecialities'],
  linkedinJobLocation:         ['linkedinJobLocation', 'location', 'companyLocation'],
  // NOTE: isOpenLink is the LinkedIn "OpenLink/Open Profile" premium feature,
  // NOT the "Open to Work" badge — intentionally not mapped here.
  linkedinIsOpenToWorkBadge:   ['linkedinIsOpenToWorkBadge'],
};

const _EMPTY = new Set(['', 'n/a', 'na', 'null', 'none', '-', 'undefined']);
function cleanVal(v) {
  if (v == null) return '';
  const s = String(v).trim();
  return _EMPTY.has(s.toLowerCase()) ? '' : s;
}

const _HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'mx']);
/** First given name only. Scrapers sometimes dump a full name or headline into
 *  the firstName column (e.g. "Toby Maguire"), which would otherwise leak into
 *  the DM's first_name variable. Drops leading honorifics. */
function firstNameOnly(s) {
  const clean = cleanVal(s);
  if (!clean) return '';
  const tokens = clean.replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  let t = tokens[0] || '';
  if (_HONORIFICS.has(t.toLowerCase()) && tokens[1]) t = tokens[1];
  return t;
}

function normalizeLead(row) {
  const lead = {};
  for (const [target, sources] of Object.entries(FIELD_SOURCES)) {
    let val = '';
    for (const s of sources) { val = cleanVal(row[s]); if (val) break; }
    lead[target] = val;
  }
  // Reduce firstName to a clean single given name (sources: firstName, then
  // fullName/name). Prevents "Toby Maguire - Business Coach" landing in the DM.
  lead.firstName = firstNameOnly(lead.firstName) || firstNameOnly(row.fullName) || firstNameOnly(row.name);
  return lead;
}

/** Source fields copied straight into the output CSV (not AI-generated).
 *  companyUrl prefers the public LinkedIn URL over the Sales-Navigator one. */
function passthroughFields(row) {
  return {
    fullName: cleanVal(row.fullName) || cleanVal(row.name),
    defaultProfileUrl: cleanVal(row.defaultProfileUrl),
    companyUrl: cleanVal(row.regularCompanyUrl) || cleanVal(row.companyUrl),
  };
}

/** Raw source columns saved for the downstream DM-writer script. Original
 *  sheet column names preserved (title, summary, industry, etc.) so the DM
 *  writer can either consume them directly or re-normalize via normalizeLead. */
function sourceFields(row) {
  const out = {};
  for (const key of DM_SOURCE_KEYS) out[key] = cleanVal(row[key]);
  return out;
}

/** Stable id for resume/dedup. Prefers a profile URL; falls back to vmid,
 *  name+company, then a hash of the whole row so it's always non-empty. */
function leadId(row) {
  const candidate =
    cleanVal(row.linkedInProfileUrl) || cleanVal(row.linkedinProfileUrl) ||
    cleanVal(row.profileUrl) || cleanVal(row.defaultProfileUrl) ||
    cleanVal(row.vmid);
  if (candidate) return candidate;
  const nameCo = (cleanVal(row.fullName) || cleanVal(row.name) || cleanVal(row.firstName)) +
                 '|' + cleanVal(row.companyName);
  if (nameCo !== '|') return nameCo;
  return 'hash:' + crypto.createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Lead loading: local file (.json/.csv) OR a public Google Sheet URL
// ---------------------------------------------------------------------------
function isGoogleSheetUrl(s) {
  return /^https?:\/\//i.test(s) && /docs\.google\.com\/spreadsheets|drive\.google\.com/i.test(s);
}

function sheetCsvUrl(url) {
  const idM = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idM) throw new Error(`Could not extract a sheet id from: ${url}`);
  const gidM = url.match(/[#&?]gid=([0-9]+)/);
  const gid = gidM ? gidM[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${idM[1]}/export?format=csv&gid=${gid}`;
}

async function loadLeads(source) {
  if (isGoogleSheetUrl(source)) {
    const csvUrl = sheetCsvUrl(source);
    const res = await fetch(csvUrl, { redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google Sheet fetch ${res.status}: ${text.slice(0, 200)}`);
    if (/^\s*<(?:!doctype|html)/i.test(text)) {
      throw new Error(
        'Google Sheet returned an HTML page, not CSV. The sheet must be shared as ' +
        '"Anyone with the link can view" (or Published to web).'
      );
    }
    return parseCsv(text);
  }
  const ext = path.extname(source).toLowerCase();
  const raw = fs.readFileSync(source, 'utf8');
  if (ext === '.json') {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error(`${source}: expected a JSON array of lead objects`);
    return data;
  }
  if (ext === '.csv') return parseCsv(raw);
  throw new Error(`Unsupported input "${source}" (use a .json file, .csv file, or a Google Sheet URL)`);
}

// ---------------------------------------------------------------------------
// CSV (RFC-4180-ish): parse + escape + append
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v && v.length > 0))
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? ''])));
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function ensureCsvHeader(filePath, columns) {
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
  fs.writeFileSync(filePath, columns.join(',') + '\n', 'utf8');
}

function appendCsvRow(filePath, columns, obj) {
  fs.appendFileSync(filePath, columns.map((c) => csvEscape(obj[c])).join(',') + '\n', 'utf8');
}

/** Resume support: lead_ids already written successfully (empty error column).
 *  Accepts one path or an array of paths (union). Errored rows are excluded,
 *  so they get retried on the next run. */
function readProcessedIds(filePaths) {
  const done = new Set();
  for (const filePath of [].concat(filePaths)) {
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0) continue;
    for (const row of parseCsv(fs.readFileSync(filePath, 'utf8'))) {
      const id = (row.lead_id || '').trim();
      const err = (row.error || '').trim();
      if (id && !err) done.add(id);
    }
  }
  return done;
}

/** If an existing CSV has an out-of-date header, rewrite it to the current
 *  column layout, re-mapping each row by name (new columns become empty).
 *  Non-destructive: preserves all existing values + resume data. Lets the
 *  schema evolve without deleting results. */
function migrateCsvHeader(filePath, columns) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const nl = text.indexOf('\n');
  const headerLine = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
  const wanted = columns.join(',');
  if (headerLine === wanted) return; // already current
  const rows = parseCsv(text); // keyed by the OLD header
  const out = [wanted];
  for (const r of rows) out.push(columns.map((c) => csvEscape(r[c] !== undefined ? r[c] : '')).join(','));
  fs.writeFileSync(filePath, out.join('\n') + '\n', 'utf8');
  console.log(`Migrated ${path.basename(filePath)} to current columns (${rows.length} rows preserved).`);
}

/** Create the results/ folder and the three output CSVs (with headers).
 *  Returns { qualified, review, errors } absolute paths. */
function makeResultFiles(resultsDir) {
  fs.mkdirSync(resultsDir, { recursive: true });
  const files = {
    qualified: path.join(resultsDir, 'qualified.csv'),
    review:    path.join(resultsDir, 'disqualified_needs_review.csv'),
    errors:    path.join(resultsDir, 'errors.csv'),
  };
  for (const f of Object.values(files)) { migrateCsvHeader(f, CSV_COLUMNS); ensureCsvHeader(f, CSV_COLUMNS); }
  return files;
}

/** Which result bucket a status belongs to: 'qualified' vs 'review'
 *  (disqualified + needs_review + any unexpected value). */
function classifyStatus(status) {
  const key = (status || '').toLowerCase().replace(/\s+/g, '_');
  return key === 'qualified' ? 'qualified' : 'review';
}

// ---------------------------------------------------------------------------
// Prompt assembly + output parsing
// ---------------------------------------------------------------------------
function loadPromptFile() {
  const candidates = [path.join(__dirname, 'prompt.md'), path.join(process.cwd(), 'prompt.md')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/=+\s*BEGIN INSTRUCTIONS\s*=+/i);
    const body = (m ? raw.slice(m.index + m[0].length) : raw).trim();
    if (!body) throw new Error(`${file} has no instructions below the BEGIN INSTRUCTIONS marker.`);
    if (body.includes('<<< PASTE YOUR QUALIFICATION PROMPT HERE >>>')) {
      throw new Error(`${file} still has the placeholder. Paste your qualification logic into it first.`);
    }
    return { body, file };
  }
  throw new Error('prompt.md not found next to the script or in the current directory.');
}

/** Render the normalized lead as `key: value` lines (only non-empty fields),
 *  matching the prompt's own example style. */
function formatLeadBlock(lead) {
  return Object.entries(lead).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

// Locked output contract appended to every prompt. The prompt.md body no longer
// defines an output format (it defers to this), so this is the single source of
// truth for the response shape. Must stay in sync with OUTPUT_KEYS + the parser.
const OUTPUT_SPEC = `OUTPUT CONTRACT — return ONLY key: value lines, one per line. No markdown, no code fences, no commentary, nothing before or after.

qualification_status must be exactly one of: Qualified, Needs Review, Disqualified.

If Disqualified, return ONLY these 4 lines:
qualification_status: <value>
lead_category: <value>
lead_sub_category: <value>
qualification_note: <value>

If Qualified or Needs Review, return ONLY these 7 lines:
qualification_status: <value>
lead_category: <value>
lead_sub_category: <value>
qualification_note: <value>
first_name: <value>
company_name: <value>
city: <value>

When the instructions say a field is blank, leave it truly empty after the colon (e.g. "city:"). Do not write "(blank)", "none", or "N/A".`;

/** Build the full prompt: instructions + lead row + the locked output contract.
 *  Fills a [PASTE ONE LEAD ROW HERE] placeholder if present, else appends. */
function buildPrompt(lead, instructions) {
  const block = formatLeadBlock(lead) || '(no usable fields in this lead)';
  const body = instructions.includes('[PASTE ONE LEAD ROW HERE]')
    ? instructions.replace('[PASTE ONE LEAD ROW HERE]', block)
    : `${instructions}\n\nNow qualify this lead row:\n${block}`;
  return `${body}\n\n${OUTPUT_SPEC}`;
}

/** Parse the model's `key: value` line output into an object of OUTPUT_KEYS.
 *  Tolerates ANSI noise, code fences, leading bullets, <angle> placeholders,
 *  and a JSON object as a fallback. Throws if qualification_status is absent. */
function parseLeadOutput(text) {
  if (!text || !text.trim()) throw new Error('empty model output');
  const noAnsi = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

  // JSON fallback first, in case a model returns JSON despite the line spec.
  const trimmed = noAnsi.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data && typeof data === 'object' && data.qualification_status) {
        const out = {};
        for (const k of OUTPUT_KEYS) if (k in data && data[k] != null) out[k] = String(data[k]).trim();
        if (out.qualification_status) return out;
      }
    } catch { /* fall through to line parsing */ }
  }

  const out = {};
  for (const rawLine of noAnsi.split('\n')) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    const m = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!OUTPUT_KEYS.includes(key)) continue;
    let val = m[2].trim().replace(/^<(.*)>$/, '$1').trim();
    // Treat blank/placeholder markers as empty: blank, (blank), (empty), none, n/a, null, -
    if (/^\(?\s*(blank|empty|none|null|n\/?a|-)\s*\)?$/i.test(val)) val = '';
    out[key] = val;
  }
  if (!out.qualification_status) throw new Error('no qualification_status found in model output');
  return out;
}

// ---------------------------------------------------------------------------
// Notion (stdlib fetch, Node 18+)
// ---------------------------------------------------------------------------
const NOTION_API_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

async function notionRequest(method, urlPath, token, body) {
  const res = await fetch(`${NOTION_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

/** Discover each mapped property's real Notion type from the DB schema. */
async function loadSchema(token, dbId) {
  const db = await notionRequest('GET', `/databases/${dbId}`, token);
  const props = db.properties || {};
  const map = {};
  const missing = [];
  for (const [skillKey, propName] of Object.entries(PROPERTY_MAP)) {
    const prop = props[propName];
    if (!prop) { missing.push(propName); continue; }
    map[skillKey] = { name: propName, type: prop.type };
  }
  if (missing.length) console.warn(`WARN: Notion properties not found (will be skipped): ${missing.join(', ')}`);
  return map;
}

function formatProperty(value, type) {
  switch (type) {
    case 'title':        return { title: [{ type: 'text', text: { content: value } }] };
    case 'rich_text':    return { rich_text: [{ type: 'text', text: { content: value } }] };
    case 'select':       return { select: { name: value } };
    case 'status':       return { status: { name: value } };
    case 'multi_select': return { multi_select: value.split(',').map((s) => ({ name: s.trim() })).filter((o) => o.name) };
    case 'url':          return { url: value };
    case 'email':        return { email: value };
    case 'phone_number': return { phone_number: value };
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? { number: n } : { rich_text: [{ type: 'text', text: { content: value } }] };
    }
    case 'checkbox':     return { checkbox: /^(true|yes|1)$/i.test(value) };
    default:             return { rich_text: [{ type: 'text', text: { content: value } }] };
  }
}

function buildProperties(result, schemaMap) {
  const payload = {};
  for (const [skillKey, { name, type }] of Object.entries(schemaMap)) {
    if (!(skillKey in result)) continue;
    const value = result[skillKey];
    if (value == null) continue;
    const str = String(value).trim();
    if (str === '') continue;
    payload[name] = formatProperty(str, type);
  }
  return payload;
}

async function createPage(token, dbId, properties) {
  return notionRequest('POST', '/pages', token, { parent: { database_id: dbId }, properties });
}

module.exports = {
  loadDotenv,
  OUTPUT_KEYS, PROPERTY_MAP, CSV_COLUMNS, PASSTHROUGH_KEYS, DM_SOURCE_KEYS,
  normalizeLead, leadId, passthroughFields, sourceFields, loadLeads, isGoogleSheetUrl,
  parseCsv, csvEscape, ensureCsvHeader, appendCsvRow, readProcessedIds,
  makeResultFiles, classifyStatus,
  loadPromptFile, buildPrompt, parseLeadOutput,
  loadSchema, buildProperties, createPage,
};
