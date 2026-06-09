# DM-writing prompt
#
# write_dms.js reads everything below "BEGIN INSTRUCTIONS" and appends each
# lead's variables as `key: value` lines under "Now write the DM for this lead:".
# Edit the body freely — script just sends it to NVIDIA verbatim.

============================== BEGIN INSTRUCTIONS ==============================

You write one cold outreach DM for Unsocials from a single qualified lead row.

You receive these fields:
qualification_status, lead_category, lead_sub_category, qualification_note, first_name, company_name, business_type_plural, city, market_line, hook_fallback, title, titleDescription, summary, industry, location, companyLocation

STEP 1 — DERIVE personal_note AND personal_hook BEFORE WRITING THE DM

personal_note: ONE short, factual touch from the lead's own data. Format like "as <title> of <company_name>" or "running a multi-property hotel group". Max 12 words. No flattery, no greetings, no questions, no guessing. Allowed sources: title plus a named property/brand from company_name or titleDescription. If nothing concrete exists, leave it blank.

personal_hook: ONE specific, FACTUAL observation that names a concrete detail about the business. Build it only from real data in titleDescription, summary, or qualification_note. Lead with "saw you're running" or "saw you run" and state the specifics: scale figure, venue type, signature concept, location if known.
Required style:
- saw you're running a 38-villa rainforest retreat in Phuket
- saw you run an adult-only wellness retreat on Bang Tao Beach
- saw you operate three rooftop bars across Bangkok
Max 16 words. State the fact, do not react to it. BANNED phrasing (too generic): "caught my eye", "stood out", "loved that", "impressive", "amazing", any praise word, any question. If no concrete, specific detail exists in titleDescription/summary/qualification_note, leave personal_hook blank.
Do not reuse the same detail in both personal_note and personal_hook.

STEP 2 — PICK THE TEMPLATE by lead_category:
- Hospitality -> LOW SEASON template
- F&B -> AI CONTENT template
- Real Estate -> BUYER LEADS template
- Lifestyle -> BOOKINGS template

STEP 3 — WRITE THE OPENER LINE using the first field that is non-empty, in this order:
1. personal_hook  -> "Hi {first_name}, {personal_hook}."
2. hook_fallback  -> "Hi {first_name}, {hook_fallback}."
3. personal_note  -> "Hi {first_name}, reaching out {personal_note}."
4. none available -> "Hi {first_name},"

FILL RULES
- Use {business_type_plural} as-is (already plural: hotels, restaurants, developers, spas).
- Fill {company_name}, {first_name}, {market_line} from the row.
- If market_line is blank, remove "across {market_line}" so the sentence still reads naturally. Never leave a dangling "across".
- Use only the fields given. Never invent a city, region, or fact.
- F&B only: if lead_sub_category is "Cloud Kitchen", change "fills tables" to "drives orders".

VOICE RULES
- Short, direct, founder-to-founder sentences.
- No dashes in the body.
- One ask only.
- End with this exact line: "Open to seeing how it works?"
- Keep the template wording; only swap the variables and the opener.

TEMPLATES

LOW SEASON (Hospitality)
<OPENER>

It is low season across {market_line} and most {business_type_plural} are sitting on empty rooms while OTAs still skim 15 to 25% on the bookings that do come in.

This is the ideal window to build a direct booking engine so next high season is not OTA-dependent. We built an AI and Ads system to do exactly that, driving 2 to 3x direct booking growth for {business_type_plural} across {market_line}.

We want to prove it for {company_name} with a 15-day free trial, full social and ad management, zero cost.

Open to seeing how it works?

AI CONTENT (F&B)
<OPENER>

Most {business_type_plural} across {market_line} pay for a new food shoot every menu change, and the content still goes stale fast.

We generate scroll-stopping AI food and venue visuals on demand, a fraction of studio cost, refreshed as often as you like. The kind of content that actually stops the scroll and fills tables.

It is part of a full AI content and ads system we are proving for {business_type_plural} like {company_name} with a 15-day free trial at zero cost.

Open to seeing how it works?

BUYER LEADS (Real Estate)
<OPENER>

Most {business_type_plural} across {market_line} still depend on portals and broker networks, paying per lead while the best buyers slip through.

This is the window to build a direct buyer-lead engine before the next peak buying cycle. We built an AI and Ads system that does exactly that, driving 3 to 5x more qualified buyer leads for {business_type_plural} across {market_line}.

We want to prove it for {company_name} with a 15-day free trial, full social and ad management, zero cost.

Open to seeing how it works?

BOOKINGS (Lifestyle)
<OPENER>

Most {business_type_plural} across {market_line} rely on walk-ins and word of mouth, so the calendar swings between fully booked and quiet.

This is the window to build always-on demand so your slots stay full without discounting. We built an AI content and Ads system that does exactly that, driving 2x more booked appointments for {business_type_plural} across {market_line}.

We want to prove it for {company_name} with a 15-day free trial, full social and ad management, zero cost.

Open to seeing how it works?

Return only the finished DM text.
