# notes — 참고 학습 자료

mini-agent 는 TypeScript/Next.js 프로젝트이지만, **독립 작업 병렬 실행 + 실패 처리** 같은 일반 concurrency 패턴은 언어 무관하게 유용한 설계 자료. 여기에는 그런 참고 노트가 모인다.

## 인덱스

### asyncio 예외 처리 (Python)

- [`ASYNCIO_SUMMARY.md`](./ASYNCIO_SUMMARY.md) — gather vs TaskGroup 상세 가이드, 시나리오별 선택
- [`QUICK_REFERENCE.txt`](./QUICK_REFERENCE.txt) — 터미널용 치트시트 (아스키 박스)
- [`asyncio_decision_guide.md`](./asyncio_decision_guide.md) — 의사결정 매트릭스
- [`asyncio_gather_exceptions.py`](./asyncio_gather_exceptions.py) — 실행 가능 예제 (3 방식 비교)
- [`asyncio_practical_examples.py`](./asyncio_practical_examples.py) — 실전 패턴 (API 병렬 / 배치 / 폴백 / 타임아웃 / 워커)

> **핵심 교훈**: "한 개 실패해도 나머지는 끝까지" = `gather(return_exceptions=True)`. "하나 실패 시 전부 취소" = `TaskGroup`. mini-agent 의 tool_approval batch / advisor 병렬 호출 등 유사 구조 설계 시 참고.
