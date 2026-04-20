"""
asyncio 예외 처리: 실전 패턴들
"""

import asyncio
import random
from datetime import datetime


def log(msg):
    """시간 스탬프와 함께 로그"""
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}")


# =============================================================================
# 예제 1: API 병렬 호출 (일부 실패 허용)
# =============================================================================

async def call_api(api_name: str, delay: float, fail_probability: float = 0.0):
    """API 호출 시뮬레이션"""
    log(f"📤 {api_name} 호출 시작")
    await asyncio.sleep(delay)
    
    if random.random() < fail_probability:
        raise ConnectionError(f"{api_name} 타임아웃")
    
    log(f"📥 {api_name} 응답 수신")
    return {"api": api_name, "data": f"data_from_{api_name}"}


async def example1_parallel_api_calls():
    """
    시나리오: 여러 마이크로서비스에서 데이터를 동시에 가져올 때
    요구사항: 일부 서비스 장애해도 사용 가능한 것부터 먼저 처리
    """
    print("\n" + "="*70)
    print("예제 1: API 병렬 호출 (부분 성공 처리)")
    print("="*70)
    
    # 동시에 5개 API 호출, 각각 실패 확률 30%
    results = await asyncio.gather(
        call_api("UserAPI", 0.3, fail_probability=0.3),
        call_api("ProductAPI", 0.2, fail_probability=0.3),
        call_api("OrderAPI", 0.4, fail_probability=0.3),
        call_api("AnalyticsAPI", 0.1, fail_probability=0.3),
        call_api("PaymentAPI", 0.25, fail_probability=0.3),
        return_exceptions=True  # ← 핵심: 예외를 값으로 처리
    )
    
    # 결과 분류
    successful = {}
    failed = []
    
    for result in results:
        if isinstance(result, Exception):
            failed.append(str(result))
        else:
            successful[result["api"]] = result["data"]
    
    print(f"\n✅ 성공한 API ({len(successful)}개):")
    for api, data in successful.items():
        print(f"   - {api}: {data}")
    
    print(f"\n❌ 실패한 API ({len(failed)}개):")
    for error in failed:
        print(f"   - {error}")
    
    # 부분 성공으로도 계속 진행 가능
    if successful:
        print(f"\n→ 수집된 데이터로 페이지 렌더링 가능 (부분 로딩)")
    else:
        print(f"\n→ 모두 실패 시에만 에러 페이지 표시")
    
    return successful, failed


# =============================================================================
# 예제 2: 배치 작업 (모든 아이템 처리, 일부 실패 로깅)
# =============================================================================

async def process_item(item_id: int, processing_time: float = 0.1):
    """개별 아이템 처리"""
    log(f"⚙️  Item #{item_id} 처리 중")
    await asyncio.sleep(processing_time)
    
    # 20% 확률로 실패
    if random.random() < 0.2:
        raise ValueError(f"Item #{item_id} 검증 실패")
    
    log(f"✓ Item #{item_id} 처리 완료")
    return {"item_id": item_id, "status": "processed"}


async def example2_batch_processing():
    """
    시나리오: 100개 파일을 동시에 처리하되, 일부 실패해도 나머지는 계속
    요구사항: 최대한 많은 아이템 처리, 실패 아이템만 재시도
    """
    print("\n" + "="*70)
    print("예제 2: 배치 처리 (일부 실패, 재시도 대상 분류)")
    print("="*70)
    
    items = list(range(1, 11))  # 10개 아이템
    
    log(f"📦 {len(items)}개 아이템 동시 처리 시작")
    
    results = await asyncio.gather(
        *[process_item(item_id) for item_id in items],
        return_exceptions=True
    )
    
    # 결과 분류
    processed = []
    failed = []
    
    for item_id, result in zip(items, results):
        if isinstance(result, Exception):
            failed.append({"item_id": item_id, "error": str(result)})
        else:
            processed.append(result)
    
    print(f"\n📊 처리 결과:")
    print(f"   ✅ 성공: {len(processed)}개 / {len(items)}개")
    print(f"   ❌ 실패: {len(failed)}개 / {len(items)}개")
    
    if failed:
        print(f"\n🔄 재시도 대상:")
        for item in failed:
            print(f"   - {item}")
        
        # 재시도 로직
        print(f"\n→ 재시도 예약: 대기열에 추가...")
    
    return {"processed": processed, "failed": failed}


# =============================================================================
# 예제 3: 폴백 로직 (Primary 실패 시 Secondary 시도)
# =============================================================================

async def fetch_from_primary(data_id: str):
    """주 데이터 소스"""
    log(f"🔗 Primary 소스에서 {data_id} 조회")
    await asyncio.sleep(0.2)
    if random.random() < 0.5:  # 50% 실패율
        raise ConnectionError(f"Primary 데이터 소스 접근 불가")
    return f"primary_{data_id}"


async def fetch_from_secondary(data_id: str):
    """보조 데이터 소스 (Primary 실패 시)"""
    log(f"🔗 Secondary 소스에서 {data_id} 조회")
    await asyncio.sleep(0.1)
    if random.random() < 0.2:  # 20% 실패율
        raise ConnectionError(f"Secondary 데이터 소스 접근 불가")
    return f"secondary_{data_id}"


async def fetch_with_fallback(data_id: str):
    """Primary 실패 시 Secondary로 폴백"""
    try:
        result = await fetch_from_primary(data_id)
        log(f"✅ {data_id}: Primary에서 획득")
        return result
    except ConnectionError:
        log(f"⚠️  {data_id}: Primary 실패, Secondary 시도")
        try:
            result = await fetch_from_secondary(data_id)
            log(f"✅ {data_id}: Secondary에서 획득")
            return result
        except ConnectionError:
            log(f"❌ {data_id}: 모든 소스 실패")
            raise


async def example3_fallback_strategy():
    """
    시나리오: Primary와 Secondary 데이터 소스 활용
    요구사항: Primary 실패 시 Secondary로 자동 폴백
    """
    print("\n" + "="*70)
    print("예제 3: 폴백 로직 (Primary → Secondary)")
    print("="*70)
    
    data_ids = ["user_1", "user_2", "user_3", "user_4"]
    
    results = await asyncio.gather(
        *[fetch_with_fallback(data_id) for data_id in data_ids],
        return_exceptions=True
    )
    
    print(f"\n📊 조회 결과:")
    for data_id, result in zip(data_ids, results):
        if isinstance(result, Exception):
            print(f"   ❌ {data_id}: {result}")
        else:
            print(f"   ✅ {data_id}: {result}")


# =============================================================================
# 예제 4: 타임아웃과 함께 사용
# =============================================================================

async def long_running_task(task_id: int, duration: float):
    """오래 걸리는 작업"""
    log(f"⏳ Task #{task_id} 시작 ({duration:.1f}초)")
    try:
        await asyncio.sleep(duration)
        log(f"✓ Task #{task_id} 완료")
        return f"result_{task_id}"
    except asyncio.CancelledError:
        log(f"⏱️  Task #{task_id} 타임아웃 취소됨")
        raise


async def example4_with_timeout():
    """
    시나리오: 여러 작업을 동시에 실행, 전체 타임아웃은 1초
    요구사항: 1초 내 완료되는 작업들만 수집
    """
    print("\n" + "="*70)
    print("예제 4: 타임아웃과 함께 사용")
    print("="*70)
    
    try:
        # 전체 gather에 타임아웃 적용
        results = await asyncio.wait_for(
            asyncio.gather(
                long_running_task(1, 0.3),
                long_running_task(2, 0.8),
                long_running_task(3, 1.5),  # 1초 초과
                long_running_task(4, 0.5),
                return_exceptions=True
            ),
            timeout=1.0
        )
        print(f"결과: {results}")
    except asyncio.TimeoutError:
        log("🛑 전체 작업이 1초 내 완료되지 않음 (예상된 동작)")
        print("💡 Tip: 개별 작업에 wait_for()를 적용하면 더 세밀한 제어 가능")


# =============================================================================
# 예제 5: 큐를 사용한 워커 패턴 (gather는 아니지만 비슷한 구조)
# =============================================================================

async def queue_worker(worker_id: int, queue: asyncio.Queue):
    """큐에서 작업을 가져와 처리"""
    while True:
        try:
            item = queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        
        log(f"Worker #{worker_id} 처리 중: {item}")
        await asyncio.sleep(random.uniform(0.1, 0.3))
        
        if random.random() < 0.2:
            log(f"Worker #{worker_id} 실패: {item}")
        else:
            log(f"Worker #{worker_id} 완료: {item}")
        
        queue.task_done()


async def example5_worker_pattern():
    """
    시나리오: 여러 워커가 큐의 작업을 병렬 처리
    특징: gather와 다르게, 동적으로 작업 추가 가능
    """
    print("\n" + "="*70)
    print("예제 5: 워커 패턴 (queue + gather 조합)")
    print("="*70)
    
    # 작업 큐 생성
    work_queue = asyncio.Queue()
    for i in range(1, 11):
        work_queue.put(f"job_{i}")
    
    log(f"📋 큐에 {work_queue.qsize()}개 작업 추가")
    
    # 4개 워커 동시 실행
    workers = await asyncio.gather(
        queue_worker(1, work_queue),
        queue_worker(2, work_queue),
        queue_worker(3, work_queue),
        queue_worker(4, work_queue),
        return_exceptions=True
    )
    
    log(f"모든 워커 작업 완료")


# =============================================================================
# 메인
# =============================================================================

async def main():
    """모든 예제 실행"""
    random.seed(42)  # 재현 가능하게
    
    await example1_parallel_api_calls()
    
    await example2_batch_processing()
    
    await example3_fallback_strategy()
    
    await example4_with_timeout()
    
    await example5_worker_pattern()
    
    print("\n" + "="*70)
    print("모든 예제 완료!")
    print("="*70)


if __name__ == "__main__":
    asyncio.run(main())
