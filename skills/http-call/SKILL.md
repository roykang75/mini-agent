---
name: http_call
description: "Make an HTTP request to an external URL. Pass @vault:<key> references inside `url`, `headers`, or stringified `body` — they are automatically resolved server-side before the request is sent, so the raw secret never leaves the agent boundary. Use this to call APIs such as the CIA analysis service."
input_schema:
  type: object
  properties:
    method:
      type: string
      enum: ["GET", "POST", "PUT", "DELETE", "PATCH"]
      description: HTTP method.
    url:
      type: string
      description: Full URL including scheme (e.g. "http://localhost:7777/analyze"). May embed @vault:<key> refs.
    headers:
      type: object
      additionalProperties:
        type: string
      description: Request headers. Values may embed @vault:<key> refs (commonly "Authorization" = "Bearer @vault:cia_token").
    body:
      description: JSON-serializable request body. Ignored for GET/DELETE. Strings may embed @vault:<key> refs.
    query:
      type: object
      additionalProperties:
        type: string
      description: Query string parameters appended to `url`.
    timeout_ms:
      type: integer
      description: Abort after this many ms. Default 15000.
  required:
    - method
    - url
---

# http_call

범용 HTTP 호출 스킬. `@vault:<key>` 참조는 agent 레이어에서 미리 치환된 뒤 fetch 에 전달되므로 handler 는 치환을 신경쓰지 않아도 된다.

응답 형식 (항상 문자열 JSON):

```json
{
  "status": 200,
  "ok": true,
  "headers": { "content-type": "application/json; charset=utf-8" },
  "body": { /* JSON 파싱되면 object, 아니면 원문 문자열 */ }
}
```
