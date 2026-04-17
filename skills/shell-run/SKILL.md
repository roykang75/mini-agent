---
name: run_command
description: 쉘 명령을 실행하고 결과를 반환합니다.
input_schema:
  type: object
  properties:
    command:
      type: string
      description: 실행할 쉘 명령
  required:
    - command
---

# shell-run

쉘 명령 실행. 30 초 timeout, 1 MB maxBuffer. 에러 / stderr / stdout 을 단일 문자열로 병합 반환.
