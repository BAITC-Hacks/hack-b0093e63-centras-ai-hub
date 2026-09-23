-- Регрессия после OR-полнотекста (20260923160000_search_recall.sql): запрос
-- "E27 10W 4000K" перестал находить точный товар первым — OR-вариант находит
-- слишком много частичных совпадений и «размывает» ранжирование.
--
-- Фикс: полнотекст участвует в RRF ДВАЖДЫ —
--   by_fts_all — исходный AND-tsquery (websearch_to_tsquery как есть), вес 2.0:
--                поднимает товары, совпавшие по ВСЕМ словам запроса, наверх;
--   by_fts     — OR-вариант (recall), вес 1.0: как и раньше, чтобы находить
--                товары, совпавшие лишь частично (единицы измерения и т.п.).
-- Остальное (exact-SKU буст, триграммы, вектор, сама формула RRF) без изменений.

set search_path = ekt, public, extensions;

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
            -- каждый ключ из p_attrs должен найти совпадающий атрибут товара
            select 1 from jsonb_each_text(p_attrs) f
            where not exists (
              select 1 from jsonb_each_text(p.attrs) pa
              where lower(pa.key) = lower(f.key)
                and (
                  -- подстрока (после нормализации значения фильтра: единицы, Е→E, ...)
                  pa.value ilike '%' || ekt.normalize_product_query(f.value) || '%'
                  or (
                    -- либо совпадает первое число в обоих значениях (10 = "10 Вт")
                    regexp_match(pa.value, '[0-9]+(?:[.,][0-9]+)?') is not null
                    and regexp_match(f.value, '[0-9]+(?:[.,][0-9]+)?') is not null
                    and replace((regexp_match(pa.value, '[0-9]+(?:[.,][0-9]+)?'))[1], ',', '.')::numeric
                        = replace((regexp_match(f.value, '[0-9]+(?:[.,][0-9]+)?'))[1], ',', '.')::numeric
                  )
                )
            )
          ))
  ),
  qraw as (select nullif(trim(coalesce(q, '')), '') as q),
  qn as (
    select
      qraw.q,
      case when qraw.q is null then null else ekt.normalize_product_query(qraw.q) end as qn
    from qraw
  ),
  -- tsq_and — как есть (все слова, точнее); tsq_or — «&»→«|» (полнота).
  -- websearch_to_tsquery('') даёт валидный пустой tsquery, поэтому '' ::tsquery не кастуем.
  tsq as (
    select w.qq as tsq_and,
           case
             when w.qq is null then null::tsquery
             when w.qq::text = '' then w.qq
             else replace(w.qq::text, ' & ', ' | ')::tsquery
           end as tsq_or
    from qn, lateral (
      select case when qn.qn is null then null::tsquery
                  else websearch_to_tsquery('russian', qn.qn)
             end as qq
    ) w
  ),
  by_sku as (
    select f.id, row_number() over () as r
    from filtered f, qn
    where qn.q is not null
      and (lower(f.sku) = lower(qn.q) or lower(f.supplier_sku) = lower(qn.q)
           or lower(f.sku) = lower(qn.q) || '_')
    limit 5
  ),
  -- AND-полнотекст: товар совпал по ВСЕМ словам запроса — точнее, ранжируется выше.
  by_fts_all as (
    select f.id, row_number() over (order by ts_rank_cd(f.fts, tsq.tsq_and) desc) as r
    from filtered f, qn, tsq
    where qn.qn is not null and tsq.tsq_and is not null and f.fts @@ tsq.tsq_and
    order by ts_rank_cd(f.fts, tsq.tsq_and) desc
    limit 50
  ),
  -- OR-полнотекст: товар совпал хотя бы по части слов — для полноты (recall).
  by_fts as (
    select f.id, row_number() over (order by ts_rank_cd(f.fts, tsq.tsq_or) desc) as r
    from filtered f, qn, tsq
    where qn.qn is not null and tsq.tsq_or is not null and f.fts @@ tsq.tsq_or
    order by ts_rank_cd(f.fts, tsq.tsq_or) desc
    limit 50
  ),
  by_trgm as (
    select f.id, row_number() over (order by similarity(lower(f.name), lower(qn.qn)) desc) as r
    from filtered f, qn
    where qn.qn is not null and lower(f.name) % lower(qn.qn)
    order by similarity(lower(f.name), lower(qn.qn)) desc
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
      union all select id, r, 2.0 from by_fts_all
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

-- Доступ: только service_role (новые CREATE FUNCTION по умолчанию дают EXECUTE PUBLIC).
revoke execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) from anon, authenticated, public;
grant execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) to service_role;
