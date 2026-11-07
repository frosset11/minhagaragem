-- Manual or automatic, chosen on the vehicle (also sent to the spec lookup so the right version's figures come back)
alter table public.vehicles add column if not exists gearbox text check (gearbox in ('manual', 'automatic'));
-- fill it in where the transmission text already says which
update public.vehicles set gearbox = case
  when transmission ~* '(manual|manuel|mec[aâ]nic|stick|\mmt\M|\mmec\.?)' then 'manual'
  when transmission ~* '(auto|dct|dsg|pdk|cvt|dual.?clutch|tiptronic|steptronic|smg|sequential|semi)' then 'automatic' end
where gearbox is null and transmission is not null;
