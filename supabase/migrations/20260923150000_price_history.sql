-- Отслеживание изменений цен: ежедневный прогон сравнивает свежие цены с базой,
-- пишет каждое изменение в историю и помечает товар (предыдущая цена + дата изменения).

set search_path = ekt, public, extensions;

alter table ekt.products
  add column if not exists price_site_prev  numeric(14, 2),
  add column if not exists price_store_prev numeric(14, 2),
  add column if not exists price_changed_at timestamptz;

create table if not exists ekt.price_history (
  id               bigserial primary key,
  product_id       bigint not null references ekt.products (id) on delete cascade,
  run_id           bigint references ekt.scrape_runs (id) on delete set null,
  price_site_old   numeric(14, 2),
  price_site_new   numeric(14, 2),
  price_store_old  numeric(14, 2),
  price_store_new  numeric(14, 2),
  changed_at       timestamptz not null default now()
);
create index if not exists price_history_product_idx on ekt.price_history (product_id, changed_at desc);
create index if not exists price_history_changed_idx on ekt.price_history (changed_at desc);

alter table ekt.price_history enable row level security;
revoke all on ekt.price_history from anon, authenticated;
grant all on ekt.price_history to service_role;
grant all on sequence ekt.price_history_id_seq to service_role;
