---
name: read_file
description: 파일의 내용을 읽어서 반환합니다.
input_schema:
  type: object
  properties:
    path:
      type: string
      description: 읽을 파일의 경로
  required:
    - path
---

# fs-read

로컬 파일시스템의 파일을 UTF-8 로 읽어 내용을 반환한다. 읽기 실패 시 에러 메시지 문자열 반환.
