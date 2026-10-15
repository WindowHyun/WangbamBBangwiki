-- 1회용 초대 링크 + 기기 등록 (친구 전용 위키)
--
-- MAC 주소는 웹사이트가 읽을 수 없다(브라우저가 알려 주지 않고, 폰은 MAC 을 무작위로 바꾼다).
-- 대신 초대 링크를 처음 연 기기에 서버가 고유한 비밀 값(기기 토큰)을 발급하고, 그 기기는 계속 들어올 수 있다.
--
--   · 초대 만들기:  select private.create_invite('명성아');   → 1회용 토큰을 돌려준다 (링크: #/join/토큰)
--   · 초대는 한 번만 쓸 수 있고(기본 7일 안에), 쓰면 그 기기가 등록된다. 서버에는 해시만 저장한다.
--   · 기기 보기:    select id, name, created_at, last_seen, revoked_at, user_agent, ip_label from private.devices;
--   · 기기 막기:    select private.revoke_device(3);
--   · 공유 코드(private.set_access_code)는 있어도 되고 없어도 된다. 등록된 기기는 공유 코드와 상관없이 들어온다.
--   · 켜기/끄기:    select private.gate_on();  /  select private.gate_off();  (끄면 다시 누구나 쓸 수 있음)
--
-- 코드·기기를 하나도 안 정했고 gate 도 안 켰으면(기본) 지금처럼 누구나 쓸 수 있다.

create table private.invites (
  id         bigint generated always as identity primary key,
  name       text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create table private.devices (
  id         bigint generated always as identity primary key,
  name       text not null,
  token_hash text not null unique,
  invite_id  bigint references private.invites (id),
  user_agent text,
  ip_label   text,
  created_at timestamptz not null default now(),
  last_seen  timestamptz,
  revoked_at timestamptz
);

alter table private.invites enable row level security;
alter table private.devices enable row level security;

create function private.hash_token(t text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_salt text;
begin
  select value into v_salt from private.config where key = 'ip_salt';
  return encode(sha256(convert_to(v_salt || ':dev:' || lower(btrim(coalesce(t, ''))), 'UTF8')), 'hex');
end $$;

create function private.gate_on() returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.config (key, value) values ('gate', 'on') on conflict (key) do nothing;
end $$;

-- 모두에게 다시 열기 (공유 코드도 함께 지운다)
create function private.gate_off() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.config where key in ('gate', 'access_code_hash');
end $$;

-- 공유 코드를 정하면 gate 도 함께 켜진다
create or replace function private.set_access_code(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(private.norm_code(p_code)) < 8 then
    raise exception '코드는 8자 이상이어야 합니다 (12자 이상 무작위 권장)';
  end if;
  insert into private.config (key, value) values ('access_code_hash', private.code_hash(p_code))
  on conflict (key) do update set value = excluded.value;
  perform private.gate_on();
end $$;

-- 공유 코드만 끈다. gate 는 그대로라서 등록된 기기만 들어올 수 있다.
create or replace function private.clear_access_code() returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.config where key = 'access_code_hash';
end $$;

-- 이 요청이 들어올 자격이 있는가? (공유 코드이거나, 등록되어 있고 막히지 않은 기기)
create or replace function private.has_access() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  want text;
  v_gate boolean;
  h    json;
  got  text;
begin
  select value into want from private.config where key = 'access_code_hash';
  select exists (select 1 from private.config where key = 'gate') into v_gate;
  if want is null and not v_gate then
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
  if want is not null and private.code_hash(got) = want then
    return true;
  end if;
  return exists (
    select 1 from private.devices
    where token_hash = private.hash_token(got) and revoked_at is null
  );
end $$;

-- 1회용 초대 토큰을 만든다. 토큰은 이때 한 번만 보이고, 서버에는 해시만 남는다.
create function private.create_invite(p_name text, p_days integer default 7) returns text
language plpgsql security definer set search_path = '' as $$
declare
  t text;
begin
  if btrim(coalesce(p_name, '')) = '' then
    raise exception '초대받는 사람의 이름이 필요합니다';
  end if;
  t := 'inv' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.invites (name, token_hash, expires_at)
  values (left(btrim(p_name), 40), private.hash_token(t), now() + make_interval(days => greatest(1, least(p_days, 60))));
  return t;
end $$;

create function private.revoke_device(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.devices set revoked_at = now() where id = p_id and revoked_at is null;
end $$;

-- 초대 링크를 연 기기가 호출한다. 맞는 초대면 기기 토큰을 돌려주고, 아니면 null.
create function public.redeem_invite(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  inv private.invites%rowtype;
  dev text;
  h   json;
  ua  text;
begin
  select * into inv from private.invites
   where token_hash = private.hash_token(p_token) and used_at is null and expires_at > now()
   for update;
  if not found then
    return null;
  end if;
  update private.invites set used_at = now() where id = inv.id;

  dev := 'dev' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  begin
    h := current_setting('request.headers', true)::json;
  exception when others then
    h := null;
  end;
  ua := left(coalesce(h ->> 'user-agent', ''), 200);
  insert into private.devices (name, token_hash, invite_id, user_agent, ip_label)
  values (inv.name, private.hash_token(dev), inv.id, ua, private.mask_ip(private.client_ip()));
  return dev;
end $$;

-- 코드/기기 확인. 등록된 기기면 마지막 접속 시각도 (10분에 한 번) 갱신한다.
create or replace function public.check_access() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  ok  boolean;
  h   json;
  got text;
begin
  ok := private.has_access();
  if ok then
    begin
      h := current_setting('request.headers', true)::json;
      got := nullif(btrim(h ->> 'x-wiki-code'), '');
    exception when others then
      got := null;
    end;
    if got is not null then
      update private.devices set last_seen = now()
       where token_hash = private.hash_token(got) and revoked_at is null
         and (last_seen is null or last_seen < now() - interval '10 minutes');
    end if;
  end if;
  return ok;
end $$;

revoke all on function private.hash_token(text) from public, anon, authenticated;
revoke all on function private.gate_on() from public, anon, authenticated;
revoke all on function private.gate_off() from public, anon, authenticated;
revoke all on function private.create_invite(text, integer) from public, anon, authenticated;
revoke all on function private.revoke_device(bigint) from public, anon, authenticated;
revoke all on function public.redeem_invite(text) from public;
grant execute on function public.redeem_invite(text) to anon, authenticated;
