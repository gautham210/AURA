const WebSocket = require('ws');

async function testExclusion() {
    const ws = new WebSocket('ws://localhost:3000');

    await new Promise((resolve) => ws.on('open', resolve));
    console.log("WebSocket connected to fresh server.");

    // Helper to wait for a SIMULATED_TRAFFIC_STATE message
    function waitForState() {
        return new Promise((resolve) => {
            const handler = (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data.event === 'SIMULATED_TRAFFIC_STATE') {
                        ws.off('message', handler);
                        resolve(data.data);
                    }
                } catch (e) {}
            };
            ws.on('message', handler);
        });
    }

    // Step 1: Send START_DEMO
    console.log("\n--- Testing START_DEMO ---");
    ws.send(JSON.stringify({ event: 'START_DEMO' }));
    
    // Wait for the next tick
    let state = await waitForState();
    console.log(`START_DEMO runtime state:`);
    console.log(`  traffic_demo_state   = ${state.traffic_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  emergency_demo_state = ${state.emergency_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  traffic phase        = ${state.traffic_demo_state.phase}`);

    // Step 2: Send TRIGGER_EMERGENCY (Simulate Emergency)
    console.log("\n--- Testing SIMULATE_EMERGENCY (TRIGGER_EMERGENCY) ---");
    ws.send(JSON.stringify({ event: 'TRIGGER_EMERGENCY' }));

    state = await waitForState();
    console.log(`SIMULATE_EMERGENCY runtime state:`);
    console.log(`  traffic_demo_state   = ${state.traffic_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  emergency_demo_state = ${state.emergency_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  emergency phase      = ${state.emergency_demo_state.phase}`);

    // Step 3: Trigger START_DEMO while emergency is active
    console.log("\n--- Testing START_DEMO while EMERGENCY is active ---");
    ws.send(JSON.stringify({ event: 'START_DEMO' }));
    state = await waitForState();
    console.log(`START_DEMO while emergency active:`);
    console.log(`  traffic_demo_state   = ${state.traffic_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  emergency_demo_state = ${state.emergency_demo_state.active ? 'active' : 'inactive'}`);

    // Step 4: Send RESET_DEMO
    console.log("\n--- Testing RESET_DEMO ---");
    ws.send(JSON.stringify({ event: 'RESET_DEMO' }));
    state = await waitForState();
    console.log(`RESET_DEMO runtime state:`);
    console.log(`  traffic_demo_state   = ${state.traffic_demo_state.active ? 'active' : 'inactive'}`);
    console.log(`  emergency_demo_state = ${state.emergency_demo_state.active ? 'active' : 'inactive'}`);

    ws.close();
    process.exit(0);
}

testExclusion().catch((e) => {
    console.error(e);
    process.exit(1);
});
