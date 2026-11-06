-- Up to 4 photos per vehicle plus an optional illustration. photo_url stays the icon/cover the app
-- and the dossier show: one of the photos, or the illustration.
alter table public.vehicles add column if not exists photos text[] not null default '{}';
alter table public.vehicles add column if not exists illus_url text;
alter table public.vehicles drop constraint if exists vehicles_photos_max;
alter table public.vehicles add constraint vehicles_photos_max check (cardinality(photos) <= 4);
-- existing vehicles: an illustration (its original photo was replaced) or one photo
update public.vehicles set illus_url = photo_url where photo_url ~ '/illus/' and illus_url is null;
update public.vehicles set photos = array[photo_url] where photo_url is not null and photo_url !~ '/illus/' and cardinality(photos) = 0;
