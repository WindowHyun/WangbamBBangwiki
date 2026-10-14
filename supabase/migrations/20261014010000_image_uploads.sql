-- 이미지 업로드 (Supabase Storage)
--
-- - 공개 읽기 버킷 wiki-images: 파일당 5MB, PNG/JPG/GIF/WEBP 만 허용 (SVG 는 스크립트를 담을 수 있어 제외)
-- - 익명 업로드(insert)만 허용. 지우기·덮어쓰기·목록 보기는 허용하지 않는다.
-- - 업로드 경로는 yyyy/mm/<uuid>.<확장자> 형태만 허용한다.
-- - 업로드 횟수 제한: IP당 분당 8장 / 하루 100장, 전체 하루 1000장. 차단된 IP 는 업로드 불가.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wiki-images', 'wiki-images', true, 5242880,
  array['image/png', 'image/jpeg', 'image/gif', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table private.upload_log (
  id         bigint generated always as identity primary key,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);
create index upload_log_ip_idx on private.upload_log (ip_hash, created_at desc);
create index upload_log_created_idx on private.upload_log (created_at desc);
alter table private.upload_log enable row level security;

-- 업로드를 허용할지 판단하고, 허용하면 횟수를 기록한다. (정책의 WITH CHECK 에서 호출)
create function private.allow_image_upload() returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_salt text;
  v_hash text;
begin
  select value into v_salt from private.config where key = 'ip_salt';
  v_hash := encode(sha256(convert_to(v_salt || private.client_ip(), 'UTF8')), 'hex');

  if exists (select 1 from private.blocked_ips where ip_hash = v_hash) then
    return false;
  end if;
  if (select count(*) from private.upload_log
      where ip_hash = v_hash and created_at > now() - interval '1 minute') >= 8 then
    return false;
  end if;
  if (select count(*) from private.upload_log
      where ip_hash = v_hash and created_at > now() - interval '1 day') >= 100 then
    return false;
  end if;
  if (select count(*) from private.upload_log
      where created_at > now() - interval '1 day') >= 1000 then
    return false;
  end if;

  insert into private.upload_log (ip_hash) values (v_hash);
  -- 오래된 기록은 가끔 정리한다
  if random() < 0.02 then
    delete from private.upload_log where created_at < now() - interval '3 days';
  end if;
  return true;
end $$;

-- private 스키마는 API 로 노출되지 않는다. 정책이 함수를 호출할 수 있게 실행 권한만 준다.
revoke all on function private.allow_image_upload() from public;
grant usage on schema private to anon, authenticated;
grant execute on function private.allow_image_upload() to anon, authenticated;
grant execute on function private.client_ip() to anon, authenticated;

create policy wiki_images_upload on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'wiki-images'
    and name ~ '^[0-9]{4}/[0-9]{2}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$'
    and private.allow_image_upload()
  );
