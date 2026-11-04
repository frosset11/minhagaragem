-- Per-garage look: the owner's logo, background colour, and whether motorcycles have their own tab.
alter table public.garages
  add column logo_url text,
  add column bg_color text check (bg_color ~ '^#[0-9a-f]{6}$'),
  add column show_bikes boolean not null default true;
