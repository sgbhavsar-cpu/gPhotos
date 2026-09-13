import { responseTracker, trackBackendCall } from '../src/renderer/src/services/responseTracker';

async function runResponseTrackerTest() {
  console.log('================================================================');
  console.log('⚡ BENCHMARK & VERIFICATION: 20-50MS LATENCY & CANCELLATION');
  console.log('================================================================\n');

  try {
    // ------------------------------------------------------------------------
    // Step 1: Initial state verification
    // ------------------------------------------------------------------------
    console.log('🔍 Step 1: Verifying Idle State...');
    responseTracker.clearAll();
    let state = responseTracker.getState();
    console.log(`  Initial State: activeCount=${state.activeCount}, isWaitingBackend=${state.isWaitingBackend}`);
    if (state.activeCount !== 0 || state.isWaitingBackend) {
      throw new Error('Initial state should be idle with isWaitingBackend=false');
    }
    console.log('  ✓ Initial state confirmed idle.');

    // ------------------------------------------------------------------------
    // Step 2: Fast Operation (< 20ms) should NOT trigger indicator
    // ------------------------------------------------------------------------
    console.log('\n🚀 Step 2: Testing Fast-Path Operation (10ms < 20ms)...');
    let triggeredInFastPath = false;
    const unsubFast = responseTracker.subscribe((s) => {
      if (s.isWaitingBackend) triggeredInFastPath = true;
    });

    await trackBackendCall(
      new Promise((resolve) => setTimeout(resolve, 10)),
      'Instant fast-path operation'
    );
    unsubFast();

    state = responseTracker.getState();
    console.log(`  After 10ms Fast Op: triggeredInFastPath=${triggeredInFastPath}, isWaitingBackend=${state.isWaitingBackend}`);
    if (triggeredInFastPath || state.isWaitingBackend) {
      throw new Error('Fast operation (< 20ms) must NOT trigger isWaitingBackend!');
    }
    console.log('  ✓ Fast operation completed with 0 visual flicker (isWaitingBackend stayed false).');

    // ------------------------------------------------------------------------
    // Step 3: Delayed Operation (> 35ms) MUST trigger indicator and hide on completion
    // ------------------------------------------------------------------------
    console.log('\n⏱️ Step 3: Testing Delayed Operation (80ms > 35ms)...');
    let sawWaitingBackend = false;
    let sawCorrectLabel = false;

    const unsubDelayed = responseTracker.subscribe((s) => {
      if (s.isWaitingBackend) {
        sawWaitingBackend = true;
        if (s.label === 'Scanning photos from disk') {
          sawCorrectLabel = true;
        }
      }
    });

    const delayedPromise = trackBackendCall(
      new Promise((resolve) => setTimeout(resolve, 80)),
      'Scanning photos from disk'
    );

    // Check state at 45ms (within 20-50ms window, should now be active)
    await new Promise((r) => setTimeout(r, 45));
    const midState = responseTracker.getState();
    console.log(`  At 45ms during active call: isWaitingBackend=${midState.isWaitingBackend}, label="${midState.label}"`);
    if (!midState.isWaitingBackend) {
      throw new Error('Expected isWaitingBackend to be true at 45ms for an 80ms operation!');
    }

    await delayedPromise;
    unsubDelayed();

    state = responseTracker.getState();
    console.log(`  After completion: sawWaitingBackend=${sawWaitingBackend}, sawCorrectLabel=${sawCorrectLabel}, activeCount=${state.activeCount}, isWaitingBackend=${state.isWaitingBackend}`);
    if (!sawWaitingBackend || !sawCorrectLabel) {
      throw new Error('Delayed operation failed to emit isWaitingBackend or correct label');
    }
    if (state.activeCount !== 0 || state.isWaitingBackend) {
      throw new Error('State did not reset to idle after delayed operation finished');
    }
    console.log('  ✓ Delayed operation (> 35ms) triggered wait icon and immediately removed/hid it on completion.');

    // ------------------------------------------------------------------------
    // Step 4: Multi-Operation Concurrent Tracking
    // ------------------------------------------------------------------------
    console.log('\n🔄 Step 4: Testing Concurrent Operation Counting...');
    const endOp1 = responseTracker.startOperation('Task 1');
    const endOp2 = responseTracker.startOperation('Task 2');

    state = responseTracker.getState();
    console.log(`  Active concurrent ops: ${state.activeCount}`);
    if (state.activeCount !== 2) {
      throw new Error(`Expected 2 active operations, got ${state.activeCount}`);
    }

    endOp1();
    state = responseTracker.getState();
    if (state.activeCount !== 1) {
      throw new Error(`Expected 1 active operation remaining, got ${state.activeCount}`);
    }

    endOp2();
    state = responseTracker.getState();
    if (state.activeCount !== 0 || state.isWaitingBackend) {
      throw new Error(`Expected 0 active operations after all ended, got ${state.activeCount}`);
    }
    console.log('  ✓ Concurrent operation counting verified.');

    // ------------------------------------------------------------------------
    // Step 5: User Cancellation via clearAll() / cancelAll()
    // ------------------------------------------------------------------------
    console.log('\n🛑 Step 5: Testing User Cancellation (clearAll)...');
    responseTracker.startOperation('User Long Operation');
    
    // Wait past the 35ms latency threshold so wait icon is active
    await new Promise((r) => setTimeout(r, 45));
    state = responseTracker.getState();
    console.log(`  Before cancel: isWaitingBackend=${state.isWaitingBackend}, activeCount=${state.activeCount}`);
    if (!state.isWaitingBackend || state.activeCount !== 1) {
      throw new Error('Expected wait indicator to be active before cancellation');
    }

    // User clicks cancel or navigates
    responseTracker.clearAll();

    state = responseTracker.getState();
    console.log(`  After cancel: isWaitingBackend=${state.isWaitingBackend}, activeCount=${state.activeCount}`);
    if (state.isWaitingBackend || state.activeCount !== 0) {
      throw new Error('Wait icon was not immediately removed upon clearAll()');
    }
    console.log('  ✓ User cancellation via clearAll() immediately hides wait icon.');

    // ------------------------------------------------------------------------
    // Step 6: User Cancellation via AbortSignal
    // ------------------------------------------------------------------------
    console.log('\n🛑 Step 6: Testing User Cancellation via AbortController / AbortSignal...');
    const controller = new AbortController();

    const abortablePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve('done'), 100);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted by user', 'AbortError'));
      });
    });

    const trackedAbortPromise = trackBackendCall(abortablePromise, 'Abortable Fetch', controller.signal).catch(() => {});

    // Wait past the 35ms latency threshold
    await new Promise((r) => setTimeout(r, 45));
    state = responseTracker.getState();
    console.log(`  Before abort: isWaitingBackend=${state.isWaitingBackend}`);
    if (!state.isWaitingBackend) {
      throw new Error('Expected isWaitingBackend to be true at 45ms');
    }

    // User aborts
    controller.abort();
    await trackedAbortPromise;

    state = responseTracker.getState();
    console.log(`  After abort: isWaitingBackend=${state.isWaitingBackend}, activeCount=${state.activeCount}`);
    if (state.isWaitingBackend || state.activeCount !== 0) {
      throw new Error('Wait icon was not immediately removed upon AbortSignal cancellation');
    }
    console.log('  ✓ AbortSignal cancellation immediately removes/hides wait icon.');

    console.log('\n================================================================');
    console.log('✅ ALL TESTS PASSED: WAIT ICON DISPLAY, COMPLETION & CANCELLATION VERIFIED!');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

runResponseTrackerTest();
