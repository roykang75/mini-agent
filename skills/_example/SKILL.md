---
name: echo
description: Echo back the given message (for skill-loader PoC).
input_schema:
  type: object
  properties:
    message:
      type: string
      description: Message to echo
  required:
    - message
---

# Echo Skill

입력받은 `message`를 `Echo: <message>` 형식으로 돌려준다. skill loader PoC 전용 샘플.