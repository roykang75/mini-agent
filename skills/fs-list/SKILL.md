---
name: list_dir
description: 디렉토리 내 파일/서브디렉토리 목록을 반환합니다. 각 줄은 "d <name>" (디렉토리) 또는 "f <name>" (파일).
input_schema:
  type: object
  properties:
    path:
      type: string
      description: 목록을 볼 디렉토리 경로
  required:
    - path
---

# fs-list

디렉토리 entries 를 한 줄씩 반환. 읽기 실패 시 Error 문자열. Shell 없이 파일 탐색이 필요할 때 `read_file` 전 단계로 사용.
