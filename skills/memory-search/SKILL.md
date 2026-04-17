---
name: memory_search
description: "Search past agent-memory episodes by keyword(s). Returns up to `limit` matching episodes with id, title, persona, outcome, topic_tags, started, excerpt, and path. Use this to recall prior decisions, prior bugs, or prior solutions BEFORE re-deriving them. Returns empty list when nothing matches — treat that as 'no prior experience on this topic'."
input_schema:
  type: object
  properties:
    query:
      type: string
      description: "Korean or English keywords. Multi-word is treated as token bag — each token contributes to score (title ×3, tags ×2, body ×1)."
    limit:
      type: integer
      description: "Max results to return. Default 3, max 10."
    outcome:
      type: string
      enum: ["resolved", "open", "failed"]
      description: "Optional filter — e.g. only 'resolved' decisions."
    persona:
      type: string
      description: "Optional filter by persona (e.g. 'cia-analyst')."
  required:
    - query
---

# memory_search

과거 세션의 episode 를 제목·태그·본문 기반으로 검색한다. 단순 token
scoring (title ×3, tags ×2, body ×1) + 최신성 tie-break.

응답은 JSON 문자열:

```json
{
  "query": "CIA 토큰",
  "count": 2,
  "results": [
    {
      "id": "e173240b7e3e19d4",
      "title": "CIA 서비스로 abc1234..def5678 커밋 영향도 분석",
      "session_id": "20260417T140609Z-1c908240",
      "persona": "cia-analyst",
      "outcome": "resolved",
      "started": "2026-04-17T14:06:09.725Z",
      "topic_tags": ["cia", "impact-analysis"],
      "score": 7,
      "matched": ["CIA", "토큰"],
      "excerpt": "...",
      "path": "/Users/.../episodes/2026-04-17-....md"
    }
  ]
}
```

`AGENT_MEMORY_DIR` 미설정 시 `{ "error": "agent_memory_unconfigured" }` 를 반환한다.
