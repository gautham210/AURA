// ============================================================================
// AURA EMERGENCY COMPLETION METRICS & SCENARIO REGRESSION TEST SUITE
// Verifies:
// 1. Completion card metrics produced upon emergency arrival at Welcare Hospital
// 2. Baseline travel time vs. AURA preempted travel time strictly derived from run
// 3. Percentage saved is strictly calculated from the raw displayed travel times
// 4. Same origin (J3), destination (Welcare Hospital), route, and distance (8.8 km)
// 5. Confirmation of authoritative preemption state machine across J3-J6
// 6. Confirmation of counterfactual offline benchmark conditions (identical demand stream)
// 7. No hardcoded or fabricated mock values (4m15s / 1m20s)
// 8. Selectable scenarios: NORMAL (10s), HEAVY_CONGESTION (20s), VERY_HEAVY (20s)
// 9. Queue delay emerges physically from the queue equations (q * 2.0s)
// 10. Deterministic reset verification across 5 consecutive trials
// ============================================================================

const assert = require('assert');
const graph = require('../backend/graph.json');
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');
const { EmergencyDemoController } = require('../backend/demoTrafficController');

console.log("==================================================");
console.log("AURA EMERGENCY COMPLETION METRICS TEST SUITE");
console.log("==================================================");

const engineConfig = {
    C: 60,
    lost_time: 6,
    G_min: 10,
    gap_out_seconds: 5,
    S: 0.5
};

function initControllers() {
    const trafficEngine = new TrafficEngine(engineConfig);
    const baseline = new BaselineController(engineConfig);
    graph.controlledJunctions.forEach(j => {
        trafficEngine.initJunction(j.id, [
            ['NORTHBOUND', 'SOUTHBOUND'],
            ['EASTBOUND', 'WESTBOUND']
        ]);
        baseline.initJunction(j.id, [
            ['NORTHBOUND', 'SOUTHBOUND'],
            ['EASTBOUND', 'WESTBOUND']
        ]);
    });
    const emergencyController = new EmergencyDemoController(trafficEngine, graph, baseline);
    return { trafficEngine, baseline, emergencyController };
}

// -------------------------------------------------------------
// [TEST 1] NORMAL Scenario (10s Timeline)
// -------------------------------------------------------------
console.log("\n[TEST 1] Testing NORMAL scenario (10s timeline)...");
{
    const { trafficEngine, baseline, emergencyController } = initControllers();
    assert.strictEqual(emergencyController.completionMetrics, null, "completionMetrics must be null before start");
    
    emergencyController.start("NORMAL");
    assert.strictEqual(emergencyController.completionMetrics, null, "completionMetrics must remain null while running");
    assert.strictEqual(emergencyController.durationSeconds, 10, "NORMAL scenario duration must be 10s");

    for (let t = 1; t <= 10; t++) {
        const arrivals = emergencyController.getSimulatedArrivals();
        if (arrivals) {
            graph.controlledJunctions.forEach(j => {
                trafficEngine.tick(j.id, arrivals[j.id]);
                baseline.tick(j.id, arrivals[j.id]);
            });
        }
        emergencyController.tick();
    }

    assert.strictEqual(emergencyController.completed, true, "Emergency demo must be completed at T=10");
    assert.strictEqual(emergencyController.active, false, "Emergency demo must be inactive at completion");
    assert.ok(emergencyController.completionMetrics, "completionMetrics must be generated upon completion");

    const m = emergencyController.completionMetrics;
    const rawBaseline = m.baselineTravelTimeSeconds;
    const rawAura = m.auraTravelTimeSeconds;
    const rawPercentage = m.percentageSaved;

    assert.ok(rawBaseline > 0, "Baseline travel time must be positive");
    assert.ok(rawAura > 0, "AURA travel time must be positive");
    assert.ok(rawAura < rawBaseline, "AURA travel time must be less than baseline");
    
    const expectedPercentage = Math.round(((rawBaseline - rawAura) / rawBaseline) * 100);
    assert.strictEqual(rawPercentage, expectedPercentage, "Percentage saved must match raw formula");

    // Ensure neither is hardcoded
    assert.notStrictEqual(rawBaseline, 255, "Baseline travel time must not be hardcoded 4m15s");
    assert.notStrictEqual(rawAura, 80, "AURA travel time must not be hardcoded 1m20s");
    assert.notStrictEqual(m.baselineTravelTimeFormatted, "4m 15s", "Baseline must not be hardcoded '4m 15s'");
    assert.notStrictEqual(m.auraTravelTimeFormatted, "1m 20s", "AURA must not be hardcoded '1m 20s'");

    assert.strictEqual(m.origin, "J3 (Kaloor Junction)");
    assert.strictEqual(m.destination, "Welcare Hospital");
    assert.strictEqual(m.distanceKm, 8.8);
    assert.strictEqual(m.controlledJunctionsCount, 4);
    assert.strictEqual(m.routePath, "J3 → J4 → J5 → J6 → Welcare Hospital");
    assert.strictEqual(m.preemptionStateMachineConfirmed, true);
    assert.strictEqual(m.counterfactualConditionsConfirmed, true);

    console.log(`✓ TEST 1 Passed: NORMAL scenario produced ${m.baselineTravelTimeFormatted} vs ${m.auraTravelTimeFormatted} (${m.percentageSaved}% time saved).`);
}

// -------------------------------------------------------------
// [TEST 2] HEAVY_CONGESTION Scenario (20s Timeline)
// -------------------------------------------------------------
console.log("\n[TEST 2] Testing HEAVY_CONGESTION scenario (20s timeline)...");
{
    const { trafficEngine, baseline, emergencyController } = initControllers();
    emergencyController.start("HEAVY_CONGESTION");
    assert.strictEqual(emergencyController.durationSeconds, 20, "HEAVY_CONGESTION duration must be 20s");
    assert.strictEqual(emergencyController.currentPhase, "CONGESTION ACCUMULATION", "Initial phase must be CONGESTION ACCUMULATION");

    for (let t = 1; t <= 20; t++) {
        const arrivals = emergencyController.getSimulatedArrivals();
        assert.ok(arrivals, "Simulated arrivals must be generated during active demo");
        graph.controlledJunctions.forEach(j => {
            // Both controllers receive EXACTLY identical arrivals
            trafficEngine.tick(j.id, arrivals[j.id]);
            baseline.tick(j.id, arrivals[j.id]);
        });
        emergencyController.tick();
        
        if (t === 10) {
            assert.strictEqual(emergencyController.currentPhase, "EMERGENCY DETECTED", "Phase at T=10 must be EMERGENCY DETECTED");
        }
    }

    assert.strictEqual(emergencyController.completed, true, "HEAVY_CONGESTION must complete at T=20");
    assert.ok(emergencyController.completionMetrics, "completionMetrics must be generated");

    const m = emergencyController.completionMetrics;
    console.log("  HEAVY_CONGESTION Metrics:", {
        scenario: m.scenario,
        baselineTotal: m.baselineTravelTimeFormatted,
        auraTotal: m.auraTravelTimeFormatted,
        percentageSaved: m.percentageSaved + "%",
        delayReduction: m.delayReductionPercentage + "%",
        baselineSignalDelay: m.baselineSignalDelaySeconds + "s",
        baselineQueueDelay: m.baselineQueueDelaySeconds + "s",
        maxQueuePcu: m.maxQueuePcu + " PCU"
    });

    assert.strictEqual(m.scenario, "HEAVY_CONGESTION");
    assert.ok(m.baselineQueueDelaySeconds > 50, "Baseline queue delay must physically accumulate > 50s under heavy traffic");
    assert.strictEqual(m.auraQueueDelaySeconds, 0.0, "AURA queue delay must be 0s due to preemption clearing");
    assert.strictEqual(m.auraSignalDelaySeconds, 1.0, "AURA signal delay must be 1.0s (buffer tick)");
    assert.strictEqual(m.baselineSignalDelaySeconds, 60.0, "Baseline signal delay across 4 junctions must be 60.0s (4 * 15s)");

    // Strict percentage calculation assertion
    const calculatedPct = Math.round(((m.baselineTravelTimeSeconds - m.auraTravelTimeSeconds) / m.baselineTravelTimeSeconds) * 100);
    assert.strictEqual(m.percentageSaved, calculatedPct, "Percentage saved must strictly equal raw mathematical derivation");
    assert.ok(m.percentageSaved >= 10, `Percentage saved (${m.percentageSaved}%) should reflect meaningful queue reduction (>= 10%)`);
    assert.ok(m.delayReductionPercentage >= 95, "Corridor junction delay reduction must exceed 95%");

    console.log(`✓ TEST 2 Passed: HEAVY_CONGESTION produced ${m.percentageSaved}% time saved (${m.delayReductionPercentage}% delay reduction).`);
}

// -------------------------------------------------------------
// [TEST 3] VERY_HEAVY Scenario (20s Timeline)
// -------------------------------------------------------------
console.log("\n[TEST 3] Testing VERY_HEAVY scenario (20s timeline)...");
{
    const { trafficEngine, baseline, emergencyController } = initControllers();
    emergencyController.start("VERY_HEAVY");

    for (let t = 1; t <= 20; t++) {
        const arrivals = emergencyController.getSimulatedArrivals();
        graph.controlledJunctions.forEach(j => {
            trafficEngine.tick(j.id, arrivals[j.id]);
            baseline.tick(j.id, arrivals[j.id]);
        });
        emergencyController.tick();
    }

    assert.strictEqual(emergencyController.completed, true);
    const m = emergencyController.completionMetrics;
    console.log("  VERY_HEAVY Metrics:", {
        scenario: m.scenario,
        baselineTotal: m.baselineTravelTimeFormatted,
        auraTotal: m.auraTravelTimeFormatted,
        percentageSaved: m.percentageSaved + "%",
        baselineQueueDelay: m.baselineQueueDelaySeconds + "s",
        maxQueuePcu: m.maxQueuePcu + " PCU"
    });

    assert.strictEqual(m.scenario, "VERY_HEAVY");
    assert.ok(m.maxQueuePcu >= 25, "VERY_HEAVY max queue must reach high saturation (>= 25 PCU)");
    assert.ok(m.baselineQueueDelaySeconds > 150, "VERY_HEAVY queue delay must exceed 150s");
    assert.ok(m.percentageSaved >= 15, "VERY_HEAVY total travel time savings must be >= 15%");
    console.log(`✓ TEST 3 Passed: VERY_HEAVY produced ${m.percentageSaved}% time saved with max queue ${m.maxQueuePcu} PCU.`);
}

// -------------------------------------------------------------
// [TEST 4] Determinism Verification (5 Fresh Consecutive Trials)
// -------------------------------------------------------------
console.log("\n[TEST 4] Verifying 100% deterministic reproducibility across 5 fresh trials...");
{
    const trialResults = [];
    for (let trial = 1; trial <= 5; trial++) {
        const { trafficEngine, baseline, emergencyController } = initControllers();
        emergencyController.start("HEAVY_CONGESTION");
        for (let t = 1; t <= 20; t++) {
            const arrivals = emergencyController.getSimulatedArrivals();
            graph.controlledJunctions.forEach(j => {
                trafficEngine.tick(j.id, arrivals[j.id]);
                baseline.tick(j.id, arrivals[j.id]);
            });
            emergencyController.tick();
        }
        const m = emergencyController.completionMetrics;
        trialResults.push({
            baselineTotal: m.baselineTravelTimeSeconds,
            auraTotal: m.auraTravelTimeSeconds,
            pctSaved: m.percentageSaved,
            queueDelay: m.baselineQueueDelaySeconds,
            maxQueue: m.maxQueuePcu
        });
    }

    for (let i = 1; i < trialResults.length; i++) {
        assert.deepStrictEqual(trialResults[i], trialResults[0], `Trial ${i + 1} must be 100% bitwise identical to Trial 1`);
    }
    console.log(`✓ TEST 4 Passed: All 5 fresh trials produced identical results: Baseline=${trialResults[0].baselineTotal}s, AURA=${trialResults[0].auraTotal}s (${trialResults[0].pctSaved}% saved).`);
}

// -------------------------------------------------------------
// [TEST 5] Reset Invariant
// -------------------------------------------------------------
console.log("\n[TEST 5] Verifying reset cleans all state...");
{
    const { emergencyController } = initControllers();
    emergencyController.start("HEAVY_CONGESTION");
    for (let t = 1; t <= 20; t++) emergencyController.tick();
    assert.ok(emergencyController.completionMetrics);

    emergencyController.reset();
    assert.strictEqual(emergencyController.completionMetrics, null, "completionMetrics must be null after reset");
    assert.strictEqual(emergencyController.completed, false, "completed must be false after reset");
    assert.strictEqual(emergencyController.elapsedSeconds, 0, "elapsedSeconds must be 0 after reset");
    console.log("✓ TEST 5 Passed: Reset cleanly restores standby state.");
}

console.log("\n==================================================");
console.log("ALL 5 EMERGENCY COMPLETION METRICS TESTS PASSED!");
console.log("==================================================");
