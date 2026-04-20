# asyncio 예외 처리 완벽 가이드

## 🎯 핵심 요약

당신의 요구사항: **"한 개 실패해도 나머지는 끝까지 실행"**
→ **`gather(return_exceptions=True)` 사용** ✓

---

## 📊 세 가지 방식의 동작 비교

| 측면 | `gather()` 기본 | `gather(return_exceptions=True)` | `TaskGroup` (3.11+) |
|------|---|---|---|
| **예외 발생 시 나머지 작업** | 백그라운드에서 계속 실행(💥 누수 위험) | **모두 끝까지 실행** | 자동으로 취소됨 |
| **호출자에게 전파** | `raise` (첫 예외 즉시) | `raise` 없음 | `ExceptionGroup`으로 통합 |
| **결과 수집 방식** | 첫 예외 시 폐기 | **예외/성공 혼합 리스트** | 개별 조회(수동) |
| **모든 작업 완료까지 대기** | ❌ | ✅ **YES** | ✅ YES |
| **타이밍** | 0.1초 (fail 시점) | 1.0초 (최장 작업) | 0.1초 (fail 시점) |
| **실행 예시 결과** | `ValueError` raise | `[결과_A, ValueError(...), 결과_B]` | `ExceptionGroup(ValueError)` |

---

## 🔍 실제 동작 예시 (위 실행 결과 분석)

### 1️⃣ `gather()` — ❌ 위험 (사용 금지)

```
[기본 동작]
t=0.0초: A 시작, fail 시작, B 시작
t=0.1초: ❌ ValueError 예외 발생 → 즉시 raise
           A는 여전히 0.5초 대기 중 ← 💥 누수!
           B는 여전히 1.0초 대기 중 ← 💥 누수!
t=0.5초: A 백그라운드에서 완료 (하지만 결과는 이미 버려짐)
t=1.0초: B 백그라운드에서 완료
```

**문제점:**
- 호출자는 0.1초에 예외를 받지만, A, B는 여전히 실행 중
- `await asyncio.sleep(1.5)` 같은 대기가 필요 → 복잡하고 오류 유발
- 결과를 받지 못함

---

### 2️⃣ `gather(return_exceptions=True)` — ✅ 권장

```
[깔끔한 동작]
t=0.0초: A 시작, fail 시작, B 시작
t=0.1초: fail이 ValueError 발생 (하지만 raise하지 않음)
t=1.0초: 모든 작업 완료 (A와 B도 정상 완료)
         → 결과: [결과_A, ValueError(...), 결과_B]
```

**장점:**
- 모든 작업이 끝까지 실행됨 ✓
- 성공한 결과도 수집 ✓
- 호출자가 명확하게 구분 가능 ✓

```python
results = await asyncio.gather(
    fetch("A"), fetch("B"), fetch("C"),
    return_exceptions=True
)

# 결과 처리
for r in results:
    if isinstance(r, Exception):
        print(f"실패: {r}")
    else:
        print(f"성공: {r}")
```

---

### 3️⃣ `TaskGroup()` — ✅ 새 표준 (원자적 작업용)

```
[취소 기반 동작]
t=0.0초: A 시작, fail 시작, B 시작
t=0.1초: fail이 ValueError 발생
         → A, B에 CancelledError 발생 (즉시 취소)
t=0.1초: ExceptionGroup으로 모두 정리된 후 raise
```

**용도:**
- 데이터베이스 트랜잭션 (하나 실패 시 전부 롤백)
- 배포/마이그레이션 (하나 실패 시 전부 중단)

```python
async with asyncio.TaskGroup() as tg:
    tg.create_task(query1())
    tg.create_task(query2())
    tg.create_task(query3())
# 하나라도 실패 → 전부 취소됨
```

---

## 🚀 사용 시나리오별 선택

### 시나리오 A: 웹 스크래핑 (10개 URL 동시 다운로드)
```python
# ✅ 여러 URL이 실패해도 나머지는 계속 받기
urls = ["http://a.com", "http://b.com", ..., "http://j.com"]
results = await asyncio.gather(
    *[fetch(url) for url in urls],
    return_exceptions=True
)
successful = [r for r in results if not isinstance(r, Exception)]
```
→ **return_exceptions=True** 선택 이유: 독립적 요청, 부분 성공으로 충분

---

### 시나리오 B: 데이터베이스 일괄 업데이트
```python
# ❌ 하나라도 실패하면 전부 롤백해야 함
async with asyncio.TaskGroup() as tg:
    tg.create_task(update_user(id1, data1))
    tg.create_task(update_user(id2, data2))
    tg.create_task(update_user(id3, data3))
# 하나 실패 → 트랜잭션 전체 롤백
```
→ **TaskGroup** 선택 이유: 원자적(all-or-nothing) 동작 필요

---

### 시나리오 C: 서버 시작 시 여러 초기화
```python
# "부분 초기화" 도 불가능 → 전부 성공이어야 함
async with asyncio.TaskGroup() as tg:
    tg.create_task(load_config())
    tg.create_task(connect_db())
    tg.create_task(warmup_cache())
# 하나라도 실패 → 서버 시작 실패
```
→ **TaskGroup** 선택 이유: 의존성 있음, 부분 상태는 무의미

---

## 📝 빠른 참조 (복사-붙여넣기)

### "한 개 실패해도 나머지는 끝까지" (독립적 작업)
```python
results = await asyncio.gather(
    task1, task2, task3, task4,
    return_exceptions=True  # 👈 이 한 줄!
)

# 결과 처리
for result in results:
    if isinstance(result, Exception):
        logger.error(f"작업 실패: {result}")
    else:
        logger.info(f"작업 성공: {result}")
```

### "하나 실패 시 전부 취소" (원자적 작업)
```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(operation1())
        tg.create_task(operation2())
        tg.create_task(operation3())
except ExceptionGroup as eg:
    print(f"작업 그룹 실패: {eg}")
    # 자동으로 모든 작업이 취소됨
```

---

## ⚠️ 주의사항

### 주의 1: `gather()` 기본은 위험
```python
# ❌ 절대 금지!
await asyncio.gather(task1, task2, task3)

# task1, task2, task3 중 하나라도 예외 발생 시:
# - 예외는 즉시 raise
# - 나머지 task는 백그라운드에서 계속 실행 (누수!)
# - 결과도 폐기됨
```

### 주의 2: `return_exceptions=True`와 CancelledError
```python
results = await asyncio.gather(
    task1, task2, task3,
    return_exceptions=True
)

# results에 포함될 수 있는 예외:
# - 원래 발생한 예외: ValueError, ConnectionError, ...
# - 외부에서 cancel()된 경우: CancelledError도 포함
```

### 주의 3: TaskGroup의 ExceptionGroup 처리
```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(task1())
        tg.create_task(task2())
except* ValueError as eg:  # ← 'except*' 문법! (구조화된 예외)
    print(f"ValueError 예외들: {eg.exceptions}")
except* RuntimeError as eg:
    print(f"RuntimeError 예외들: {eg.exceptions}")
```

---

## 🏆 결론

| 상황 | 선택 | 이유 |
|------|------|------|
| **웹 요청, API 호출, 데이터 다운로드** | `gather(return_exceptions=True)` | 작업이 독립적, 부분 성공 가능 |
| **DB 트랜잭션, 배포, 상호의존 작업** | `TaskGroup` (3.11+) | 원자적 실행 필요 |
| **Python 3.10 이하** | `gather(return_exceptions=True)` | TaskGroup 미지원 |
| **절대 금지** | `gather()` 기본 | 리소스 누수, 결과 폐기 |

**당신의 요구사항 "한 개 실패해도 나머지는 끝까지"** → 🎯 **`return_exceptions=True`** 확정!
