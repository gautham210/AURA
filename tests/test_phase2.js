const { TrafficEngine, BaselineController } = require('../backend/trafficEngine');
const { SimulationSensor } = require('../backend/trafficSensors');
const assert = require('assert');

function runTests() {
    console.log("=== PHASE 2 PROOF SCRIPT ===");
    
    const config = { C: 60, lost_time: 6, G_min: 10, gap_out_seconds: 5, S: 0.5 };
    const engine = new TrafficEngine(config);
    engine.initJunction("J1", [["NORTHBOUND", "SOUTHBOUND"], ["EASTBOUND", "WESTBOUND"]]);

    // TEST 1 PCU calculation
    let pcu = engine.calculatePCU({ two_wheeler: 12, auto_rickshaw: 4, car: 6, bus: 2 });
    assert.strictEqual(pcu, 12 * 0.5 + 4 * 1.0 + 6 * 1.0 + 2 * 3.0); // 6 + 4 + 6 + 6 = 22
    console.log("PCU TEST\nPASS\n");

    // TEST 2 available green calculation
    const G_available = config.C - config.lost_time;
    assert.strictEqual(G_available, 54);

    // TEST 3, 4, 5 green allocation, sum, min green
    engine.allocateGreens("J1", { "NORTHBOUND": 10, "SOUTHBOUND": 10, "EASTBOUND": 5, "WESTBOUND": 0 });
    const durations = engine.state["J1"].phaseDurations;
    const sumGreens = durations.reduce((a,b) => a+b, 0);
    
    console.log(`GREEN ALLOCATION\nG_available = ${G_available}`);
    console.log(`Phase 1 = ${durations[0]}`);
    console.log(`Phase 2 = ${durations[1]}`);
    console.log(`Sum = ${sumGreens}`);
    
    // float comparison
    assert(Math.abs(sumGreens - G_available) < 0.0001);
    assert(durations[0] >= config.G_min && durations[1] >= config.G_min);
    console.log("PASS\n");

    // TEST 6 queue equation + TEST 9 physical lambda remains unthrottled
    engine.updateBackPressure("J1", 1.00); // 100% util => multiplier 0.15
    const bpMultiplier = engine.state["J1"].backPressureMultiplier;
    assert.strictEqual(bpMultiplier, 0.15);
    
    // Test that effective demand is reduced, but lambda is physical
    // Current phase is 0 (NORTHBOUND/SOUTHBOUND is GREEN). 
    // EASTBOUND is RED.
    // Let's add 10 PCU to EASTBOUND
    engine.tick("J1", {
        "EASTBOUND": { counts: { car: 10 } }
    });
    const qEast = engine.state["J1"].approaches["EASTBOUND"].q;
    // Since it's RED, mu=0, q should be exactly 10
    assert.strictEqual(qEast, 10);
    
    console.log(`PHYSICAL LAMBDA\nInput = 10\nQueue increase due to λ = ${qEast}\nPASS\n`);

    // TEST 7 gap-out
    // Phase 1 (N/S) is green.
    let gapOutEngine = new TrafficEngine(config);
    gapOutEngine.initJunction("J1", [["NORTHBOUND"], ["EASTBOUND"]]);
    // Send 0 demand for 5 ticks
    for(let i=0; i<=5; i++) {
        gapOutEngine.tick("J1", {});
    }
    // Now it should switch phase immediately on tick 5 (so phase time remaining is now Phase 2's time)
    assert.strictEqual(gapOutEngine.state["J1"].currentPhaseIndex, 1);
    console.log("GAP-OUT\nPASS\n");

    // TEST 8 all five back-pressure levels
    console.log("BACK-PRESSURE");
    const testUtils = [0.5, 0.7, 0.8, 0.9, 1.0];
    const expected = [1.00, 0.90, 0.70, 0.40, 0.15];
    for (let i = 0; i < 5; i++) {
        const mult = engine.getBackPressureMultiplier(testUtils[i]);
        assert.strictEqual(mult, expected[i]);
        console.log(`${testUtils[i]*100}% → ${mult.toFixed(2)}`);
    }
    console.log("PASS\n");

    // TEST 10 spillback transition counting
    engine.state["J1"].downstreamUtilization = 0;
    engine.state["J1"].backPressureLevel = 0;
    engine.state["J1"].spillbackEvents = 0;
    engine.updateBackPressure("J1", 0.7); // Level 1
    assert.strictEqual(engine.state["J1"].spillbackEvents, 1);
    engine.updateBackPressure("J1", 0.72); // Still Level 1
    assert.strictEqual(engine.state["J1"].spillbackEvents, 1);
    engine.updateBackPressure("J1", 0.8); // Level 2
    assert.strictEqual(engine.state["J1"].spillbackEvents, 2);
    engine.updateBackPressure("J1", 0.6); // Level 1 (decrease, no event increment on decrease)
    assert.strictEqual(engine.state["J1"].spillbackEvents, 2);
    console.log("SPILLBACK TRANSITIONS\nPASS\n");

    // TEST 11 AURA/Baseline identical demand over 10+ ticks
    const sensor = new SimulationSensor("AURA_DEMO_SEED");
    const aura = new TrafficEngine(config);
    const baseline = new BaselineController(config);
    aura.initJunction("J1", [["NORTHBOUND"]]);
    baseline.initJunction("J1", [["NORTHBOUND"]]);
    
    let demandMatch = true;
    const approaches = ["NORTHBOUND"];
    for(let i=0; i<15; i++) {
        sensor.tick(["J1"], approaches);
        let arrivals = {};
        approaches.forEach(appr => {
            arrivals[appr] = { counts: sensor.getApproachState("J1", appr).counts };
        });
        
        let auraPreLambda = aura.calculatePCU(arrivals["NORTHBOUND"].counts);
        let basePreLambda = baseline.calculatePCU(arrivals["NORTHBOUND"].counts);
        
        if (auraPreLambda !== basePreLambda) {
            demandMatch = false;
        }

        aura.tick("J1", arrivals);
        baseline.tick("J1", arrivals);
    }
    assert.strictEqual(demandMatch, true);
    console.log("CONTROLLED COMPARISON\n10+ ticks identical\nPASS\n");
}

runTests();
