-- EKT AI-консультант: схема данных каталога, базы знаний, чатов и заявок.
-- Все таблицы закрыты RLS без политик для anon/authenticated: доступ только через
-- Edge Function (service role) и Supabase Studio.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- Каталог
-- ---------------------------------------------------------------------------

create table public.categories (
  url         text primary key,                 -- https://ekt.kz/catalog/.../
  name        text not null,
  parent_url  text references public.categories (url) on delete set null deferrable initially deferred,
  path        text[] not null default '{}',     -- названия от корня: {Светильники / Лампы, Лампы}
  depth       int not null default 0,
  product_count int not null default 0,
  updated_at  timestamptz not null default now()
);
create index categories_parent_idx on public.categories (parent_url);

create table public.products (
  id             bigint primary key,            -- Bitrix ID (data-id кнопки «Купить»)
  sku            text,                          -- «Артикул»
  supplier_sku   text,                          -- «Артикул поставщика»
  name           text not null,
  url            text not null unique,
  category_url   text references public.categories (url) on delete set null,
  category_path  text[] not null default '{}',
  brand          text,                          -- «Торговая марка»
  price_site     numeric(14, 2),                -- «Цена на сайте», ₸
  price_store    numeric(14, 2),                -- «Цена в магазине», ₸
  currency       text not null default 'KZT',
  city           text not null default 'almaty',
  multiplicity   numeric(12, 3) not null default 1,  -- кратность заказа
  is_new         boolean not null default false,
  image_url      text,
  description    text,
  attrs          jsonb not null default '{}'::jsonb, -- {"Мощность": "10", "Тип цоколя": "E27", ...}
  search_text    text not null default '',
  fts            tsvector generated always as (to_tsvector('russian', search_text)) stored,
  embedding      extensions.vector(1536),
  content_hash   text not null,
  embedded_hash  text,
  is_active      boolean not null default true,
  scraped_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index products_fts_idx       on public.products using gin (fts);
create index products_name_trgm_idx on public.products using gin (lower(name) extensions.gin_trgm_ops);
create index products_sku_idx       on public.products (lower(sku));
create index products_supplier_sku_idx on public.products (lower(supplier_sku));
create index products_attrs_idx     on public.products using gin (attrs jsonb_path_ops);
create index products_brand_idx     on public.products (lower(brand));
create index products_category_idx  on public.products (category_url);
create index products_price_idx     on public.products (price_site);
create index products_embedding_idx on public.products
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- База знаний (FAQ, условия, о компании, статьи, новости)
-- ---------------------------------------------------------------------------

create table public.pages (
  id           bigserial primary key,
  url          text not null unique,
  kind         text not null,   -- faq|howto|payment|return|contacts|about|production|article|tech|news|other
  title        text not null,
  content      text not null,
  content_hash text not null,
  scraped_at   timestamptz not null default now()
);

create table public.page_chunks (
  id            bigserial primary key,
  page_id       bigint not null references public.pages (id) on delete cascade,
  chunk_index   int not null,
  heading       text,
  content       text not null,
  fts           tsvector generated always as
                  (to_tsvector('russian', coalesce(heading, '') || ' ' || content)) stored,
  embedding     extensions.vector(1536),
  content_hash  text not null,
  unique (page_id, chunk_index)
);
create index page_chunks_fts_idx on public.page_chunks using gin (fts);
create index page_chunks_embedding_idx on public.page_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

create table public.branches (
  city_slug  text primary key,       -- almaty, astana, ...
  city       text not null,          -- Алматы
  address    text,
  phones     text[] not null default '{}',
  emails     text[] not null default '{}',
  hours      text,
  sort       int not null default 100,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Диалоги, заявки, обратная связь, журнал обновлений
-- ---------------------------------------------------------------------------

create table public.chat_sessions (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  page_url      text,
  city          text,
  user_agent    text,
  ip_hash       text,
  message_count int not null default 0
);

create table public.chat_messages (
  id           bigserial primary key,
  session_id   uuid not null references public.chat_sessions (id) on delete cascade,
  role         text not null check (role in ('user', 'assistant')),
  content      text not null,
  tool_calls   jsonb,               -- [{name, arguments}]
  tool_results jsonb,               -- компактные результаты для аудита
  model        text,
  tokens_in    int,
  tokens_out   int,
  latency_ms   int,
  flags        jsonb not null default '{}'::jsonb, -- unknown_urls, price_mismatch, error ...
  ip_hash      text,
  created_at   timestamptz not null default now()
);
create index chat_messages_session_idx on public.chat_messages (session_id, created_at);
create index chat_messages_ip_idx on public.chat_messages (ip_hash, created_at);

create table public.leads (
  id          bigserial primary key,
  session_id  uuid references public.chat_sessions (id) on delete set null,
  name        text,
  phone       text not null,
  email       text,
  city        text,
  request     text not null,
  products    jsonb not null default '[]'::jsonb,
  status      text not null default 'new' check (status in ('new', 'in_progress', 'done', 'spam')),
  created_at  timestamptz not null default now()
);
create index leads_status_idx on public.leads (status, created_at desc);

create table public.feedback (
  id          bigserial primary key,
  message_id  bigint references public.chat_messages (id) on delete cascade,
  session_id  uuid references public.chat_sessions (id) on delete cascade,
  rating      smallint not null check (rating in (-1, 1)),
  comment     text,
  created_at  timestamptz not null default now(),
  unique (message_id)
);

create table public.scrape_runs (
  id          bigserial primary key,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  stats       jsonb not null default '{}'::jsonb,
  error       text
);

alter table public.categories    enable row level security;
alter table public.products      enable row level security;
alter table public.pages         enable row level security;
alter table public.page_chunks   enable row level security;
alter table public.branches      enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.leads         enable row level security;
alter table public.feedback      enable row level security;
alter table public.scrape_runs   enable row level security;

-- ---------------------------------------------------------------------------
-- Поиск
-- ---------------------------------------------------------------------------

-- Гибридный поиск товаров: артикул → полнотекст → триграммы → вектор, слияние RRF.
-- Фильтры применяются до ранжирования. attrs: {"Тип цоколя": "E27"} — регистронезависимое
-- совпадение значения (подстрока), чтобы «10» находило «10», а «e27» — «E27».
create or replace function public.search_products(
  q            text,
  q_embedding  extensions.vector(1536) default null,
  p_brand      text default null,
  p_category   text default null,      -- часть названия категории или URL
  p_price_min  numeric default null,
  p_price_max  numeric default null,
  p_attrs      jsonb default null,
  p_limit      int default 10
)
returns table (
  id bigint, sku text, name text, url text, brand text, category_path text[],
  price_site numeric, price_store numeric, multiplicity numeric, image_url text,
  attrs jsonb, score double precision
)
language sql stable
set search_path = public, extensions
as $$
  with filtered as (
    select p.*
    from products p
    where p.is_active
      and (p_brand is null or lower(p.brand) = lower(p_brand))
      and (p_category is null
           or p.category_url ilike '%' || p_category || '%'
           or array_to_string(p.category_path, ' / ') ilike '%' || p_category || '%')
      and (p_price_min is null or p.price_site >= p_price_min)
      and (p_price_max is null or p.price_site <= p_price_max)
      and (p_attrs is null or not exists (
            select 1 from jsonb_each_text(p_attrs) f
            where coalesce(p.attrs ->> f.key, '') not ilike '%' || f.value || '%'))
  ),
  qn as (select nullif(trim(coalesce(q, '')), '') as q,
                websearch_to_tsquery('russian', coalesce(q, '')) as tsq),
  by_sku as (
    select f.id, row_number() over () as r
    from filtered f, qn
    where qn.q is not null
      and (lower(f.sku) = lower(qn.q) or lower(f.supplier_sku) = lower(qn.q)
           or lower(f.sku) = lower(qn.q) || '_')
    limit 5
  ),
  by_fts as (
    select f.id, row_number() over (order by ts_rank_cd(f.fts, qn.tsq) desc) as r
    from filtered f, qn
    where qn.q is not null and f.fts @@ qn.tsq
    order by ts_rank_cd(f.fts, qn.tsq) desc
    limit 50
  ),
  by_trgm as (
    select f.id, row_number() over (order by similarity(lower(f.name), lower(qn.q)) desc) as r
    from filtered f, qn
    where qn.q is not null and lower(f.name) % lower(qn.q)
    order by similarity(lower(f.name), lower(qn.q)) desc
    limit 50
  ),
  by_vec as (
    select f.id, row_number() over (order by f.embedding <=> q_embedding) as r
    from filtered f
    where q_embedding is not null and f.embedding is not null
    order by f.embedding <=> q_embedding
    limit 50
  ),
  -- без текстового запроса (только фильтры) — сортировка по цене
  by_filter as (
    select f.id, row_number() over (order by f.price_site nulls last) as r
    from filtered f, qn
    where qn.q is null and q_embedding is null
    order by f.price_site nulls last
    limit 50
  ),
  fused as (
    select id, sum(w / (60.0 + r)) as score from (
      select id, r, 3.0 as w from by_sku
      union all select id, r, 1.0 from by_fts
      union all select id, r, 0.7 from by_trgm
      union all select id, r, 1.0 from by_vec
      union all select id, r, 1.0 from by_filter
    ) u group by id
  )
  select p.id, p.sku, p.name, p.url, p.brand, p.category_path, p.price_site, p.price_store,
         p.multiplicity, p.image_url, p.attrs, fused.score
  from fused join products p using (id)
  order by fused.score desc
  limit greatest(1, least(p_limit, 30));
$$;

-- Гибридный поиск по базе знаний.
create or replace function public.search_chunks(
  q           text,
  q_embedding extensions.vector(1536) default null,
  p_kinds     text[] default null,
  p_limit     int default 6
)
returns table (id bigint, url text, title text, kind text, heading text, content text, score double precision)
language sql stable
set search_path = public, extensions
as $$
  with filtered as (
    select c.*, pg.url, pg.title, pg.kind
    from page_chunks c join pages pg on pg.id = c.page_id
    where p_kinds is null or pg.kind = any (p_kinds)
  ),
  tsq as (select websearch_to_tsquery('russian', coalesce(q, '')) as t),
  by_fts as (
    select f.id, row_number() over (order by ts_rank_cd(f.fts, tsq.t) desc) as r
    from filtered f, tsq where f.fts @@ tsq.t
    order by ts_rank_cd(f.fts, tsq.t) desc limit 30
  ),
  by_vec as (
    select f.id, row_number() over (order by f.embedding <=> q_embedding) as r
    from filtered f
    where q_embedding is not null and f.embedding is not null
    order by f.embedding <=> q_embedding limit 30
  ),
  fused as (
    select id, sum(1.0 / (60.0 + r)) as score
    from (select * from by_fts union all select * from by_vec) u group by id
  )
  select f.id, f.url, f.title, f.kind, f.heading, f.content, fused.score
  from fused join filtered f using (id)
  order by fused.score desc
  limit greatest(1, least(p_limit, 15));
$$;

-- Какие характеристики встречаются у товаров категории (подсказка модели для фильтров).
create or replace function public.category_facets(p_category text, p_limit int default 12)
returns table (key text, values text[], products int)
language sql stable
set search_path = public
as $$
  with scoped as (
    select p.attrs from products p
    where p.is_active
      and (p.category_url ilike '%' || p_category || '%'
           or array_to_string(p.category_path, ' / ') ilike '%' || p_category || '%')
  ),
  kv as (
    select e.key, e.value, count(*) as n
    from scoped, jsonb_each_text(scoped.attrs) e
    where e.key not in ('Артикул', 'Артикул поставщика', 'Новинка')
    group by e.key, e.value
  ),
  keys as (
    select key, sum(n)::int as products from kv group by key
    order by sum(n) desc limit greatest(1, least(p_limit, 30))
  )
  select k.key,
         (select array_agg(v.value order by v.n desc) from
            (select value, n from kv where kv.key = k.key order by n desc limit 15) v),
         k.products
  from keys k
  order by k.products desc;
$$;

create or replace function public.list_categories(p_parent_url text default null)
returns table (url text, name text, depth int, product_count int, has_children boolean)
language sql stable
set search_path = public
as $$
  select c.url, c.name, c.depth, c.product_count,
         exists (select 1 from categories ch where ch.parent_url = c.url)
  from categories c
  where (p_parent_url is null and c.parent_url is null)
     or c.parent_url = p_parent_url
  order by c.product_count desc, c.name;
$$;

-- Пересчёт числа товаров в категориях (с учётом вложенных) — вызывается ingest'ом.
create or replace function public.refresh_category_counts()
returns void
language sql
set search_path = public
as $$
  update categories c set product_count = coalesce(x.n, 0), updated_at = now()
  from (
    select c2.url, count(p.id) as n
    from categories c2
    left join products p on p.is_active and p.category_url like c2.url || '%'
    group by c2.url
  ) x
  where x.url = c.url;
$$;

-- Rate-limit: число сообщений пользователя за последнюю минуту по сессии и IP.
create or replace function public.recent_message_counts(p_session uuid, p_ip_hash text)
returns table (by_session int, by_ip int)
language sql stable
set search_path = public
as $$
  select
    (select count(*)::int from chat_messages
      where session_id = p_session and role = 'user' and created_at > now() - interval '1 minute'),
    (select count(*)::int from chat_messages
      where ip_hash = p_ip_hash and role = 'user' and created_at > now() - interval '1 minute');
$$;

revoke execute on all functions in schema public from anon, authenticated;
