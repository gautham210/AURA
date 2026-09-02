class TrafficEngine {
    constructor(config) {
        this.config = {
            C: config.C || 60,
            lost_time: config.lost_time || 6,
            G_min: config.G_min || 10,
            gap_out_seconds: config.gap_out_seconds || 5,
            S: config.S || 0.5,
            PCU_WEIGHTS: {
                two_wheeler: 0.5,
                auto_rickshaw: 1.0,
                car: 1.0,
                bus: 3.0,
                'Two-wheeler': 0.5, 'bicycle': 0.5, 'Three-wheeler': 0.5,
                'Hatchback': 1.0, 'Sedan': 1.0, 'SUV': 1.0, 'Van': 1.0, 'Others': 1.0,
                'MUV': 3.0, 'Bus': 3.0, 'Truck': 3.0, 'LCV': 3.0, 'Mini-bus': 3.0, 'tempo-traveller': 3.0
            }
        };

        // State for each junction
        this.state = {};
    }

    initJunction(junctionId, phases) {
        // phases is an array of approaches or array of array of approaches
        // For simplicity in a 2-phase intersection:
        // Phase 1: ["NORTHBOUND", "SOUTHBOUND"]
        // Phase 2: ["EASTBOUND", "WESTBOUND"]
        this.state[junctionId] = {
            phases: phases,
            currentPhaseIndex: 0,
            phaseTimeRemaining: 0,
            approaches: {},
            downstreamUtilization: 0, // Mocked or calculated externally if full network
            backPressureMultiplier: 1.0,
            backPressureLevel: 0, 
            spillbackEvents: 0,
            emergency: {
                active: false,
                approach: null,
                state: 'NORMAL',
                timer: 0
            }
        };

        for (const phaseApproaches of phases) {
            for (const approach of phaseApproaches) {
                this.state[junctionId].approaches[approach] = {
                    q: 0,
                    max_q: 0,
                    totalAccumulatedDelay: 0,
                    totalVehiclesArrived: 0,
                    emptySeconds: 0, // for gap-out
                    signalState: "RED"
                };
            }
        }
        
        // Initial allocation
        this.allocateGreens(junctionId, {});
    }

    calculatePCU(counts) {
        let pcu = 0;
        pcu += (counts.two_wheeler || 0) * this.config.PCU_WEIGHTS.two_wheeler;
        pcu += (counts.auto_rickshaw || 0) * this.config.PCU_WEIGHTS.auto_rickshaw;
        pcu += (counts.car || 0) * this.config.PCU_WEIGHTS.car;
        pcu += (counts.bus || 0) * this.config.PCU_WEIGHTS.bus;
        return pcu;
    }

    getBackPressureMultiplier(utilization) {
        if (utilization < 0.60) return 1.00;
        if (utilization < 0.75) return 0.90;
        if (utilization < 0.85) return 0.70;
        if (utilization < 0.95) return 0.40;
        return 0.15;
    }

    getBackPressureLevel(utilization) {
        if (utilization < 0.60) return 0;
        if (utilization < 0.75) return 1;
        if (utilization < 0.85) return 2;
        if (utilization < 0.95) return 3;
        return 4;
    }

    updateBackPressure(junctionId, downstreamUtilization) {
        const junction = this.state[junctionId];
        junction.downstreamUtilization = downstreamUtilization;
        const newLevel = this.getBackPressureLevel(downstreamUtilization);
        
        if (newLevel > junction.backPressureLevel) {
            junction.spillbackEvents += 1;
        }
        junction.backPressureLevel = newLevel;
        junction.backPressureMultiplier = this.getBackPressureMultiplier(downstreamUtilization);
    }

    setEmergencyPreemption(junctionId, approach) {
        const junction = this.state[junctionId];
        if (!junction) return;

        if (approach) {
            // Activate: CLEARING for 3 ticks, then tick() transitions to EMERGENCY_GREEN
            junction.emergency.active = true;
            junction.emergency.approach = approach;
            junction.emergency.state = 'CLEARING';
            junction.emergency.timer = 3;
        } else {
            // Deactivate: RECOVERY for 3 ticks, then tick() transitions to NORMAL
            if (junction.emergency.active) {
                junction.emergency.state = 'RECOVERY';
                junction.emergency.timer = 3;
            } else {
                // Already inactive, ensure clean state
                junction.emergency.active = false;
                junction.emergency.approach = null;
                junction.emergency.state = 'NORMAL';
                junction.emergency.timer = 0;
            }
        }
    }

    allocateGreens(junctionId, demandPCU) {
        const junction = this.state[junctionId];
        const G_available = this.config.C - this.config.lost_time;
        const K = junction.phases.length;
        const G_floor_total = this.config.G_min * K;
        const G_remaining = Math.max(0, G_available - G_floor_total);

        junction.phaseDurations = [];
        let P_total = 0;
        let phaseDemands = [];

        for (let i = 0; i < K; i++) {
            let pPhase = 0;
            for (const app of junction.phases[i]) {
                const pcu = demandPCU[app] || 0;
                pPhase += pcu * junction.backPressureMultiplier; // Effective demand
            }
            phaseDemands.push(pPhase);
            P_total += pPhase;
        }

        for (let i = 0; i < K; i++) {
            let G_k;
            if (P_total === 0) {
                G_k = this.config.G_min + G_remaining * (1 / K);
            } else {
                G_k = this.config.G_min + G_remaining * (phaseDemands[i] / P_total);
            }
            junction.phaseDurations.push(G_k);
        }
        
        junction.phaseTimeRemaining = junction.phaseDurations[junction.currentPhaseIndex];
    }

    tick(junctionId, arrivals) {
        const junction = this.state[junctionId];
        
        // Gap-out logic
        let currentPhaseEmpty = true;
        for (const app of junction.phases[junction.currentPhaseIndex]) {
            const arr = arrivals[app] || {counts: {two_wheeler:0, auto_rickshaw:0, car:0, bus:0}};
            const lambda = this.calculatePCU(arr.counts);
            if (junction.approaches[app].q > 0 || lambda > 0) {
                currentPhaseEmpty = false;
                junction.approaches[app].emptySeconds = 0;
            } else {
                junction.approaches[app].emptySeconds += 1;
            }
        }

        let gapOutTriggered = false;
        if (currentPhaseEmpty) {
            let allEmptyLongEnough = true;
            for (const app of junction.phases[junction.currentPhaseIndex]) {
                if (junction.approaches[app].emptySeconds < this.config.gap_out_seconds) {
                    allEmptyLongEnough = false;
                }
            }
            if (allEmptyLongEnough && junction.phaseTimeRemaining > 0) {
                gapOutTriggered = true;
            }
        }

        // --- Emergency Override Logic ---
        if (junction.emergency.active) {
            if (junction.emergency.state === 'CLEARING') {
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) junction.approaches[app].signalState = "RED"; // (Could be AMBER conceptually)
                }
                junction.emergency.timer--;
                if (junction.emergency.timer <= 0) {
                    junction.emergency.state = 'EMERGENCY_GREEN';
                }
            } else if (junction.emergency.state === 'EMERGENCY_GREEN') {
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) {
                        junction.approaches[app].signalState = (app === junction.emergency.approach) ? "GREEN" : "RED";
                    }
                }
            } else if (junction.emergency.state === 'RECOVERY') {
                for (let i = 0; i < junction.phases.length; i++) {
                    for (const app of junction.phases[i]) junction.approaches[app].signalState = "RED";
                }
                junction.emergency.timer--;
                if (junction.emergency.timer <= 0) {
                    junction.emergency.active = false;
                    junction.emergency.state = 'NORMAL';
                }
            }
        } else {
            // --- Normal Signal Logic ---
            if (gapOutTriggered || junction.phaseTimeRemaining <= 0) {
                // Next phase
                junction.currentPhaseIndex = (junction.currentPhaseIndex + 1) % junction.phases.length;
                if (junction.currentPhaseIndex === 0) {
                    // Reallocate greens based on current queue + recent arrivals (mocking actual demand info here)
                    let demandPCU = {};
                    for (let i = 0; i < junction.phases.length; i++) {
                        for (const app of junction.phases[i]) {
                            demandPCU[app] = junction.approaches[app].q;
                        }
                    }
                    this.allocateGreens(junctionId, demandPCU);
                } else {
                    junction.phaseTimeRemaining = junction.phaseDurations[junction.currentPhaseIndex];
                }
            } else {
                junction.phaseTimeRemaining -= 1;
            }

            // Update signals based on phase
            for (let i = 0; i < junction.phases.length; i++) {
                const isGreen = (i === junction.currentPhaseIndex);
                for (const app of junction.phases[i]) {
                    junction.approaches[app].signalState = isGreen ? "GREEN" : "RED";
                }
            }
        }

        // Queue model
        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const approachState = junction.approaches[app];
                const arr = arrivals[app] || {counts: {two_wheeler:0, auto_rickshaw:0, car:0, bus:0}};
                const lambda = this.calculatePCU(arr.counts);
                
                let mu = 0;
                if (approachState.signalState === "GREEN") {
                    mu = Math.min(approachState.q + lambda, this.config.S);
                }

                approachState.q = Math.max(0, approachState.q + lambda - mu);
                approachState.max_q = Math.max(approachState.max_q, approachState.q);
                
                approachState.totalVehiclesArrived += lambda;
                approachState.totalAccumulatedDelay += approachState.q * 1; // Delay = queue length (PCU) per second
            }
        }
    }

    getJunctionState(junctionId) {
        const junction = this.state[junctionId];
        let state = {
            current_phase: junction.currentPhaseIndex + 1,
            current_phase_description: junction.phases[junction.currentPhaseIndex].join(" + "),
            phase_durations: junction.phaseDurations,
            phase_time_remaining: junction.phaseTimeRemaining,
            back_pressure_multiplier: junction.backPressureMultiplier,
            spillback_events: junction.spillbackEvents,
            approaches: {}
        };
        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const aState = junction.approaches[app];
                const avgDelay = aState.totalVehiclesArrived > 0 ? (aState.totalAccumulatedDelay / aState.totalVehiclesArrived) : 0;
                state.approaches[app] = {
                    signal_state: aState.signalState,
                    queue_pcu: +(aState.q.toFixed(2)),
                    max_queue_pcu: +(aState.max_q.toFixed(2)),
                    avg_delay_seconds: +(avgDelay.toFixed(1))
                };
            }
        }
        return state;
    }
}

class BaselineController {
    constructor(config) {
        this.config = {
            phase1Duration: 30,
            phase2Duration: 30,
            S: config.S || 0.5,
            PCU_WEIGHTS: {
                two_wheeler: 0.5,
                auto_rickshaw: 1.0,
                car: 1.0,
                bus: 3.0
            }
        };
        this.state = {};
    }

    initJunction(junctionId, phases) {
        this.state[junctionId] = {
            phases: phases,
            currentPhaseIndex: 0,
            phaseTimeRemaining: this.config.phase1Duration,
            approaches: {},
            spillbackEvents: 0
        };

        for (const phaseApproaches of phases) {
            for (const approach of phaseApproaches) {
                this.state[junctionId].approaches[approach] = {
                    q: 0,
                    max_q: 0,
                    totalAccumulatedDelay: 0,
                    totalVehiclesArrived: 0,
                    signalState: "RED"
                };
            }
        }
    }

    calculatePCU(counts) {
        let pcu = 0;
        pcu += (counts.two_wheeler || 0) * this.config.PCU_WEIGHTS.two_wheeler;
        pcu += (counts.auto_rickshaw || 0) * this.config.PCU_WEIGHTS.auto_rickshaw;
        pcu += (counts.car || 0) * this.config.PCU_WEIGHTS.car;
        pcu += (counts.bus || 0) * this.config.PCU_WEIGHTS.bus;
        return pcu;
    }

    tick(junctionId, arrivals) {
        const junction = this.state[junctionId];
        
        // Fixed timer logic
        if (junction.phaseTimeRemaining <= 0) {
            junction.currentPhaseIndex = (junction.currentPhaseIndex + 1) % junction.phases.length;
            junction.phaseTimeRemaining = junction.currentPhaseIndex === 0 ? this.config.phase1Duration : this.config.phase2Duration;
        } else {
            junction.phaseTimeRemaining -= 1;
        }

        for (let i = 0; i < junction.phases.length; i++) {
            const isGreen = (i === junction.currentPhaseIndex);
            for (const app of junction.phases[i]) {
                junction.approaches[app].signalState = isGreen ? "GREEN" : "RED";
            }
        }

        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const approachState = junction.approaches[app];
                const arr = arrivals[app] || {counts: {two_wheeler:0, auto_rickshaw:0, car:0, bus:0}};
                const lambda = this.calculatePCU(arr.counts);
                
                let mu = 0;
                if (approachState.signalState === "GREEN") {
                    mu = Math.min(approachState.q + lambda, this.config.S);
                }

                approachState.q = Math.max(0, approachState.q + lambda - mu);
                approachState.max_q = Math.max(approachState.max_q, approachState.q);
                
                approachState.totalVehiclesArrived += lambda;
                approachState.totalAccumulatedDelay += approachState.q * 1; 
            }
        }
    }

    getJunctionState(junctionId) {
        const junction = this.state[junctionId];
        let state = {
            current_phase: junction.currentPhaseIndex + 1,
            current_phase_description: junction.phases[junction.currentPhaseIndex].join(" + "),
            phase_time_remaining: junction.phaseTimeRemaining,
            spillback_events: junction.spillbackEvents,
            approaches: {}
        };
        for (const phaseApproaches of junction.phases) {
            for (const app of phaseApproaches) {
                const aState = junction.approaches[app];
                const avgDelay = aState.totalVehiclesArrived > 0 ? (aState.totalAccumulatedDelay / aState.totalVehiclesArrived) : 0;
                state.approaches[app] = {
                    signal_state: aState.signalState,
                    queue_pcu: +(aState.q.toFixed(2)),
                    max_queue_pcu: +(aState.max_q.toFixed(2)),
                    avg_delay_seconds: +(avgDelay.toFixed(1))
                };
            }
        }
        return state;
    }

    setEmergencyPreemption(junctionId, approach) {
        if (!this.state[junctionId]) return;
        const junction = this.state[junctionId];
        
        if (approach) {
            if (junction.emergency.approach !== approach) {
                junction.emergency.active = true;
                junction.emergency.approach = approach;
                if (junction.emergency.state === 'NORMAL' || junction.emergency.state === 'RECOVERY') {
                    junction.emergency.state = 'CLEARING';
                    junction.emergency.timer = 3;
                }
            }
        } else {
            if (junction.emergency.active) {
                junction.emergency.state = 'RECOVERY';
                junction.emergency.timer = 2;
                junction.emergency.approach = null;
            }
        }
    }
}

module.exports = { TrafficEngine, BaselineController };
