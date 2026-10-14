# 왕밤빵 위키

GitHub Pages(정적 사이트) + Supabase(DB)로 동작하는 나무위키 스타일 위키입니다.
회원가입 없이 누구나 문서를 읽고 **사이트 안에서 바로 편집**할 수 있습니다.

## 기능

- 문서 보기 / 편집 / 새 문서 만들기
- **서식 툴바 편집기** ([EasyMDE](https://github.com/Ionaru/easy-markdown-editor) 기반): 버튼이나 단축키로 서식 적용, 미리보기·나란히 보기·전체화면

  | 단축키 | 동작 | 단축키 | 동작 |
  |---|---|---|---|
  | `Ctrl+B` | 굵게 | `Ctrl+K` | `[[문서 링크]]` |
  | `Ctrl+I` | 기울임 | `Ctrl+Shift+F` | `[* 각주]` |
  | `Ctrl+2/3/4` | 제목 H2/H3/H4 | `Ctrl+Alt+K` | 외부 링크 |
  | `Ctrl+P` | 미리보기 | `F11` | 전체화면 |

  Mac에서는 `Ctrl` 대신 `Cmd`. 글자를 선택한 채 누르면 그 글자를 감싸고, 이미 감싸져 있으면 다시 누를 때 해제됩니다.
- **편집 기록(역사)**, 판 보기, 두 판 비교(diff), 이전 판으로 되돌리기
- 편집 충돌 감지 (내가 편집하는 사이 다른 사람이 저장하면 알려 줌)
- 편집자 닉네임 + IP 일부(예: `1.2.*.*`) 기록
- `[[문서 링크]]`, `[[문서#섹션|표시 글자]]`, 빨간 링크(없는 문서), `[* 각주]`, 자동 번호 목차
- 분류(`categories:`), 넘겨주기(`redirect:`), 역링크, 최근 변경, 전체 문서, 랜덤
- 제목 자동완성 + 본문 검색, 다크 모드, 모바일 대응

## 구조

- `index.html`, `assets/` — 정적 프론트엔드 (빌드 불필요)
- `assets/config.js` — 사이트 이름, Supabase URL, 공개용(publishable) 키
- `supabase/migrations/` — DB 스키마 (적용 완료)
- `supabase/seed.sql` — 초기 예시 문서

### 보안 모델

공개용 키는 브라우저에 노출됩니다. 그래서 DB 쪽에서 권한을 제한했습니다.

- 테이블은 **읽기 전용**(RLS). 쓰기는 `edit_page()` 함수로만 가능합니다.
- `edit_page()` 가 제목·길이 검증, 충돌 검사, **IP당 분당 6회 제한**, 차단 목록 확인을 합니다.
- IP는 서버가 직접 읽고(클라이언트가 속일 수 없음), 원본은 저장하지 않습니다. 가린 값(`1.2.*.*`)과 솔트 해시만 저장하며 해시는 API로 읽을 수 없습니다.
- 본문은 DOMPurify로 정화해서 렌더링합니다.

## 운영 (Supabase SQL Editor에서 실행)

문서 보호 / 보호 해제:

```sql
update public.pages set protected = true where title = '대문';
```

장난 편집 되돌린 뒤 작성자 차단 (revisions 의 id 로 IP 해시를 찾아 차단):

```sql
insert into private.blocked_ips (ip_hash, reason)
select ip_hash, '장난 편집' from public.revisions where id = 123
on conflict do nothing;
```

문서 삭제 (역사도 함께 삭제됨):

```sql
delete from public.pages where title = '지울 문서';
```

## 배포

1. 이 브랜치를 `main` 에 병합합니다.
2. 저장소 **Settings → Pages**: Source `Deploy from a branch`, Branch `main` / `/ (root)`.
3. `https://<사용자>.github.io/<저장소>/` 에서 확인합니다.

로컬 확인: `python3 -m http.server 8000` 후 http://localhost:8000
