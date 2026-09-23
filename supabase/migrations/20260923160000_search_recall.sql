-- Возврат полноты поиска товаров (recall): p_attrs слепо сравнивал сырые значения
-- («10» в базе vs «10 Вт» от модели) и полнотекст требовал совпадения ВСЕХ слов
-- запроса («Вт» отсутствует в названии товара — не находилось ничего).
--
-- 1) ekt.normalize_product_query(text) — приводит единицы/цоколи к единому виду:
--    «10 Вт»/«10вт»/«10 W» → «10W»; «4000 К»/«4000к»/«4000 K» → «4000K»;
--    «Е27»/«е27» (кириллица) → «E27» (то же для Е14/Е40); «GX 53» → «GX53».
--    Применяется и к тексту запроса (FTS/триграммы), и к значениям p_attrs.
--
-- 2) p_attrs: совпадение по ключу регистронезависимое (lower(key)); значение
--    считается совпавшим, если сырое значение в базе ILIKE '%'||нормализованное
--    значение фильтра||'%', ИЛИ первое число в обоих значениях совпадает численно
--    (запятая → точка).
--
-- 3) Полнотекст: запрос нормализуется, tsquery от websearch_to_tsquery переводится
--    в OR («&» → «|»), поэтому товар, совпавший по части слов, тоже находится —
--    ранжирование по ts_rank_cd поднимает совпавших по большему числу слов выше.
--    Пустой запрос по-прежнему не ломает cast к tsquery (websearch_to_tsquery('')
--    возвращает валидный пустой tsquery — просто не используем '' ::tsquery).

set search_path = ekt, public, extensions;

-- ---------------------------------------------------------------------------
-- Нормализация запроса/значений атрибутов (единицы измерения, цоколи).
-- ---------------------------------------------------------------------------
create or replace function ekt.normalize_product_query(q text)
returns text
language sql
immutable
set search_path = ekt, public, extensions
as $$
  with s0 as (select coalesce(q, '') as t),
  -- «10 Вт» / «10вт» / «10 W» → «10W»
  s1 as (
    select regexp_replace(t, '([0-9]+(?:[.,][0-9]+)?)\s*(вт|w)\M', '\1W', 'gi') as t
    from s0
  ),
  -- «4000 К» / «4000к» / «4000 K» → «4000K»
  s2 as (
    select regexp_replace(t, '([0-9]+(?:[.,][0-9]+)?)\s*(к|k)\M', '\1K', 'gi') as t
    from s1
  ),
  -- «Е27» / «е27» (кириллица, с пробелом или без) → «E27» (то же для Е14/Е40)
  s3 as (
    select regexp_replace(t, '\m[EeЕе]\s*([0-9]{2,3})\M', 'E\1', 'g') as t
    from s2
  ),
  -- «GX 53», «IP 65», «GU 10» и т.п. — короткий латинский код + число через пробел
  s4 as (
    select regexp_replace(t, '\m([A-Za-z]{1,3})\s+([0-9]{1,3})\M', '\1\2', 'g') as t
    from s3
  ),
  s5 as (
    select trim(regexp_replace(t, '\s+', ' ', 'g')) as t
    from s4
  )
  select t from s5;
$$;

-- ---------------------------------------------------------------------------
-- Гибридный поиск товаров (сигнатура и возвращаемые колонки без изменений).
-- ---------------------------------------------------------------------------
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
  tsq as (
    select
      case
        when qn.qn is null then null::tsquery
        else (
          select case when w.qq::text = '' then w.qq
                       else replace(w.qq::text, ' & ', ' | ')::tsquery
                  end
          from (select websearch_to_tsquery('russian', qn.qn) as qq) w
        )
      end as tsq
    from qn
  ),
  by_sku as (
    select f.id, row_number() over () as r
    from filtered f, qn
    where qn.q is not null
      and (lower(f.sku) = lower(qn.q) or lower(f.supplier_sku) = lower(qn.q)
           or lower(f.sku) = lower(qn.q) || '_')
    limit 5
  ),
  by_fts as (
    select f.id, row_number() over (order by ts_rank_cd(f.fts, tsq.tsq) desc) as r
    from filtered f, qn, tsq
    where qn.qn is not null and tsq.tsq is not null and f.fts @@ tsq.tsq
    order by ts_rank_cd(f.fts, tsq.tsq) desc
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

-- Доступ: только service_role (см. init.sql) — новые функции по умолчанию
-- получают EXECUTE для PUBLIC, поэтому отзываем/выдаём явно.
revoke execute on function ekt.normalize_product_query(text) from anon, authenticated, public;
grant execute on function ekt.normalize_product_query(text) to service_role;

revoke execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) from anon, authenticated, public;
grant execute on function ekt.search_products(text, vector, text, text, numeric, numeric, jsonb, int) to service_role;
