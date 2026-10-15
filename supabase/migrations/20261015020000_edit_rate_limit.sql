-- 편집 횟수 제한: IP당 분당 6회 → 15회
-- (edit_page 의 숫자만 바뀐 것이다. 나머지는 20261015000000_access_code.sql 과 같다.)
-- 더 바꾸려면 아래 함수의 `>= 15` 를 고쳐 다시 실행한다.

create or replace function public.edit_page(
  p_title    text,
  p_content  text,
  p_base_rev integer,
  p_summary  text default '',
  p_author   text default ''
) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_title    text := btrim(coalesce(p_title, ''));
  v_content  text := replace(coalesce(p_content, ''), E'\r\n', E'\n');
  v_ip       text := private.client_ip();
  v_hash     text;
  v_page     public.pages%rowtype;
  v_fm       text;
  v_cats     text[] := '{}';
  v_redirect text;
  v_links    text[];
  v_new_rev  integer;
  m          text[];
begin
  if not private.has_access() then
    raise exception 'locked';
  end if;

  if char_length(v_title) not between 1 and 100
     or v_title ~ '[\[\]|#\n\r\t]'
     or v_title ~ '^/|/$|//' then
    raise exception 'invalid_title';
  end if;
  if btrim(v_content) = '' or char_length(v_content) > 100000 then
    raise exception 'invalid_content';
  end if;

  select value into v_hash from private.config where key = 'ip_salt';
  v_hash := encode(sha256(convert_to(v_hash || v_ip, 'UTF8')), 'hex');

  if exists (select 1 from private.blocked_ips where ip_hash = v_hash) then
    raise exception 'blocked';
  end if;
  if (select count(*) from public.revisions
      where ip_hash = v_hash and created_at > now() - interval '1 minute') >= 15 then
    raise exception 'rate_limited';
  end if;

  -- 머리말(categories / redirect) 해석
  m := regexp_match(v_content, '^---\n(.*?)\n---(\n|$)');
  if m is not null then
    v_fm := m[1];
    m := regexp_match(v_fm, '(?:^|\n)categories:[ \t]*([^\n]*)');
    if m is not null then
      v_cats := array(
        select btrim(x)
        from unnest(regexp_split_to_array(m[1], ',')) with ordinality as t(x, o)
        where btrim(x) <> ''
        order by o
        limit 20
      );
    end if;
    m := regexp_match(v_fm, '(?:^|\n)redirect:[ \t]*([^\n]*)');
    if m is not null and btrim(m[1]) <> '' then
      v_redirect := left(btrim(m[1]), 100);
    end if;
  end if;

  -- 문서 링크 추출 (역링크용)
  select coalesce(array_agg(distinct x), '{}') into v_links
  from (
    select btrim(split_part(split_part(replace(t.mm[1], E'\\|', '|'), '|', 1), '#', 1)) as x
    from regexp_matches(v_content, '\[\[([^\[\]\n]+?)\]\]', 'g') as t(mm)
  ) s
  where x <> '' and x !~* '^https?://' and x !~ '^분류:';

  select * into v_page from public.pages where title = v_title for update;
  if found then
    if v_page.protected then raise exception 'protected'; end if;
    if p_base_rev is distinct from v_page.rev then raise exception 'conflict'; end if;
    if v_page.content = v_content then raise exception 'no_change'; end if;
    v_new_rev := v_page.rev + 1;
    update public.pages
       set content = v_content, categories = v_cats, redirect_to = v_redirect,
           links = v_links, rev = v_new_rev, updated_at = now()
     where title = v_title;
  else
    if coalesce(p_base_rev, 0) <> 0 then raise exception 'conflict'; end if;
    v_new_rev := 1;
    begin
      insert into public.pages (title, content, categories, redirect_to, links, rev)
      values (v_title, v_content, v_cats, v_redirect, v_links, 1);
    exception when unique_violation then
      raise exception 'conflict';
    end;
  end if;

  insert into public.revisions (page_title, rev, content, summary, author, ip_label, ip_hash, size)
  values (
    v_title, v_new_rev, v_content,
    left(btrim(coalesce(p_summary, '')), 200),
    coalesce(nullif(left(btrim(coalesce(p_author, '')), 20), ''), '익명'),
    private.mask_ip(v_ip), v_hash, char_length(v_content)
  );

  return json_build_object('title', v_title, 'rev', v_new_rev);
end $$;
