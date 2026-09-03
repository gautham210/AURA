const assert = require('assert');
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');

console.log("==================================================");
console.log("AURA SPILLBACK TRANSITION REGRESSION TEST SUITE");
console.log("==================================================\n");

const config = {
    C: 60,
    lost_time: 6,
    G_min: 10,
    gap_out_seconds: 5,
    S: 0.8,
    storageCapacity: 12.0
};

const phases = [
    ["NORTHBOUND", "SOUTHBOUND"],
    ["EASTBOUND", "WESTBOUND"]
];

// =================================================================
// 1. PHYSICAL APPROACH QUEUE SPILLBACK TESTS
// =================================================================
console.log("[TEST 1] Physical Approach Storage Capacity Spillback Transitions...");
const engine = new TrafficEngine(config);
engine.initJunction('J1', phases);

// 1.1: below -> above = 1
console.log("  1.1 below -> above = 1 event");
assert.strictEqual(engine.getJunctionState('J1').spillback_events, 0, "Initial spillback events must be 0");
assert.strictEqual(engine.getJunctionState('J1').spillback_active, false, "Initial spillback active must be false");

engine.state['J1'].approaches.NORTHBOUND.q = 15.0; // Above storage capacity (12.0)
engine.tick('J1', {});

const s1 = engine.getJunctionState('J1');
assert.strictEqual(s1.spillback_events, 1, `Expected exactly 1 spillback event on rising edge, got ${s1.spillback_events}`);
assert.strictEqual(s1.spillback_active, true, "Spillback active must be true when queue exceeds capacity");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.spillbackEvents, 1, "Approach spillback events must be 1");
console.log("  ✓ 1.1 Passed: below -> above produces exactly 1 event");

// 1.2: above -> above -> above (20 consecutive ticks above threshold produce exactly 1 event)
console.log("  1.2 20 consecutive ticks above threshold = still exactly 1 event");
for (let i = 0; i < 20; i++) {
    engine.state['J1'].approaches.NORTHBOUND.q = 15.0;
    engine.tick('J1', {});
}

const s2 = engine.getJunctionState('J1');
assert.strictEqual(s2.spillback_events, 1, `20 consecutive saturated ticks must NOT create extra events. Got ${s2.spillback_events}`);
assert.strictEqual(s2.spillback_active, true, "Spillback active must remain true while saturated");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.spillbackEvents, 1, "Approach counter must remain 1");
console.log("  ✓ 1.2 Passed: 20 consecutive ticks above threshold produce still 1 event (zero additional events)");

// 1.3: above -> below -> above = 2 events
console.log("  1.3 above -> below -> above = 2 events");
engine.state['J1'].approaches.NORTHBOUND.q = 0.0; // Discharge queue below capacity
engine.tick('J1', {});

const s3 = engine.getJunctionState('J1');
assert.strictEqual(s3.spillback_active, false, "Spillback active must clear to false when queue discharges");
assert.strictEqual(s3.spillback_events, 1, "Spillback events must not increment on falling edge");

engine.state['J1'].approaches.NORTHBOUND.q = 15.0; // Re-saturate (second rising edge)
engine.tick('J1', {});

const s4 = engine.getJunctionState('J1');
assert.strictEqual(s4.spillback_events, 2, `Second rising edge must produce event 2, got ${s4.spillback_events}`);
assert.strictEqual(s4.spillback_active, true, "Spillback active must return to true on re-saturation");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.spillbackEvents, 2, "Approach counter must be 2");
console.log("  ✓ 1.3 Passed: above -> below -> above produces exactly 2 events");

// 1.4: reset -> above = 1 event
console.log("  1.4 reset -> above = 1 event");
engine.reset('J1');

const sReset = engine.getJunctionState('J1');
assert.strictEqual(sReset.spillback_events, 0, "Reset must zero out junction spillback events");
assert.strictEqual(sReset.spillback_active, false, "Reset must clear spillback active flag");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.spillbackEvents, 0, "Reset must zero approach spillback events");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.q, 0, "Reset must zero approach queues");

engine.state['J1'].approaches.NORTHBOUND.q = 15.0; // Re-saturate from fresh reset
engine.tick('J1', {});

const s5 = engine.getJunctionState('J1');
assert.strictEqual(s5.spillback_events, 1, `Rising edge after reset must produce 1 event, got ${s5.spillback_events}`);
assert.strictEqual(s5.spillback_active, true, "Spillback active must be true");
assert.strictEqual(engine.state['J1'].approaches.NORTHBOUND.spillbackEvents, 1, "Approach counter must be 1");
console.log("  ✓ 1.4 Passed: reset -> above produces exactly 1 event");

// =================================================================
// 2. CONGESTION BAND / BACKPRESSURE LEVEL SPILLBACK TESTS
// =================================================================
console.log("\n[TEST 2] Congestion Band / Backpressure Level Transition Semantics...");
engine.reset('J1');

// 2.1: below -> above = 1
console.log("  2.1 Level 0 -> Level 1 (0.70 util) = 1 event");
engine.updateBackPressure('J1', 0.70); // Level 1 (0.60 <= util < 0.75)
assert.strictEqual(engine.state['J1'].spillbackEvents, 1, `Expected 1 event on Level 0->1 transition, got ${engine.state['J1'].spillbackEvents}`);
assert.strictEqual(engine.state['J1'].backPressureLevel, 1, "Backpressure level must be 1");
console.log("  ✓ 2.1 Passed: Level 0 -> Level 1 produces 1 event");

// 2.2: 20 consecutive ticks within same congestion band = still 1 event
console.log("  2.2 20 consecutive ticks in same congestion band = still 1 event");
for (let i = 0; i < 20; i++) {
    engine.updateBackPressure('J1', 0.72); // Remains Level 1
}
assert.strictEqual(engine.state['J1'].spillbackEvents, 1, `20 ticks in same band must NOT create extra events, got ${engine.state['J1'].spillbackEvents}`);
console.log("  ✓ 2.2 Passed: 20 consecutive ticks in same congestion band produce still 1 event");

// 2.3: above -> below -> above = 2 events
console.log("  2.3 Level 1 -> Level 0 (decrease) -> Level 1 (increase) = 2 events");
engine.updateBackPressure('J1', 0.50); // Decrease to Level 0 (< 0.60)
assert.strictEqual(engine.state['J1'].spillbackEvents, 1, "Decreasing congestion band must NOT increment events");
assert.strictEqual(engine.state['J1'].backPressureLevel, 0, "Backpressure level must update to 0");

engine.updateBackPressure('J1', 0.70); // Rise back to Level 1
assert.strictEqual(engine.state['J1'].spillbackEvents, 2, `Rising back into Level 1 must produce event 2, got ${engine.state['J1'].spillbackEvents}`);
assert.strictEqual(engine.state['J1'].backPressureLevel, 1, "Backpressure level must be 1");
console.log("  ✓ 2.3 Passed: above -> below -> above produces 2 events");

// 2.4: reset -> above = 1 event
console.log("  2.4 reset -> Level 1 = 1 event");
engine.reset('J1');
assert.strictEqual(engine.state['J1'].spillbackEvents, 0, "Reset must zero spillback events");
assert.strictEqual(engine.state['J1'].backPressureLevel, 0, "Reset must zero backpressure level");
assert.strictEqual(engine.state['J1'].downstreamUtilization, 0, "Reset must zero downstream utilization");

engine.updateBackPressure('J1', 0.70); // Rise to Level 1 after reset
assert.strictEqual(engine.state['J1'].spillbackEvents, 1, `Rise after reset must produce 1 event, got ${engine.state['J1'].spillbackEvents}`);
assert.strictEqual(engine.state['J1'].backPressureLevel, 1, "Backpressure level must be 1");
console.log("  ✓ 2.4 Passed: reset -> above produces exactly 1 event");

// =================================================================
// 3. MULTI-LEVEL CONGESTION BAND STEPPING
// =================================================================
console.log("\n[TEST 3] Multi-level Congestion Band Stepping (test_phase2 parity)...");
engine.reset('J1');
engine.updateBackPressure('J1', 0.70); // Level 1 -> 1
assert.strictEqual(engine.state['J1'].spillbackEvents, 1);
engine.updateBackPressure('J1', 0.72); // Still Level 1 -> 1
assert.strictEqual(engine.state['J1'].spillbackEvents, 1);
engine.updateBackPressure('J1', 0.80); // Level 2 -> 2
assert.strictEqual(engine.state['J1'].spillbackEvents, 2);
engine.updateBackPressure('J1', 0.60); // Level 1 (decrease) -> 2
assert.strictEqual(engine.state['J1'].spillbackEvents, 2);
console.log("✓ TEST 3 Passed: Multi-level congestion stepping matches exact transition semantics.\n");

// =================================================================
// 4. BASELINE CONTROLLER RESET
// =================================================================
console.log("[TEST 4] BaselineController reset verification...");
const base = new BaselineController(config);
base.initJunction('J1', phases);
base.state['J1'].approaches.NORTHBOUND.q = 20.0;
base.state['J1'].approaches.NORTHBOUND.totalAccumulatedDelay = 500;
base.reset('J1');
assert.strictEqual(base.state['J1'].approaches.NORTHBOUND.q, 0);
assert.strictEqual(base.state['J1'].approaches.NORTHBOUND.totalAccumulatedDelay, 0);
console.log("✓ TEST 4 Passed: BaselineController cleanly resets.\n");

console.log("==================================================");
console.log("ALL SPILLBACK TRANSITION REGRESSION TESTS PASSED!");
console.log("==================================================");
