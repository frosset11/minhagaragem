# My Garage

A private garage for car and motorcycle owners: vehicles, service history, odometer readings, a service To-Do, market value like an investment portfolio, invoice scanning and spreadsheet import. Anyone can sign up; each garage is private to the people its owner invites.

- **App:** `index.html` (single static page) on Vercel, with `/sb`, `/fx` and `/fipe` rewrites in `vercel.json`.
- **Database:** Supabase. `supabase/migrations/` holds the schema (0003 adds each garage's logo, background colour and motorcycles switch); every table carries `garage_id` and row-level security checks membership (`owner`, `editor`, `viewer`).
- **AI:** `supabase/functions/scan-invoice` and `import-sheet` call Claude with the platform's `ANTHROPIC_API_KEY` secret, capped per garage per month (`_shared/ai.ts`, `LIMITS`) and logged in `usage_events`.
