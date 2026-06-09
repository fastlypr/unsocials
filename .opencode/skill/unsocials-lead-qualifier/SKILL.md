---
name: unsocials-lead-qualifier
description: Qualify a single Unsocials lead row. Decide whether it is qualified, needs_review, or disqualified; classify the lead into a category and sub-category; and for non-disqualified leads also produce a first_name, company_name, business_type_plural, city, market_line, personal_note, and personal_hook. Use this skill whenever the user provides a lead row (JSON object or similar) and asks to qualify, score, classify, or enrich an Unsocials lead, or to decide if a lead is worth contacting. Process one lead per invocation and return strict JSON only.
---

# Unsocials Lead Qualifier

Qualify ONE Unsocials lead row at a time and return a single strict-JSON object.

## Input

The user provides one lead row — usually a JSON object with fields like company name, website, location, industry, headcount, contact info, social handles, etc. The exact fields vary. Use whatever is present; do not invent values that aren't there.

If the user provides multiple leads, qualify only the first one and stop. Never batch.

## Workflow

<<< PASTE YOUR QUALIFICATION PROMPT / LOGIC HERE >>>

Replace this block with the full qualification logic you want the skill to run:
  - The ICP definition (who counts as qualified vs. needs_review vs. disqualified)
  - Category and sub-category taxonomy (the exact allowed values)
  - Any web research / verification steps the skill should perform
  - Rules for writing the market_line, personal_note, and personal_hook
  - Anything else that defines a good qualification

Keep the rest of this file (Output section, Anti-hallucination rules) as-is — the
Node runner depends on the exact JSON shape below.

## Output — strict JSON, single object, no commentary

Return ONLY the JSON object below as your entire final message. No markdown
fences. No "Here is". No reasoning text. One line is fine; pretty-printed is
also fine. Nothing before or after the `{` … `}`.

### If the lead is disqualified

Return EXACTLY these four keys and nothing else:

```json
{
  "qualification_status": "disqualified",
  "lead_category": "",
  "lead_sub_category": "",
  "qualification_note": ""
}
```

`qualification_note` must briefly state the disqualifying reason in your own
words. `lead_category` and `lead_sub_category` may be empty strings or filled,
your choice — but no other keys.

### If the lead is qualified or needs_review

Return EXACTLY these eleven keys:

```json
{
  "qualification_status": "qualified",
  "lead_category": "",
  "lead_sub_category": "",
  "qualification_note": "",
  "first_name": "",
  "company_name": "",
  "business_type_plural": "",
  "city": "",
  "market_line": "",
  "personal_note": "",
  "personal_hook": ""
}
```

`qualification_status` must be exactly one of: `qualified`, `needs_review`,
`disqualified`. Lowercase, underscore-separated, no other values.

`business_type_plural` is the lead's business type expressed as a plural noun
phrase (e.g. "dental clinics", "real estate brokerages", "boutique gyms"). It
is used inside outreach copy as "…other {business_type_plural} in {city}…", so
it must read naturally in that sentence.

`market_line`, `personal_note`, and `personal_hook` are short, human-sounding
strings ready to drop into an outreach message verbatim. The Node runner will
write them to Notion exactly as you produce them — do not wrap them in quotes
or add prefixes.

## Anti-hallucination rules

1. If a field cannot be filled honestly from the input or from verified
   research, use an empty string `""`. Never invent a city, name, or company.
2. Never output any text outside the JSON object. No leading "Here is the
   qualification:", no trailing notes, no markdown fences.
3. Status, category, and sub-category values must come from the taxonomy in
   the Workflow section. If the lead doesn't cleanly fit, prefer
   `needs_review` over forcing a category.
4. Preserve exact wording: once you write `personal_note` and `personal_hook`,
   do not rephrase them between drafts. The runner copies them verbatim into
   Notion and into downstream outreach.
