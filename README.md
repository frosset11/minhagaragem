# My Garage

A private garage for car and motorcycle owners: vehicles, service history, odometer readings, a service To-Do, market value like an investment portfolio, invoice scanning and spreadsheet import. Anyone can sign up; each garage is private to the people its owner invites.

- **App:** `index.html` (single static page) on Vercel, with `/sb`, `/fx` and `/fipe` rewrites in `vercel.json`.
- **Database:** Supabase. `supabase/migrations/` holds the schema (0003 adds each garage's logo, background colour and motorcycles switch); every table carries `garage_id` and row-level security checks membership (`owner`, `editor`, `viewer`).
- **AI:** `supabase/functions/scan-invoice` and `import-sheet` call Claude with the platform's `ANTHROPIC_API_KEY` secret, capped per garage per month (`_shared/ai.ts`, `LIMITS`) and logged in `usage_events`.

## Allowances (until online payment exists)
Each garage holds 5 active vehicles (sold ones don't count) and each account owns 1 garage. Extra places are US$1 per vehicle and US$20 per garage, one-time. After a customer pays, run in the Supabase SQL editor:

```sql
select private.add_vehicle_slots('<garage id>', 5);        -- returns the new vehicle limit
select private.add_garage_slots('customer@email.com', 1);   -- returns the new garage limit
```
Find a garage id with `select id, name from garages where name ilike '%rosset%';`.
