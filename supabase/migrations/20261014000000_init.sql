-- 왕밤빵 위키 초기 스키마
-- 읽기: 누구나 (anon). 쓰기: edit_page() 함수로만 가능 (테이블 직접 쓰기 불가).

create schema if not exists private;

create table private.config (
  key   text primary key,
  value text not null
);
insert into private.config (key, value) values ('ip_salt', gen_random_uuid()::text);

create table private.blocked_ips (
  ip_hash    text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

alter table private.config enable row level security;
alter table private.blocked_ips enable row level security;

create table public.pages (
  title      text primary key check (char_length(title) between 1 and 100),
  content    text not null check (char_length(content) <= 100000),
  categories text[] not null default '{}',
  redirect_to text,
  links      text[] not null default '{}',
  rev        integer not null default 1,
  protected  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pages_links_idx on public.pages using gin (links);
create index pages_updated_idx on public.pages (updated_at desc);

create table public.revisions (
  id         bigint generated always as identity primary key,
  page_title text not null references public.pages (title) on delete cascade on update cascade,
  rev        integer not null,
  content    text not null,
  summary    text not null default '',
  author     text not null default '익명',
  ip_label   text not null,
  ip_hash    text not null,
  size       integer not null,
  created_at timestamptz not null default now(),
  unique (page_title, rev)
);
create index revisions_created_idx on public.revisions (created_at desc);
create index revisions_ip_idx on public.revisions (ip_hash, created_at desc);

alter table public.pages enable row level security;
alter table public.revisions enable row level security;

create policy pages_read on public.pages for select to anon, authenticated using (true);
create policy revisions_read on public.revisions for select to anon, authenticated using (true);

-- 테이블 직접 쓰기 차단, ip_hash 컬럼은 읽기도 차단
revoke all on public.pages from anon, authenticated;
revoke all on public.revisions from anon, authenticated;
grant select on public.pages to anon, authenticated;
grant select (id, page_title, rev, content, summary, author, ip_label, size, created_at)
  on public.revisions to anon, authenticated;

-- ---------- 내부 헬퍼 (private 스키마, API로 노출되지 않음) ----------

create function private.client_ip() returns text
language plpgsql stable set search_path = '' as $$
declare
  h json;
begin
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  return coalesce(
    nullif(btrim(h ->> 'cf-connecting-ip'), ''),
    nullif(btrim(split_part(coalesce(h ->> 'x-forwarded-for', ''), ',', 1)), ''),
    'unknown'
  );
end $$;

create function private.mask_ip(ip text) returns text
language sql immutable set search_path = '' as $$
  select case
    when ip ~ '^\d+\.\d+\.\d+\.\d+$' then split_part(ip, '.', 1) || '.' || split_part(ip, '.', 2) || '.*.*'
    when ip like '%:%' then split_part(ip, ':', 1) || ':' || split_part(ip, ':', 2) || ':*'
    else 'unknown'
  end
$$;

-- ---------- 문서 저장 ----------
-- p_base_rev: 편집을 시작할 때의 판 번호 (새 문서는 0). 그 사이 다른 사람이 고쳤으면 'conflict'.

create function public.edit_page(
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
      where ip_hash = v_hash and created_at > now() - interval '1 minute') >= 6 then
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

-- ---------- 검색 ----------

create function public.search_pages(q text) returns table (
  title text, categories text[], updated_at timestamptz, snippet text, score integer
)
language sql stable set search_path = '' as $$
  with terms as (
    select lower(replace(replace(replace(t, '\', '\\'), '%', '\%'), '_', '\_')) as pat,
           lower(t) as raw
    from unnest(regexp_split_to_array(btrim(left(coalesce(q, ''), 100)), '\s+')) as t
    where t <> ''
    limit 6
  )
  select p.title, p.categories, p.updated_at,
         substr(p.content,
                greatest(1, coalesce(nullif(position((select raw from terms limit 1) in lower(p.content)), 0), 1) - 30),
                140) as snippet,
         (select coalesce(sum(case
                when lower(p.title) = raw then 100
                when lower(p.title) like pat || '%' escape '\' then 60
                when lower(p.title) like '%' || pat || '%' escape '\' then 40
                else 5 end), 0) from terms)::integer as score
  from public.pages p
  where exists (select 1 from terms)
    and not exists (
      select 1 from terms
      where not (lower(p.title) like '%' || pat || '%' escape '\'
              or lower(p.content) like '%' || pat || '%' escape '\')
    )
  order by score desc, p.title
  limit 50
$$;

revoke all on function public.edit_page(text, text, integer, text, text) from public;
revoke all on function public.search_pages(text) from public;
grant execute on function public.edit_page(text, text, integer, text, text) to anon, authenticated;
grant execute on function public.search_pages(text) to anon, authenticated;
