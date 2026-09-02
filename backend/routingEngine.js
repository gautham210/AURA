class RoutingEngine {
    constructor(graph) {
        this.graph = graph;
        this.nominal_speed = 10; // m/s
    }

    calculateCosts(networkState, edge, isAuraCooperative) {
        const travel_time = edge.distance / this.nominal_speed;
        
        // Find utilization of target junction
        const targetJunction = networkState.find(j => j.junction_id === edge.to);
        
        let utilization = 0;
        let queue_pcu = 0;

        if (targetJunction && targetJunction.aura) {
            const approachState = targetJunction.aura.approaches[edge.approachAtTarget];
            if (approachState) {
                queue_pcu = approachState.queue_pcu;
                // Assuming 50 PCU is full saturation for demo routing
                utilization = Math.min(1.0, queue_pcu / 50.0);
            }
        }

        // Individual congestion factor
        const individual_factor = 1.0 + (utilization * 1.0);
        let cost = travel_time * individual_factor;
        let explanation = '';

        if (isAuraCooperative) {
            // Marginal penalty: heavily penalize routes > 70% saturated
            let marginal_penalty = 0;
            if (utilization > 0.7) {
                marginal_penalty = travel_time * 5.0; // 5x penalty
                explanation = `Route avoids ${edge.to} due to high saturation (${Math.round(utilization*100)}%)`;
            } else if (utilization > 0.4) {
                marginal_penalty = travel_time * 1.5;
            }
            cost += marginal_penalty;
        }

        return { cost, utilization, explanation };
    }

    dijkstra(originId, destId, networkState, isAuraCooperative) {
        const dist = {};
        const prev = {};
        const unvisited = new Set();
        const explanations = {};

        this.graph.junctions.forEach(j => {
            dist[j.id] = Infinity;
            unvisited.add(j.id);
        });
        dist[originId] = 0;

        while (unvisited.size > 0) {
            let u = null;
            for (let node of unvisited) {
                if (u === null || dist[node] < dist[u]) {
                    u = node;
                }
            }

            if (dist[u] === Infinity) break;
            if (u === destId) break;

            unvisited.delete(u);

            const neighbors = this.graph.edges.filter(e => e.from === u);
            for (let edge of neighbors) {
                if (!unvisited.has(edge.to)) continue;

                const { cost, explanation } = this.calculateCosts(networkState, edge, isAuraCooperative);
                const alt = dist[u] + cost;
                if (alt < dist[edge.to]) {
                    dist[edge.to] = alt;
                    prev[edge.to] = u;
                    if (explanation) {
                        explanations[edge.to] = explanation;
                    }
                }
            }
        }

        const path = [];
        let curr = destId;
        if (prev[curr] || curr === originId) {
            while (curr) {
                path.unshift(curr);
                curr = prev[curr];
            }
        }

        let totalDistance = 0;
        let finalExplanation = "Fastest available route based on current state.";
        let highestUtil = 0;
        let bottleneckNode = null;

        for (let i = 0; i < path.length - 1; i++) {
            const e = this.graph.edges.find(edge => edge.from === path[i] && edge.to === path[i+1]);
            if (e) {
                totalDistance += e.distance;
                const stats = this.calculateCosts(networkState, e, false);
                if (stats.utilization > highestUtil) {
                    highestUtil = stats.utilization;
                    bottleneckNode = e.to;
                }
            }
            if (explanations[path[i+1]]) {
                finalExplanation = explanations[path[i+1]];
            }
        }

        return {
            route: path,
            distance: totalDistance,
            estimatedTime: dist[destId],
            congestionExposure: highestUtil,
            explanation: finalExplanation,
            bottleneckNode: bottleneckNode
        };
    }

    findRoutes(origin, destination, networkState) {
        if (!origin || !destination) return null;
        
        const individual = this.dijkstra(origin, destination, networkState, false);
        const aura = this.dijkstra(origin, destination, networkState, true);

        if (individual.route.join('->') !== aura.route.join('->')) {
            aura.explanation = `Individual route uses saturated ${individual.bottleneckNode} (${Math.round(individual.congestionExposure*100)}%). AURA recommends alternative to prevent spillback.`;
        } else if (individual.route.join('->') === aura.route.join('->') && individual.congestionExposure < 0.4) {
            aura.explanation = `Network has capacity. No routing diversion needed.`;
        }

        return { individual, aura, timestamp: new Date().toISOString() };
    }
}

module.exports = { RoutingEngine };
