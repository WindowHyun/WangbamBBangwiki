-- 이미지 업로드 횟수 제한 방식 수정
--
-- Supabase Storage 는 업로드 전에 정책을 "시험 삽입"으로 검사하고 그 트랜잭션을 되돌린 뒤
-- 실제 저장은 별도로 한다. 그래서 정책 안에서 횟수를 기록하면 기록이 사라진다.
-- → 정책(WITH CHECK)은 기록을 읽어 한도 초과만 검사하고,
--   기록은 실제 저장이 끝난 뒤 storage.objects 의 AFTER INSERT 트리거에서 남긴다.
--   (시험 삽입에서 트리거가 남긴 기록은 함께 되돌려진다.)

alter table private.upload_log add column object_name text;

-- 한도 검사만 한다 (기록하지 않음)
create or replace function private.allow_image_upload() returns boolean
language plpgsql stable security definer set search_path = '' as $$
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
  return true;
end $$;

-- 실제로 저장된 업로드를 기록한다 (누가 올렸는지 찾아 차단할 수 있도록 파일 이름도 남긴다)
create function private.log_image_upload() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_salt text;
  v_hash text;
begin
  select value into v_salt from private.config where key = 'ip_salt';
  v_hash := encode(sha256(convert_to(v_salt || private.client_ip(), 'UTF8')), 'hex');
  insert into private.upload_log (ip_hash, object_name) values (v_hash, new.name);
  if random() < 0.02 then
    delete from private.upload_log where created_at < now() - interval '30 days';
  end if;
  return null;
end $$;

create trigger log_image_upload
  after insert on storage.objects
  for each row when (new.bucket_id = 'wiki-images')
  execute function private.log_image_upload();
