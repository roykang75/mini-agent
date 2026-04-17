---
name: write_file
description: 파일에 내용을 작성합니다. 디렉토리가 없으면 자동 생성합니다.
input_schema:
  type: object
  properties:
    path:
      type: string
      description: 작성할 파일의 경로
    content:
      type: string
      description: 파일에 작성할 내용
  required:
    - path
    - content
---

# fs-write

로컬 파일시스템에 파일 작성. 필요한 상위 디렉토리 자동 생성. 기존 파일 덮어쓴다.
