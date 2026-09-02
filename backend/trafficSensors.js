const seedrandom = require('seedrandom');

class SimulationSensor {
    constructor(seed = "AURA_DEMO_SEED") {
        this.rng = seedrandom(seed);
        this.state = {};
    }

    tick(junctionIds, approaches) {
        junctionIds.forEach(jid => {
            if (!this.state[jid]) this.state[jid] = {};
            approaches.forEach(appr => {
                const r = this.rng();
                const isCar = r < 0.10;
                const isTwoWheeler = r > 0.90;
                
                let counts = { two_wheeler: 0, auto_rickshaw: 0, car: 0, bus: 0 };
                if (isCar) counts.car = 1;
                if (isTwoWheeler) counts.two_wheeler = 2;
                
                this.state[jid][appr] = {
                    counts: counts,
                    sourceMode: "SIMULATED"
                };
            });
        });
    }

    getApproachState(junctionId, approach) {
        return this.state[junctionId][approach];
    }
}

class HybridSensor {
    constructor(fallbackSensor, timeoutMs = 5000) {
        this.fallbackSensor = fallbackSensor;
        this.timeoutMs = timeoutMs;
        this.visionState = {};
        this.lastSeen = {};
    }

    injectVisionData(junctionId, approach, data, mode = "REPLAY") {
        if (!this.visionState[junctionId]) this.visionState[junctionId] = {};
        if (!this.lastSeen[junctionId]) this.lastSeen[junctionId] = {};

        this.visionState[junctionId][approach] = {
            counts: data.counts,
            sourceMode: mode
        };
        this.lastSeen[junctionId][approach] = Date.now();
    }

    tick(junctionIds, approaches) {
        this.fallbackSensor.tick(junctionIds, approaches);
    }

    getApproachState(junctionId, approach) {
        const now = Date.now();
        if (this.visionState[junctionId] && this.visionState[junctionId][approach]) {
            const lastTime = this.lastSeen[junctionId][approach] || 0;
            if (now - lastTime < this.timeoutMs) {
                const state = this.visionState[junctionId][approach];
                // Consume the new arrivals, then clear them so they aren't double counted if no new injection occurs
                this.visionState[junctionId][approach] = { counts: {}, sourceMode: state.sourceMode };
                return state;
            }
        }
        // Fallback
        const state = this.fallbackSensor.getApproachState(junctionId, approach);
        // Ensure sourceMode reflects fallback
        return { ...state, sourceMode: "SIMULATED" };
    }
}

module.exports = { SimulationSensor, HybridSensor };
