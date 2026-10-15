-- 접속 코드 (친구 전용 위키)
--
-- 코드를 정하면, 코드를 아는 사람만 문서를 읽고 쓰고 사진을 올릴 수 있다.
-- 브라우저가 모든 요청에 x-wiki-code 헤더로 코드를 실어 보내고, 서버(DB)가 확인한다.
--
--   · 코드를 아직 정하지 않았으면(private.config 에 access_code_hash 가 없으면) 지금처럼 누구나 쓸 수 있다.
--   · 코드는 해시로만 저장한다. 대소문자·공백·하이픈은 무시한다. (kq7m-x3vn-p9tb = KQ7MX3VNP9TB)
--   · 정하기:  select private.set_access_code('새 코드');    끄기:  select private.clear_access_code();
--   · 코드는 길고 무작위여야 안전하다 (12자 이상 권장). 요청 횟수 제한이 없어 짧은 코드는 추측당할 수 있다.
--   · 사진 파일 자체는 공개 버킷이라, 사진 주소(추측 불가능한 무작위 이름)를 아는 사람은 볼 수 있다.

create function private.norm_code(c text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(coalesce(c, ''), '[\s\-_]+', '', 'g'))
$$;

create function private.code_hash(c text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_salt text;
begin
  select value into v_salt from private.config where key = 'ip_salt';
  return encode(sha256(convert_to(v_salt || ':code:' || private.norm_code(c), 'UTF8')), 'hex');
end $$;

-- 이 요청이 올바른 코드를 가지고 있는가? (코드를 정하지 않았으면 항상 true)
create function private.has_access() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  want text;
  h    json;
  got  text;
begin
  select value into want from private.config where key = 'access_code_hash';
  if want is null then
    return true;
  end if;
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    return false;
  end;
  got := nullif(btrim(h ->> 'x-wiki-code'), '');
  if got is null then
    return false;
  end if;
  return private.code_hash(got) = want;
end $$;

create function private.set_access_code(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(private.norm_code(p_code)) < 8 then
    raise exception '코드는 8자 이상이어야 합니다 (12자 이상 무작위 권장)';
  end if;
  insert into private.config (key, value) values ('access_code_hash', private.code_hash(p_code))
  on conflict (key) do update set value = excluded.value;
end $$;

create function private.clear_access_code() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.config where key = 'access_code_hash';
end $$;

-- 관리용 함수는 DB 관리자(SQL Editor)만 실행한다
revoke all on function private.set_access_code(text) from public, anon, authenticated;
revoke all on function private.clear_access_code() from public, anon, authenticated;
revoke all on function private.code_hash(text) from public, anon, authenticated;
revoke all on function private.has_access() from public;
grant execute on function private.has_access() to anon, authenticated;

-- 화면이 "코드가 맞는지" 물어볼 때 쓴다
create function public.check_access() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_access()
$$;
revoke all on function public.check_access() from public;
grant execute on function public.check_access() to anon, authenticated;

-- 읽기: 코드가 맞아야 문서·역사를 볼 수 있다
alter policy pages_read on public.pages using ((select private.has_access()));
alter policy revisions_read on public.revisions using ((select private.has_access()));

-- 사진 올리기: 코드가 맞아야 한다
alter policy wiki_images_upload on storage.objects
  with check (
    bucket_id = 'wiki-images'
    and name ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$'
    and private.has_access()
    and private.allow_image_upload()
  );

-- 쓰기: edit_page 맨 앞에서 코드를 확인한다 (그 밖의 내용은 초기 스키마와 같다)
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
