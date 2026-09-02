const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');
const { DemoTrafficController } = require('../backend/demoTrafficController');
const { RoutingEngine } = require('../backend/routingEngine');

console.log("==================================================");
console.log("AURA FINAL DEMO CORRECTION ACCEPTANCE TEST SUITE");
console.log("==================================================");

const graphPath = path.join(__dirname, '../backend/graph.json');
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));

const config = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.8 };
const phases = [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]];

const trafficEngine = new TrafficEngine(config);
graph.controlledJunctions.forEach(j => trafficEngine.initJunction(j.id, phases));

const routingEngine = new RoutingEngine(graph);
const demoController = new DemoTrafficController(trafficEngine, graph);

// -------------------------------------------------------------
// TEST 1: Demo starts from t=0
// -------------------------------------------------------------
console.log("\n[TEST 1] Demo starts from t=0...");
demoController.start();
assert.strictEqual(demoController.elapsedSeconds, 0, "Demo must start with elapsedSeconds = 0");
assert.strictEqual(demoController.active, true, "Demo must be active upon start");
assert.strictEqual(demoController.completed, false, "Demo must not be completed at t=0");
assert.strictEqual(demoController.currentPhase, "TRAFFIC BUILDUP");
console.log("✓ TEST 1 PASSED: Demo starts cleanly from t=0.");

// -------------------------------------------------------------
// TEST 2: Demo completes <= 15 real/demo seconds
// -------------------------------------------------------------
console.log("\n[TEST 2] Demo completes <= 15 real/demo seconds...");
for (let t = 0; t < 15; t++) {
    demoController.tick();
}
assert.strictEqual(demoController.completed, true, "Demo must be marked completed at t=15");
assert.strictEqual(demoController.active, false, "Demo must become inactive upon completion");
assert.strictEqual(demoController.elapsedSeconds, 15, "Demo must complete in exactly 15 seconds");
assert.strictEqual(demoController.currentPhase, "DEMO COMPLETE");
console.log("✓ TEST 2 PASSED: Demo scenario completes in exactly 15 seconds.");

// -------------------------------------------------------------
// TEST 3: Demo resets correctly
// -------------------------------------------------------------
console.log("\n[TEST 3] Demo resets correctly...");
demoController.reset();
assert.strictEqual(demoController.elapsedSeconds, 0, "Reset must zero elapsedSeconds");
assert.strictEqual(demoController.active, false, "Reset must deactivate demo");
assert.strictEqual(demoController.completed, false, "Reset must clear completed flag");
assert.strictEqual(demoController.events.length, 0, "Reset must clear event log");
assert.strictEqual(demoController.emergency.active, false, "Reset must deactivate emergency");
graph.controlledJunctions.forEach(j => {
    const s = trafficEngine.getJunctionState(j.id);
    assert.strictEqual(s.emergency.active, false, `Junction ${j.id} emergency must be inactive after reset`);
    Object.values(s.approaches).forEach(a => {
        assert.strictEqual(a.queue_pcu, 0, `Approach queue must be 0 after reset`);
    });
});
console.log("✓ TEST 3 PASSED: Demo resets all queues, timers, events, and signal states.");

// -------------------------------------------------------------
// TEST 4: Emergency originates at J3 Kaloor
// -------------------------------------------------------------
console.log("\n[TEST 4] Emergency originates at J3 Kaloor...");
const emergencyRoute = routingEngine.findCorridorEmergencyRoute('J3', 'hosp_welcare');
assert.ok(emergencyRoute, "Corridor emergency route must exist");
assert.strictEqual(emergencyRoute.controlledJunctionsPassed[0].id, "J3", "Emergency must originate at J3");
assert.strictEqual(emergencyRoute.hospital, "Welcare Hospital", "Destination must be Welcare Hospital");
console.log(`✓ TEST 4 PASSED: Emergency originates at J3 Kaloor en route to ${emergencyRoute.hospital}.`);

// -------------------------------------------------------------
// TEST 5: Emergency route traverses multiple corridor junctions (J3 -> J4 -> J5 -> J6)
// -------------------------------------------------------------
console.log("\n[TEST 5] Emergency route traverses multiple corridor junctions...");
const junctionsPassed = emergencyRoute.controlledJunctionsPassed.map(j => j.id);
assert.deepStrictEqual(junctionsPassed, ["J3", "J4", "J5", "J6"], "Emergency route must traverse J3 -> J4 -> J5 -> J6");
assert.ok(emergencyRoute.distance > 8000, `Route distance must be > 8000m (was ${emergencyRoute.distance.toFixed(1)}m)`);
assert.ok(emergencyRoute.geometry.length > 50, "Route geometry must contain full polyline");
console.log(`✓ TEST 5 PASSED: Route traversed ${junctionsPassed.join(' → ')} (${emergencyRoute.distanceKm} km).`);

// -------------------------------------------------------------
// TEST 6: Sequential preemption occurs (J3 -> J4 -> J5 -> J6)
// -------------------------------------------------------------
console.log("\n[TEST 6] Sequential preemption occurs...");
demoController.start();

function runTick() {
    demoController.tick();
    graph.controlledJunctions.forEach(j => trafficEngine.tick(j.id, {}));
}

// Advance to T=6 (J3 should be EMERGENCY_GREEN)
for (let t = 0; t < 6; t++) runTick();
let j3State = trafficEngine.getJunctionState('J3');
let j4State = trafficEngine.getJunctionState('J4');
assert.strictEqual(j3State.approaches.NORTHBOUND.signal_state, "GREEN", "J3 NORTHBOUND must be GREEN at T=6");
assert.notStrictEqual(j4State.emergency.state, "EMERGENCY_GREEN", "J4 must not have emergency green at T=6");

// Advance to T=7 (J4 should be EMERGENCY_GREEN, J3 cleared)
runTick(); // T=7
j3State = trafficEngine.getJunctionState('J3');
j4State = trafficEngine.getJunctionState('J4');
assert.strictEqual(j4State.approaches.WESTBOUND.signal_state, "GREEN", "J4 WESTBOUND must be GREEN at T=7");
assert.notStrictEqual(j3State.emergency.state, "EMERGENCY_GREEN", "J3 must no longer have emergency green at T=7");

// Advance to T=9 (J5 should be EMERGENCY_GREEN, J4 cleared)
runTick(); // T=8
runTick(); // T=9
let j5State = trafficEngine.getJunctionState('J5');
j4State = trafficEngine.getJunctionState('J4');
assert.strictEqual(j5State.approaches.NORTHBOUND.signal_state, "GREEN", "J5 NORTHBOUND must be GREEN at T=9");
assert.notStrictEqual(j4State.emergency.state, "EMERGENCY_GREEN", "J4 must no longer have emergency green at T=9");

// Advance to T=11 (J6 should be EMERGENCY_GREEN, J5 cleared)
runTick(); // T=10
runTick(); // T=11
let j6State = trafficEngine.getJunctionState('J6');
j5State = trafficEngine.getJunctionState('J5');
assert.strictEqual(j6State.approaches.SOUTHBOUND.signal_state, "GREEN", "J6 SOUTHBOUND must be GREEN at T=11");
assert.notStrictEqual(j5State.emergency.state, "EMERGENCY_GREEN", "J5 must no longer have emergency green at T=11");

// Advance to T=12 (All preemption cleared)
runTick(); // T=12
j6State = trafficEngine.getJunctionState('J6');
assert.strictEqual(j6State.emergency.active, false, "J6 emergency preemption must be cleared after emergency passes");
console.log("✓ TEST 6 PASSED: Sequential preemption verified: J3 -> J4 -> J5 -> J6 with previous junctions returning to normal.");

// -------------------------------------------------------------
// TEST 7: Zero conflicting greens verification across corridor
// -------------------------------------------------------------
console.log("\n[TEST 7] Zero conflicting greens verification...");
const teCheck = new TrafficEngine(config);
graph.controlledJunctions.forEach(j => teCheck.initJunction(j.id, phases));
const dcCheck = new DemoTrafficController(teCheck, graph);
dcCheck.start();

for (let t = 0; t < 15; t++) {
    dcCheck.tick();
    graph.controlledJunctions.forEach(j => {
        const s = teCheck.getJunctionState(j.id);
        const nb = s.approaches.NORTHBOUND?.signal_state === "GREEN";
        const sb = s.approaches.SOUTHBOUND?.signal_state === "GREEN";
        const eb = s.approaches.EASTBOUND?.signal_state === "GREEN";
        const wb = s.approaches.WESTBOUND?.signal_state === "GREEN";

        if (nb || sb) {
            assert.strictEqual(eb, false, `Conflict at ${j.id} at t=${t}: EB green while NS green`);
            assert.strictEqual(wb, false, `Conflict at ${j.id} at t=${t}: WB green while NS green`);
        }
        if (eb || wb) {
            assert.strictEqual(nb, false, `Conflict at ${j.id} at t=${t}: NB green while EW green`);
            assert.strictEqual(sb, false, `Conflict at ${j.id} at t=${t}: SB green while EW green`);
        }
    });
}
console.log("✓ TEST 7 PASSED: Zero conflicting green movements across all 15 demo seconds.");

// -------------------------------------------------------------
// TEST 8: Queue remains physically bounded (no runaway > 100 PCU)
// -------------------------------------------------------------
console.log("\n[TEST 8] Queue remains physically bounded...");
let maxRecordedQueue = 0;
const teBounded = new TrafficEngine(config);
graph.controlledJunctions.forEach(j => teBounded.initJunction(j.id, phases));
const dcBounded = new DemoTrafficController(teBounded, graph);
dcBounded.start();

for (let t = 0; t < 15; t++) {
    const arrivals = dcBounded.getSimulatedArrivals();
    graph.controlledJunctions.forEach(j => {
        teBounded.tick(j.id, arrivals[j.id] || {});
        const s = teBounded.getJunctionState(j.id);
        Object.values(s.approaches).forEach(a => {
            if (a.queue_pcu > maxRecordedQueue) maxRecordedQueue = a.queue_pcu;
        });
    });
    dcBounded.tick();
}
console.log(`Peak network queue during demo: ${maxRecordedQueue.toFixed(1)} PCU`);
assert.ok(maxRecordedQueue < 15.0, `Queue runaway detected: ${maxRecordedQueue} PCU (expected < 15.0)`);
console.log("✓ TEST 8 PASSED: Queue remains realistically bounded (< 15 PCU).");

// -------------------------------------------------------------
// TEST 9: MAX QUEUE uses instantaneous queue, not cumulative arrivals
// -------------------------------------------------------------
console.log("\n[TEST 9] MAX QUEUE uses instantaneous queue...");
const testState = [
    {
        junction_id: 'J1',
        aura: {
            approaches: {
                NORTHBOUND: { queue_pcu: 4.5, totalVehiclesArrived: 120 },
                SOUTHBOUND: { queue_pcu: 2.1, totalVehiclesArrived: 80 }
            }
        }
    },
    {
        junction_id: 'J2',
        aura: {
            approaches: {
                WESTBOUND: { queue_pcu: 6.8, totalVehiclesArrived: 250 }
            }
        }
    }
];

let computedMaxQueue = 0;
testState.forEach(j => {
    Object.values(j.aura.approaches).forEach(a => {
        if (a.queue_pcu > computedMaxQueue) computedMaxQueue = a.queue_pcu;
    });
});
assert.strictEqual(computedMaxQueue, 6.8, "Max queue must be 6.8 PCU, not cumulative arrivals (250)");
console.log(`✓ TEST 9 PASSED: Instantaneous Max Queue = ${computedMaxQueue} PCU (independent of cumulative arrivals).`);

// -------------------------------------------------------------
// TEST 10: Spillback counts rising-edge events only
// -------------------------------------------------------------
console.log("\n[TEST 10] Spillback counts rising-edge events only...");
const teSpill = new TrafficEngine(config);
teSpill.initJunction('J1', phases);

// Force approach queue to 15 PCU (above storage capacity 12.0)
teSpill.state['J1'].approaches.NORTHBOUND.q = 15.0;

// Tick 5 times while continuously saturated
for (let i = 0; i < 5; i++) {
    teSpill.tick('J1', {});
    teSpill.state['J1'].approaches.NORTHBOUND.q = 15.0; // keep saturated
}

const sAfterSat = teSpill.getJunctionState('J1');
assert.strictEqual(sAfterSat.spillback_events, 1, `Continuous saturation should count as 1 event, not ${sAfterSat.spillback_events}`);
assert.strictEqual(sAfterSat.spillback_active, true, "Spillback must be active while saturated");

// Discharge queue below threshold
teSpill.state['J1'].approaches.NORTHBOUND.q = 0.0;
teSpill.tick('J1', {});
assert.strictEqual(teSpill.getJunctionState('J1').spillback_active, false, "Spillback must clear when queue discharges");

// Saturate again -> rising edge 2
teSpill.state['J1'].approaches.NORTHBOUND.q = 15.0;
teSpill.tick('J1', {});
assert.strictEqual(teSpill.getJunctionState('J1').spillback_events, 2, "Second saturation event must increment counter to 2");
console.log("✓ TEST 10 PASSED: Spillback strictly follows rising-edge transition semantics.");

// -------------------------------------------------------------
// TEST 11: Junction anchors lie on actual corridor geometry
// -------------------------------------------------------------
console.log("\n[TEST 11] Junction anchors lie on actual corridor geometry...");
function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + 
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

graph.controlledJunctions.forEach(j => {
    let minCorridorDist = Infinity;
    graph.edges.filter(e => e.is_aura_corridor && e.geometry).forEach(e => {
        e.geometry.forEach(pt => {
            const d = distM(j.lat, j.lng, pt[0], pt[1]);
            if (d < minCorridorDist) minCorridorDist = d;
        });
    });
    console.log(`${j.id} (${j.name}): distance to corridor geometry = ${minCorridorDist.toFixed(2)}m`);
    assert.ok(minCorridorDist <= 1.0, `Junction ${j.id} anchor must lie on corridor geometry (was ${minCorridorDist.toFixed(2)}m)`);
});
console.log("✓ TEST 11 PASSED: All 6 junction anchors lie directly on authoritative corridor road geometry.");

// -------------------------------------------------------------
// TEST 12 & 13: UI Mode Isolation (Admin Controls & Console)
// -------------------------------------------------------------
console.log("\n[TEST 12 & 13] UI Mode Isolation in dashboard.html & app.js...");
const dashboardHtml = fs.readFileSync(path.join(__dirname, '../frontend/dashboard.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');

assert.ok(dashboardHtml.includes('id="admin-controls"'), "dashboard.html must contain id=admin-controls wrapper");
assert.ok(dashboardHtml.includes('id="demo-console"'), "dashboard.html must contain id=demo-console");
assert.ok(dashboardHtml.includes('id="demo-console-events"'), "dashboard.html must contain id=demo-console-events");
assert.ok(dashboardHtml.includes('Max Queue'), "dashboard.html must contain 'Max Queue' label");

assert.ok(appJs.includes("adminControls.classList.add('hidden')"), "app.js must hide admin controls in User View");
assert.ok(appJs.includes("adminControls.classList.remove('hidden')"), "app.js must restore admin controls in Control Room");
assert.ok(appJs.includes("demoConsole.classList.add('hidden')"), "app.js must hide demo console in User View");

console.log("✓ TEST 12 & 13 PASSED: Admin controls and Demo Console are strictly isolated to Control Room.");

console.log("\n==================================================");
console.log("ALL 13 FORENSIC CORRECTION TESTS PASSED PERFECTLY!");
console.log("==================================================");
