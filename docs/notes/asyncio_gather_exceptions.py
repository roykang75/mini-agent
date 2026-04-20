"""
asyncio.gather() 예외 처리 패턴 완벽 정리
"""

import asyncio
import time

async def ok(name, delay):
    """정상적으로 완료되는 작업"""
    print(f"[{time.time():.2f}] {name} 시작")
    await asyncio.sleep(delay)
    print(f"[{time.time():.2f}] {name} 완료")
    return f"결과_{name}"

async def fail():
    """예외를 던지는 작업"""
    print(f"[{time.time():.2f}] fail 시작 (0.1초 후 실패)")
    await asyncio.sleep(0.1)
    raise ValueError("예외 발생!")

# ============================================================================
# 1. gather() 기본 동작 — 첫 예외 즉시 전파, 나머지는 백그라운드에서 계속 실행
# ============================================================================
async def example1_basic_gather():
    """기본 gather: 예외 발생 시 호출자에게 즉시 raise, 나머지는 계속 돌아감"""
    print("\n" + "="*70)
    print("예제 1: gather() 기본 — 예외 즉시 전파, 나머지는 백그라운드 실행")
    print("="*70)
    
    start = time.time()
    try:
        results = await asyncio.gather(
            ok("A", 0.5),
            fail(),          # 0.1초 후 예외 발생
            ok("B", 1.0)
        )
        print(f"결과: {results}")
    except ValueError as e:
        elapsed = time.time() - start
        print(f"❌ {elapsed:.2f}초에 예외 catch: {e}")
        print("   → 주의: A는 백그라운드에서 여전히 0.5초 실행 중, B도 1.0초 실행 중")
    
    # 나머지 작업이 끝날 때까지 대기
    await asyncio.sleep(1.5)
    print("(모든 task 완료 대기 후 종료)")

# ============================================================================
# 2. gather(return_exceptions=True) — 모든 task 완료, 예외는 값으로 반환
# ============================================================================
async def example2_return_exceptions():
    """
    return_exceptions=True: 
    - 모든 task가 끝날 때까지 대기
    - 예외를 raise하지 않고 결과 리스트에 포함
    - "한 개 실패해도 나머지는 끝까지" 실행하는 Best Practice
    """
    print("\n" + "="*70)
    print("예제 2: gather(return_exceptions=True) — 모두 완료, 예외는 값으로")
    print("="*70)
    
    start = time.time()
    results = await asyncio.gather(
        ok("A", 0.5),
        fail(),          # 0.1초 후 예외 발생
        ok("B", 1.0),
        return_exceptions=True  # ← 핵심: 예외를 raise하지 않음
    )
    elapsed = time.time() - start
    
    print(f"\n✓ {elapsed:.2f}초 후 모든 작업 완료")
    print(f"결과 리스트: {results}")
    
    # 결과 처리 예제
    print("\n결과 분석:")
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            print(f"  [{i}] 실패: {type(r).__name__}: {r}")
        else:
            print(f"  [{i}] 성공: {r}")

# ============================================================================
# 3. TaskGroup (Python 3.11+) — 하나 실패 시 나머지 자동 취소 (원자적 실행)
# ============================================================================
async def example3_taskgroup():
    """
    TaskGroup: 
    - 하나의 task 예외 → 형제 task들 자동 CancelledError 취소
    - 모두 정리된 뒤 ExceptionGroup으로 예외 통합 전파
    - "전부 성공해야 의미 있는" 원자적 작업에 적합
    """
    print("\n" + "="*70)
    print("예제 3: TaskGroup (Python 3.11+) — 하나 실패 → 전부 취소")
    print("="*70)
    
    start = time.time()
    try:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(ok("A", 0.5))
            tg.create_task(fail())        # 0.1초 후 예외 발생
            tg.create_task(ok("B", 1.0))  # 즉시 취소됨
    except ExceptionGroup as eg:
        elapsed = time.time() - start
        print(f"\n❌ {elapsed:.2f}초에 ExceptionGroup 발생")
        print(f"예외 수: {len(eg.exceptions)}")
        for exc in eg.exceptions:
            if isinstance(exc, asyncio.CancelledError):
                print(f"  - {type(exc).__name__} (자동 취소)")
            else:
                print(f"  - {type(exc).__name__}: {exc}")

# ============================================================================
# 4. 실용 예제: 웹 요청 여러 개 동시 실행 (독립적이므로 return_exceptions 권장)
# ============================================================================
async def fetch_url(name, delay, should_fail=False):
    """URL fetch 시뮬레이션"""
    print(f"[{time.time():.2f}] {name} 요청 시작")
    await asyncio.sleep(delay)
    if should_fail:
        raise ConnectionError(f"{name} 연결 실패")
    print(f"[{time.time():.2f}] {name} 응답 수신")
    return f"{name}의 데이터"

async def example4_practical_web_requests():
    """실전 패턴: 여러 웹 요청을 동시에 실행, 일부 실패해도 계속"""
    print("\n" + "="*70)
    print("예제 4: 실전 — 웹 요청 여러 개 (일부 실패 허용)")
    print("="*70)
    
    results = await asyncio.gather(
        fetch_url("API-1", 0.3, should_fail=False),
        fetch_url("API-2", 0.2, should_fail=True),   # 실패
        fetch_url("API-3", 0.4, should_fail=False),
        fetch_url("API-4", 0.1, should_fail=True),   # 실패
        return_exceptions=True
    )
    
    print("\n수집된 결과:")
    successful = []
    failed = []
    for r in results:
        if isinstance(r, Exception):
            failed.append(r)
        else:
            successful.append(r)
    
    print(f"✓ 성공 ({len(successful)}개): {successful}")
    print(f"❌ 실패 ({len(failed)}개): {[str(e) for e in failed]}")
    print(f"부분 성공으로 계속 진행 가능 ✓")

# ============================================================================
# 5. 비교: 같은 시나리오에서 세 방식의 차이
# ============================================================================
async def example5_comparison():
    """세 가지 방식을 같은 시나리오로 비교"""
    print("\n" + "="*70)
    print("예제 5: 세 방식 비교 요약")
    print("="*70)
    
    print("""
1️⃣ gather() 기본 (추천 안 함)
   - 호출: await asyncio.gather(t1, t2, t3)
   - 문제: 첫 예외 발생 시 즉시 raise → 나머지 작업은 백그라운드에서 계속 실행
   - 결과: 결과 손실, 리소스 누수 위험 ⚠️

2️⃣ gather(return_exceptions=True) 👍 권장
   - 호출: await asyncio.gather(t1, t2, t3, return_exceptions=True)
   - 효과: 모든 작업 끝까지 기다림, 예외는 리스트의 값으로 반환
   - 이상적: "독립적 작업을 최대한 수집" (웹 크롤링, API 병렬 호출 등)

3️⃣ TaskGroup() (Python 3.11+) 👍 새 표준
   - 호출: async with asyncio.TaskGroup() as tg: ...
   - 효과: 하나 실패 → 나머지 자동 취소, 예외 통합
   - 이상적: "전부 성공이어야 의미" (DB 트랜잭션, 배포 절차 등)
    """)

# ============================================================================
async def main():
    """모든 예제 실행"""
    await example1_basic_gather()
    await example2_return_exceptions()
    await example3_taskgroup()
    await example4_practical_web_requests()
    await example5_comparison()

if __name__ == "__main__":
    asyncio.run(main())
