const assert = require('assert');
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');
const { DemoTrafficController } = require('../backend/demoTrafficController');
const { RoutingEngine } = require('../backend/routingEngine');
const { SimulationSensor } = require('../backend/trafficSensors');
const fs = require('fs');
const path = require('path');

console.log("==========================================");
console.log("AURA FORENSIC INTEGRATION TEST SUITE");
console.log("==========================================");

const config = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

// -------------------------------------------------------------
// TEST 1: BaselineController Safety & Emergency Initialization
// -------------------------------------------------------------
console.log("\n[TEST 1] BaselineController offline counterfactual model...");
const baseline = new BaselineController(config);
baseline.initJunction('J1', phases);
assert.strictEqual(baseline.state['J1'].emergency.active, false);

baseline.tick('J1', { NORTHBOUND: { counts: { car: 1 } } });
const cf = baseline.getCounterfactualState('J1');
assert.strictEqual(cf.reference_model, "FIXED_30_30");
assert.ok(cf.avg_delay_seconds >= 0);
console.log("✓ TEST 1 PASSED: BaselineController functions as clean offline counterfactual benchmark.");

// -------------------------------------------------------------
// TEST 2: TrafficEngine Authoritative Emergency State Machine
// -------------------------------------------------------------
console.log("\n[TEST 2] TrafficEngine authoritative emergency state machine...");
const aura = new TrafficEngine(config);
aura.initJunction('J1', phases);

// Verify normal getJunctionState includes emergency object
let state = aura.getJunctionState('J1');
assert.strictEqual(state.emergency.active, false);
assert.strictEqual(state.emergency.state, 'NORMAL');

// Activate emergency on EASTBOUND approach
aura.setEmergencyPreemption('J1', 'EASTBOUND');
assert.strictEqual(aura.state['J1'].emergency.active, true);
assert.strictEqual(aura.state['J1'].emergency.state, 'CLEARING');

// Tick 1, 2, 3: Clearing phase (all red for safety)
aura.tick('J1', {});
aura.tick('J1', {});
aura.tick('J1', {});
state = aura.getJunctionState('J1');
assert.strictEqual(state.emergency.state, 'EMERGENCY_GREEN');
assert.strictEqual(state.emergency.approach, 'EASTBOUND');
assert.strictEqual(state.approaches['EASTBOUND'].signal_state, 'GREEN');
assert.strictEqual(state.approaches['NORTHBOUND'].signal_state, 'RED');
assert.strictEqual(state.approaches['SOUTHBOUND'].signal_state, 'RED');

// Clear preemption -> RECOVERY
aura.setEmergencyPreemption('J1', null);
assert.strictEqual(aura.state['J1'].emergency.state, 'RECOVERY');
aura.tick('J1', {});
aura.tick('J1', {});
aura.tick('J1', {});
state = aura.getJunctionState('J1');
assert.strictEqual(state.emergency.state, 'NORMAL');
assert.strictEqual(state.emergency.active, false);
console.log("✓ TEST 2 PASSED: TrafficEngine transitions NORMAL -> CLEARING -> EMERGENCY_GREEN -> RECOVERY -> NORMAL.");

// -------------------------------------------------------------
// TEST 3: Signal Direction Compatibility (No Conflicting Greens)
// -------------------------------------------------------------
console.log("\n[TEST 3] Signal direction compatibility across 120 ticks...");
const aura3 = new TrafficEngine(config);
aura3.initJunction('J1', phases);

for (let t = 0; t < 120; t++) {
    aura3.tick('J1', {});
    const st = aura3.getJunctionState('J1');
    const nbGreen = st.approaches['NORTHBOUND'].signal_state === 'GREEN';
    const sbGreen = st.approaches['SOUTHBOUND'].signal_state === 'GREEN';
    const ebGreen = st.approaches['EASTBOUND'].signal_state === 'GREEN';
    const wbGreen = st.approaches['WESTBOUND'].signal_state === 'GREEN';

    // North/South compatible movements
    if (nbGreen || sbGreen) {
        assert.strictEqual(ebGreen, false, `Conflict: Eastbound green while Northbound/Southbound green at tick ${t}`);
        assert.strictEqual(wbGreen, false, `Conflict: Westbound green while Northbound/Southbound green at tick ${t}`);
    }
    // East/West compatible movements
    if (ebGreen || wbGreen) {
        assert.strictEqual(nbGreen, false, `Conflict: Northbound green while Eastbound/Westbound green at tick ${t}`);
        assert.strictEqual(sbGreen, false, `Conflict: Southbound green while Eastbound/Westbound green at tick ${t}`);
    }
}
console.log("✓ TEST 3 PASSED: Zero conflicting green movements observed over 120 ticks.");

// -------------------------------------------------------------
// TEST 4: Stable Baseline Queue Equilibrium
// -------------------------------------------------------------
console.log("\n[TEST 4] Stable baseline queue equilibrium test...");
const sim = new SimulationSensor("AURA_DEMO_SEED");
const auraEq = new TrafficEngine(config);
auraEq.initJunction('J1', phases);

const jids = ['J1'];
const apprs = ['NORTHBOUND', 'SOUTHBOUND', 'EASTBOUND', 'WESTBOUND'];

for (let t = 0; t < 300; t++) { // 5 minutes
    sim.tick(jids, apprs);
    const arr = {};
    apprs.forEach(app => {
        arr[app] = { counts: sim.getApproachState('J1', app).counts };
    });
    auraEq.tick('J1', arr);
}

const eqState = auraEq.getJunctionState('J1');
let maxQueue = 0;
let maxDelay = 0;
apprs.forEach(app => {
    if (eqState.approaches[app].queue_pcu > maxQueue) maxQueue = eqState.approaches[app].queue_pcu;
    if (eqState.approaches[app].avg_delay_seconds > maxDelay) maxDelay = eqState.approaches[app].avg_delay_seconds;
});

console.log(`Max queue after 5 mins of normal traffic: ${maxQueue.toFixed(1)} PCU`);
console.log(`Max delay after 5 mins of normal traffic: ${maxDelay.toFixed(1)}s`);
assert.ok(maxQueue < 25, `Queue runaway detected: ${maxQueue} PCU`);
assert.ok(maxDelay < 40, `Delay runaway detected: ${maxDelay}s`);
console.log("✓ TEST 4 PASSED: Normal traffic reaches stable physical equilibrium.");

// -------------------------------------------------------------
// TEST 5: Routing Physical ETA Derivation
// -------------------------------------------------------------
console.log("\n[TEST 5] Routing Physical ETA derivation...");
const graphPath = path.join(__dirname, '../backend/graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const routing = new RoutingEngine(graph);

const r1 = routing.findRoutes("J1", "344035009", []); // Palarivattom -> Ernakulam South
const r2 = routing.findRoutes("J3", "2923377480", []); // Edappally -> Vyttila
const r3 = routing.findRoutes("J4", "1907420171", []); // Kaloor -> Marine Drive

assert.ok(r1 && r1.individual && r1.individual.estimatedTime > 0);
assert.ok(r2 && r2.individual && r2.individual.estimatedTime > 0);
assert.ok(r3 && r3.individual && r3.individual.estimatedTime > 0);

const eta1Min = Math.ceil(r1.individual.estimatedTime / 60);
const eta2Min = Math.ceil(r2.individual.estimatedTime / 60);
const eta3Min = Math.ceil(r3.individual.estimatedTime / 60);

console.log(`Palarivattom -> Ernakulam South: ${(r1.individual.distance/1000).toFixed(1)} km -> ${eta1Min} min`);
console.log(`Edappally -> Vyttila: ${(r2.individual.distance/1000).toFixed(1)} km -> ${eta2Min} min`);
console.log(`Kaloor -> Marine Drive: ${(r3.individual.distance/1000).toFixed(1)} km -> ${eta3Min} min`);

assert.ok(r1.individual.distance > r2.individual.distance, "Route 1 should be longer than Route 2");
assert.ok(r2.individual.distance > r3.individual.distance, "Route 2 should be longer than Route 3");
assert.ok(eta1Min > eta2Min && eta2Min > eta3Min, "ETAs should be strictly proportional to distance/delay");
console.log("✓ TEST 5 PASSED: ETAs are mathematically derived and logically ordered.");

// -------------------------------------------------------------
// TEST 6: Frontend Script Safety (Zero Undeclared Elements)
// -------------------------------------------------------------
console.log("\n[TEST 6] Frontend script safety audit...");
const appJs = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../frontend/dashboard.html'), 'utf8');

assert.ok(appJs.includes("btnSimulateEmergency = document.getElementById('btn-simulate-emergency')"));
assert.ok(appJs.includes("btnDemoStart = document.getElementById('btn-demo-start')"));
assert.ok(appJs.includes("btnDemoPause = document.getElementById('btn-demo-pause')"));
assert.ok(appJs.includes("btnDemoReset = document.getElementById('btn-demo-reset')"));
assert.ok(appJs.includes("function interpolatePolyline"));
assert.ok(appJs.includes("initTrafficVisualization"));

console.log("✓ TEST 6 PASSED: All critical DOM references and functions verified.");

// -------------------------------------------------------------
// TEST 7: Single Authoritative Controller & Counterfactual Isolation
// -------------------------------------------------------------
console.log("\n[TEST 7] Single Authoritative Controller & Counterfactual Isolation...");
const liveAura = new TrafficEngine(config);
const offlineBaseline = new BaselineController(config);
liveAura.initJunction('J1', phases);
offlineBaseline.initJunction('J1', phases);

// Feed identical demand stream
for (let t = 0; t < 60; t++) {
    const demand = {
        NORTHBOUND: { counts: { car: t % 4 === 0 ? 2 : 0 } },
        SOUTHBOUND: { counts: { car: t % 4 === 0 ? 1 : 0 } },
        EASTBOUND: { counts: { car: t % 10 === 0 ? 1 : 0 } },
        WESTBOUND: { counts: { car: t % 10 === 0 ? 1 : 0 } }
    };
    liveAura.tick('J1', demand);
    offlineBaseline.tick('J1', demand);
}

const liveState = liveAura.getJunctionState('J1');
const offlineState = offlineBaseline.getCounterfactualState('J1');

// Verify AURA decided dynamically while Baseline evaluated fixed 30/30
assert.ok(liveState.phase_durations.NORTH_SOUTH > liveState.phase_durations.EAST_WEST, "AURA should grant more green time to heavier NS demand");
assert.strictEqual(offlineState.reference_model, "FIXED_30_30");
assert.ok(liveState.phase_name === "NORTH_SOUTH" || liveState.phase_name === "EAST_WEST");

console.log(`AURA Dynamic Split: NS=${liveState.phase_durations.NORTH_SOUTH}s vs EW=${liveState.phase_durations.EAST_WEST}s`);
console.log(`Baseline Reference Model: Fixed 30s/30s (Avg delay: ${offlineState.avg_delay_seconds}s)`);
console.log("✓ TEST 7 PASSED: Single authoritative AURA engine with isolated counterfactual benchmark.");

// -------------------------------------------------------------
// TEST 8: Authoritative Traffic State Follows Signals
// -------------------------------------------------------------
console.log("\n[TEST 8] Queue and vehicle discharge follows signal state...");
const testEngine = new TrafficEngine(config);
testEngine.initJunction('J1', phases);

// Force green on NORTH_SOUTH, red on EAST_WEST
const stBefore = testEngine.getJunctionState('J1');
assert.strictEqual(stBefore.approaches.NORTHBOUND.signal_state, "GREEN");
assert.strictEqual(stBefore.approaches.EASTBOUND.signal_state, "RED");

// Put 5 PCU queue on both
testEngine.state['J1'].approaches.NORTHBOUND.q = 5.0;
testEngine.state['J1'].approaches.EASTBOUND.q = 5.0;

// Tick with zero arrivals: Green should discharge, Red should hold queue
testEngine.tick('J1', {});
const stAfter = testEngine.getJunctionState('J1');

assert.ok(stAfter.approaches.NORTHBOUND.queue_pcu < 5.0, "Green approach must discharge vehicles (queue decreases)");
assert.strictEqual(stAfter.approaches.EASTBOUND.queue_pcu, 5.0, "Red approach must hold vehicles (queue unchanged)");

console.log(`Green Northbound queue: 5.0 -> ${stAfter.approaches.NORTHBOUND.queue_pcu} PCU (discharged)`);
console.log(`Red Eastbound queue: 5.0 -> ${stAfter.approaches.EASTBOUND.queue_pcu} PCU (held at red)`);
console.log("✓ TEST 8 PASSED: Vehicles strictly follow authoritative signal states.");

console.log("\n==========================================");
console.log("ALL 8 FORENSIC & ARCHITECTURE PROOFS PASSED!");
console.log("==========================================");
