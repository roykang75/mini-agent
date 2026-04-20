# asyncio.gather() 예외 처리 완벽 정리

## 📌 당신의 요구사항

> "하나의 작업이 예외를 던지면 나머지 작업이 어떻게 되는지, 그리고 '한 개 실패해도 나머지는 끝까지 실행'시키려면 어떻게 해야 하는지"

### ✅ 정답

```python
results = await asyncio.gather(
    task1, task2, task3, task4,
    return_exceptions=True  # ← 이 한 줄!
)

# 결과 처리
for result in results:
    if isinstance(result, Exception):
        print(f"실패: {result}")
    else:
        print(f"성공: {result}")
```

---

## 🔍 세 가지 방식의 동작 비교

### 1️⃣ `gather()` 기본 — ❌ 사용 금지 (위험!)

```python
await asyncio.gather(task1, task2, task3)
```

**동작:**
- 하나의 task가 예외 발생 → **즉시 raise**
- 나머지 task는 **백그라운드에서 계속 실행** (문제!)
- 이미 완료된 task의 결과도 버려짐

**문제점:**
```
t=0.0초: task1(0.5초), fail(0.1초), task3(1.0초) 시작
t=0.1초: fail() 예외 발생 → 즉시 ValueError raise
         BUT task1과 task3는 여전히 실행 중!
         
[터미널 결과]
❌ 0.10초에 예외 catch: ValueError
   → task1은 백그라운드에서 0.5초 계속 실행
   → task3은 백그라운드에서 1.0초 계속 실행
```

**리소스 누수 위험:** 백그라운드에서 계속 실행되는 작업들이 정리되지 않음

---

### 2️⃣ `gather(return_exceptions=True)` — ✅ 권장 (당신의 요구사항)

```python
results = await asyncio.gather(
    task1, task2, task3,
    return_exceptions=True
)
```

**동작:**
- 모든 task가 **끝까지 실행**
- 예외를 **raise하지 않고** 결과 리스트에 Exception 객체로 포함
- 성공한 값과 예외를 함께 수집

**실제 동작:**
```
t=0.0초: task1(0.5초), fail(0.1초), task3(1.0초) 시작
t=0.1초: fail() 예외 발생 (하지만 raise 안 함)
t=0.5초: task1 완료
t=1.0초: task3 완료
         
[터미널 결과]
✓ 1.00초 후 모든 작업 완료
결과: [결과_task1, ValueError("예외 발생!"), 결과_task3]
```

**장점:**
- ✅ 모든 작업 끝까지 실행
- ✅ 성공한 결과 수집 가능
- ✅ 호출자가 결과를 명확히 구분
- ✅ 리소스 누수 없음

---

### 3️⃣ `TaskGroup()` (Python 3.11+) — ✅ 새 표준 (원자적 작업용)

```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(task1())
        tg.create_task(task2())
        tg.create_task(task3())
except ExceptionGroup as eg:
    print(f"예외: {eg.exceptions}")
```

**동작:**
- 하나의 task가 예외 발생 → **나머지 자동 취소** (CancelledError)
- 모두 정리된 뒤 **ExceptionGroup**으로 통합 raise
- "전부 성공이어야 의미 있는" 원자적 작업에 적합

**특징:**
- gather보다 구조적 동시성 보장
- DB 트랜잭션, 배포 등에 이상적
- Python 3.11+ 필수

---

## 📊 비교표

| 특성 | `gather()` | `gather(return_exceptions=True)` | `TaskGroup` |
|------|-----------|---------|-----------|
| **예외 발생 시 나머지 작업** | 백그라운드 계속(💥) | **모두 완료까지 대기** | 자동 취소 |
| **호출자에게 전파** | `raise` 즉시 | raise 없음 | `ExceptionGroup` |
| **결과 반환** | 첫 예외 시 폐기 | 리스트 (값+예외 혼합) | 개별 조회 |
| **모든 작업 완료까지 대기** | ❌ | ✅ **YES** | ✅ YES |
| **완료 시간** | 0.1초 (fail 시점) | 1.0초 (최장) | 0.1초 (fail 시점) |
| **추천 용도** | (거의 없음) | **웹 요청, API 호출** | 트랜잭션, 배포 |
| **Python 버전** | 3.7+ | 3.7+ | 3.11+ |

---

## 💡 사용 시나리오별 선택

### A. 웹 스크래핑 (여러 URL 동시 다운로드)
```python
urls = ["http://a.com", "http://b.com", ..., "http://j.com"]
results = await asyncio.gather(
    *[fetch(url) for url in urls],
    return_exceptions=True  # ← 선택
)
successful = [r for r in results if not isinstance(r, Exception)]
# 일부 URL 실패해도 다운로드된 것부터 처리 가능
```

**선택 이유:** 작업이 독립적, 부분 성공으로 충분

---

### B. 데이터베이스 일괄 업데이트
```python
async with asyncio.TaskGroup() as tg:
    tg.create_task(update_user(id1, data1))
    tg.create_task(update_user(id2, data2))
    tg.create_task(update_user(id3, data3))
# 하나 실패 → 모두 롤백
```

**선택 이유:** 원자적(all-or-nothing) 동작 필요, 트랜잭션

---

### C. 서버 시작 시 초기화
```python
async with asyncio.TaskGroup() as tg:
    tg.create_task(load_config())
    tg.create_task(connect_db())
    tg.create_task(warmup_cache())
# 하나라도 실패 → 서버 시작 실패
```

**선택 이유:** 상호의존성 있음, 부분 상태는 무의미

---

### D. API 병렬 호출 (마이크로서비스)
```python
results = await asyncio.gather(
    fetch_user_api(),
    fetch_product_api(),
    fetch_order_api(),
    return_exceptions=True  # ← 선택
)
# Product API 실패해도 User, Order API 결과는 활용
```

**선택 이유:** 마이크로서비스 간 독립성, 부분 로딩 가능

---

## ⚠️ 주의사항

### 주의 1: 기본 `gather()`는 정말 위험합니다

```python
# ❌ 절대 금지!
try:
    await asyncio.gather(task1, task2, task3)
except ValueError:
    print("예외 처리됨")
    # 하지만 task1, task2, task3은 여전히 백그라운드에서 실행 중!
```

해결책: **명시적으로 `return_exceptions=True` 사용 또는 TaskGroup 사용**

---

### 주의 2: `return_exceptions=True`일 때 CancelledError

```python
results = await asyncio.gather(
    task1, task2, task3,
    return_exceptions=True
)

for r in results:
    if isinstance(r, asyncio.CancelledError):
        # 작업이 cancel()된 경우
        pass
```

---

### 주의 3: TaskGroup의 ExceptionGroup 처리

```python
try:
    async with asyncio.TaskGroup() as tg:
        tg.create_task(operation1())
        tg.create_task(operation2())
except ExceptionGroup as eg:  # 구조화된 예외
    # 여러 예외를 한 번에 처리
    for exc in eg.exceptions:
        print(exc)

# 특정 예외만 처리하고 싶으면:
except* ValueError as eg:  # ← 'except*' 문법!
    print(f"ValueError들: {eg.exceptions}")
```

---

## 🎯 빠른 참조 (복사-붙여넣기)

### "한 개 실패해도 나머지는 끝까지" (권장 패턴)

```python
async def main():
    # 방법 1: return_exceptions=True (권장)
    results = await asyncio.gather(
        operation1(), operation2(), operation3(),
        return_exceptions=True
    )
    
    # 결과 분류
    for result in results:
        if isinstance(result, Exception):
            logger.error(f"작업 실패: {result}")
        else:
            logger.info(f"작업 성공: {result}")
    
    return results
```

### "하나 실패 시 전부 취소" (원자적 작업)

```python
async def main():
    # 방법 2: TaskGroup (Python 3.11+)
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(critical_operation1())
            tg.create_task(critical_operation2())
            tg.create_task(critical_operation3())
    except ExceptionGroup as eg:
        logger.error(f"작업 그룹 실패: {eg.exceptions}")
        # 모든 작업이 자동 취소됨
```

---

## 📚 실행 결과 분석

생성된 파일에서 실제 동작을 확인하세요:

1. **asyncio_gather_exceptions.py** - 3가지 방식의 기본 동작
   ```bash
   python asyncio_gather_exceptions.py
   ```
   
2. **asyncio_practical_examples.py** - 실전 패턴 5가지
   - 예제 1: API 병렬 호출
   - 예제 2: 배치 처리
   - 예제 3: 폴백 로직
   - 예제 4: 타임아웃
   - 예제 5: 워커 패턴

3. **asyncio_decision_guide.md** - 선택 가이드 (상세)

---

## 🏆 최종 결론

| 상황 | 추천 | 이유 |
|------|------|------|
| **"한 개 실패해도 나머지는 끝까지"** | **`return_exceptions=True`** | 모든 작업 완료, 부분 결과 수집 가능 |
| **"하나 실패하면 전부 취소"** | **`TaskGroup`** (3.11+) | 원자적 실행, 자동 정리 |
| **독립적인 작업들** (웹 요청, 크롤링) | **`return_exceptions=True`** | 최대한 많은 데이터 수집 |
| **상호의존적 작업** (DB, 배포) | **`TaskGroup`** | 일관성 보장, 롤백 가능 |
| **Python 3.10 이하** | **`return_exceptions=True`** | TaskGroup 미지원 |
| **기본 `gather()`** | **사용하지 말 것** | 리소스 누수 위험 |

---

## 📖 학습 팁

1. **이해하기:** 기본 gather()의 위험성을 먼저 이해
2. **선택하기:** 당신의 작업이 독립적인지 의존적인지 판단
3. **코딩하기:** return_exceptions=True 또는 TaskGroup 사용
4. **테스트하기:** 예외가 발생했을 때 실제 동작 확인

---

## 참고 자료

- [Python asyncio 공식 문서](https://docs.python.org/3/library/asyncio-task.html)
- [PEP 654 - Exception Groups](https://www.python.org/dev/peps/pep-0654/)
- [Structured Concurrency](https://en.wikipedia.org/wiki/Structured_concurrency)
