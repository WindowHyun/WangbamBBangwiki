# 왕밤빵 위키

GitHub Pages 위에서 동작하는, 나무위키 스타일의 마크다운 위키입니다. 서버·DB·빌드 도구가 필요 없습니다.

## 기능

- 문서 = `pages/` 폴더의 `.md` 파일 (하위 폴더 가능: `pages/게임/마크.md` → `게임/마크`)
- `[[문서 링크]]`, `[[문서#섹션|표시 글자]]`, 없는 문서는 빨간 링크
- `[* 각주]`, 자동 번호 목차, 분류(`categories:`), 역링크, 문서 넘겨주기(`redirect:`)
- 제목 자동완성 + 본문 검색, 최근 변경, 전체 문서, 랜덤 문서
- 다크 모드, 모바일 대응
- 편집 / 새 문서 / 역사 버튼은 GitHub 웹 편집기와 커밋 기록으로 연결

## 배포 방법

1. 이 브랜치를 `main` 에 병합합니다.
2. 저장소 **Settings → Pages → Build and deployment**: Source `Deploy from a branch`, Branch `main` / `/ (root)`.
3. `https://<사용자>.github.io/<저장소>/` 에서 확인합니다.

`assets/config.js` 에서 사이트 이름, 저장소, 브랜치를 바꿀 수 있습니다.

## 문서 추가 / 수정

`pages/` 에 `.md` 를 추가·수정하고 `main` 에 푸시하면, GitHub Actions(`update-index.yml`)가
`data/index.json`(검색·역링크·최근 변경용 색인)을 자동 갱신합니다.
로컬에서 확인하려면:

```sh
node scripts/build-index.mjs
python3 -m http.server 8000   # http://localhost:8000
```

문법은 `pages/문법 도움말.md` 를 참고하세요.

## 한계

정적 사이트이므로 로그인, 실시간 편집, 편집 충돌 처리는 없습니다. 편집은 GitHub 권한(저장소 협업자 또는 Pull Request)을 따릅니다.
