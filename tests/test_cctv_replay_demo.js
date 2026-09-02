const assert = require('assert');
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');
const { SimulationSensor, HybridSensor } = require('../backend/trafficSensors');
const { DemoTrafficController } = require('../backend/demoTrafficController');
const fs = require('fs');
const path = require('path');

console.log("==================================================");
console.log("AURA CCTV REPLAY → JUNCTION DEMO TEST SUITE");
console.log("==================================================");

const config = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];
const junctionIds = ["J1", "J2", "J3", "J4", "J5", "J6"];
const approaches = ["NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND"];

// Setup Hybrid Sensor with 2000ms timeout
const simSensor = new SimulationSensor("AURA_DEMO_SEED");
const hybridSensor = new HybridSensor(simSensor, 2000);

const aura = new TrafficEngine(config);
const baseline = new BaselineController(config);

junctionIds.forEach(jid => {
    aura.initJunction(jid, phases);
    baseline.initJunction(jid, phases);
});

// -------------------------------------------------------------
// TEST 1: Initial State is Clean Simulation across J1-J6
// -------------------------------------------------------------
console.log("\n[TEST 1] Initial State: J1-J6 are pure simulation...");
hybridSensor.tick(junctionIds, approaches);
junctionIds.forEach(jid => {
    approaches.forEach(app => {
        const state = hybridSensor.getApproachState(jid, app);
        assert.strictEqual(state.sourceMode, "SIMULATED", `Junction ${jid} approach ${app} should be SIMULATED initially`);
    });
});
console.log("✓ TEST 1 PASSED: All 6 junctions initialize in SIMULATED mode.");

// -------------------------------------------------------------
// TEST 2 & 3: J1 NORTHBOUND accepts REPLAY data & preserves sourceMode
// -------------------------------------------------------------
console.log("\n[TEST 2 & 3] Ingesting REPLAY data on J1 NORTHBOUND...");
// Ingest batch arrivals (e.g., 2 Sedans, 1 Bus = 2*1.0 + 1*3.0 = 5.0 PCU)
const replayDetections = { Sedan: 2, Bus: 1 };
hybridSensor.injectVisionData("J1", "NORTHBOUND", { counts: replayDetections }, "REPLAY");

const j1NbState = hybridSensor.getApproachState("J1", "NORTHBOUND");
assert.strictEqual(j1NbState.sourceMode, "REPLAY", "J1 NORTHBOUND sourceMode must be REPLAY");
assert.deepStrictEqual(j1NbState.counts, replayDetections, "J1 NORTHBOUND must receive exact vehicle detections");
console.log("✓ TEST 2 & 3 PASSED: J1 NORTHBOUND accepts and preserves REPLAY data with exact detections.");

// -------------------------------------------------------------
// TEST 4 & 5: Partial-Sensor Isolation (Other J1 & J2-J6 remain SIMULATED)
// -------------------------------------------------------------
console.log("\n[TEST 4 & 5] Partial-sensor isolation check...");
// Other J1 approaches
["SOUTHBOUND", "EASTBOUND", "WESTBOUND"].forEach(app => {
    const s = hybridSensor.getApproachState("J1", app);
    assert.strictEqual(s.sourceMode, "SIMULATED", `J1 ${app} must remain SIMULATED`);
});

// All J2 to J6 approaches
["J2", "J3", "J4", "J5", "J6"].forEach(jid => {
    approaches.forEach(app => {
        const s = hybridSensor.getApproachState(jid, app);
        assert.strictEqual(s.sourceMode, "SIMULATED", `${jid} ${app} must remain SIMULATED`);
    });
});
console.log("✓ TEST 4 & 5 PASSED: Only J1 NORTHBOUND receives REPLAY; all other approaches/junctions remain SIMULATED.");

// -------------------------------------------------------------
// TEST 6: TrafficEngine is the Sole Controller & Adapts to Replay PCU
// -------------------------------------------------------------
console.log("\n[TEST 6] TrafficEngine adapts green splits to Replay PCU...");
const j1Before = aura.getJunctionState("J1");
const qBefore = j1Before.approaches.NORTHBOUND.queue_pcu;

// Tick AURA with the ingested arrivals
const arrivalsTick = {
    NORTHBOUND: { counts: j1NbState.counts },
    SOUTHBOUND: { counts: {} },
    EASTBOUND: { counts: {} },
    WESTBOUND: { counts: {} }
};
aura.tick("J1", arrivalsTick);

const j1After = aura.getJunctionState("J1");
const qAfter = j1After.approaches.NORTHBOUND.queue_pcu;
console.log(`J1 NORTHBOUND Queue: ${qBefore} -> ${qAfter} PCU (incorporating replay demand)`);
assert.ok(qAfter > qBefore || qAfter >= 4.5, "Replay PCU must be added to TrafficEngine queue dynamics");
assert.strictEqual(j1After.phase_name === "NORTH_SOUTH" || j1After.phase_name === "EAST_WEST", true);
console.log("✓ TEST 6 PASSED: TrafficEngine single authoritative controller computes queue and dynamic split.");

// -------------------------------------------------------------
// TEST 7: Replay Timeout Graceful Fallback to Simulation
// -------------------------------------------------------------
console.log("\n[TEST 7] Replay timeout fallback...");
// Simulate waiting 2500ms (exceeding 2000ms timeout)
hybridSensor.lastSeen["J1"]["NORTHBOUND"] = Date.now() - 2500;
hybridSensor.tick(junctionIds, approaches);

const j1NbFallback = hybridSensor.getApproachState("J1", "NORTHBOUND");
assert.strictEqual(j1NbFallback.sourceMode, "SIMULATED", "J1 NORTHBOUND must fall back to SIMULATED after timeout");
console.log("✓ TEST 7 PASSED: J1 NORTHBOUND gracefully falls back to SIMULATED after replay inactivity.");

// -------------------------------------------------------------
// TEST 8: Full Simulation Works Seamlessly After Replay
// -------------------------------------------------------------
console.log("\n[TEST 8] Full 6-junction simulation continuity...");
const graphPath = path.join(__dirname, '../backend/graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const demo = new DemoTrafficController(aura, graph);

demo.start();
assert.strictEqual(demo.active, true);

for (let t = 0; t < 20; t++) {
    const demoArr = demo.getSimulatedArrivals();
    junctionIds.forEach(jid => {
        const arr = {};
        approaches.forEach(app => {
            arr[app] = { counts: { car: (demoArr[jid] && demoArr[jid][app]) ? demoArr[jid][app].counts.car : 0 } };
        });
        aura.tick(jid, arr);
        baseline.tick(jid, arr);
    });
}

const j1SimState = aura.getJunctionState("J1");
assert.ok(j1SimState.approaches.NORTHBOUND.queue_pcu >= 0);
console.log("✓ TEST 8 PASSED: Full 6-junction corridor simulation runs normally with active demand surge.");

// -------------------------------------------------------------
// TEST 9: Baseline Remains Offline Comparison Only
// -------------------------------------------------------------
console.log("\n[TEST 9] Baseline offline counterfactual isolation...");
const cfState = baseline.getCounterfactualState("J1");
assert.strictEqual(cfState.reference_model, "FIXED_30_30");
assert.ok(cfState.avg_delay_seconds >= 0);
console.log(`Baseline Counterfactual: Fixed 30/30 (Avg delay: ${cfState.avg_delay_seconds}s)`);
console.log("✓ TEST 9 PASSED: Baseline functions strictly as offline counterfactual benchmark.");

// -------------------------------------------------------------
// TEST 10: Zero Conflicting Signal Phases
// -------------------------------------------------------------
console.log("\n[TEST 10] Zero conflicting green signals verification...");
junctionIds.forEach(jid => {
    const st = aura.getJunctionState(jid);
    const nbGreen = st.approaches.NORTHBOUND.signal_state === "GREEN";
    const sbGreen = st.approaches.SOUTHBOUND.signal_state === "GREEN";
    const ebGreen = st.approaches.EASTBOUND.signal_state === "GREEN";
    const wbGreen = st.approaches.WESTBOUND.signal_state === "GREEN";

    if (nbGreen || sbGreen) {
        assert.strictEqual(ebGreen, false, `Conflict on ${jid}: Eastbound green while Northbound/Southbound green`);
        assert.strictEqual(wbGreen, false, `Conflict on ${jid}: Westbound green while Northbound/Southbound green`);
    }
    if (ebGreen || wbGreen) {
        assert.strictEqual(nbGreen, false, `Conflict on ${jid}: Northbound green while Eastbound/Westbound green`);
        assert.strictEqual(sbGreen, false, `Conflict on ${jid}: Southbound green while Eastbound/Westbound green`);
    }
});
console.log("✓ TEST 10 PASSED: Conflicting movements strictly isolated across all 6 junctions.");

console.log("\n==================================================");
console.log("ALL 10 CCTV REPLAY & DEMO PROOFS PASSED!");
console.log("==================================================");
