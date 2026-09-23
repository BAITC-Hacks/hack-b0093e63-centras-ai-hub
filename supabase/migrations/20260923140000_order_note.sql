-- Пометка вместо цены («Под заказ») — у части товаров нет цены на сайте.
alter table ekt.products add column if not exists order_note text;

set search_path = ekt, public, extensions;

-- Возвращаемый тип меняется — функцию нужно пересоздать.
drop function if exists ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int);

create or replace function ekt.search_products(
  q            text,
  q_embedding  vector(1536) default null,
  p_brand      text default null,
  p_category   text default null,      -- часть названия категории или URL
  p_price_min  numeric default null,
  p_price_max  numeric default null,
  p_attrs      jsonb default null,
  p_limit      int default 10
)
returns table (
  id bigint, sku text, name text, url text, brand text, category_path text[],
  price_site numeric, price_store numeric, order_note text, multiplicity numeric, image_url text,
  attrs jsonb, score double precision
)
language sql stable
set search_path = ekt, public, extensions
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
  select p.id, p.sku, p.name, p.url, p.brand, p.category_path, p.price_site, p.price_store, p.order_note,
         p.multiplicity, p.image_url, p.attrs, fused.score
  from fused join products p using (id)
  order by fused.score desc
  limit greatest(1, least(p_limit, 30));
$$;

revoke execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) from anon, authenticated, public;
grant execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) to service_role;
