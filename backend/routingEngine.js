class MinHeap {
    constructor() { this.heap = []; }
    push(val, priority) {
        this.heap.push({val, priority});
        this.bubbleUp(this.heap.length - 1);
    }
    pop() {
        if (this.heap.length === 1) return this.heap.pop().val;
        const top = this.heap[0].val;
        this.heap[0] = this.heap.pop();
        this.bubbleDown(0);
        return top;
    }
    isEmpty() { return this.heap.length === 0; }
    bubbleUp(idx) {
        while (idx > 0) {
            let parent = Math.floor((idx - 1) / 2);
            if (this.heap[parent].priority <= this.heap[idx].priority) break;
            [this.heap[parent], this.heap[idx]] = [this.heap[idx], this.heap[parent]];
            idx = parent;
        }
    }
    bubbleDown(idx) {
        const len = this.heap.length;
        while (true) {
            let left = 2 * idx + 1, right = 2 * idx + 2, min = idx;
            if (left < len && this.heap[left].priority < this.heap[min].priority) min = left;
            if (right < len && this.heap[right].priority < this.heap[min].priority) min = right;
            if (min === idx) break;
            [this.heap[min], this.heap[idx]] = [this.heap[idx], this.heap[min]];
            idx = min;
        }
    }
}

class RoutingEngine {
    constructor(graph) {
        this.graph = graph;
        this.nominal_speed = 10; // m/s
        
        // Fast adjacency lookup
        this.adj = {};
        for (let node of this.graph.nodes) {
            this.adj[node.id] = [];
        }
        for (let edge of this.graph.edges) {
            if (!this.adj[edge.from]) this.adj[edge.from] = [];
            this.adj[edge.from].push(edge);
        }
    }

    findNearestEdge(lat, lng) {
        let minSqDist = Infinity;
        let bestEdge = null;
        let projPoint = null;

        const p = { lat, lng };

        for (let edge of this.graph.edges) {
            if (!edge.geometry || edge.geometry.length < 2) continue;
            
            for (let i = 0; i < edge.geometry.length - 1; i++) {
                const v = { lat: edge.geometry[i][0], lng: edge.geometry[i][1] };
                const w = { lat: edge.geometry[i+1][0], lng: edge.geometry[i+1][1] };
                
                const l2 = (v.lat - w.lat)**2 + (v.lng - w.lng)**2;
                let t = 0;
                if (l2 !== 0) {
                    t = ((p.lat - v.lat) * (w.lat - v.lat) + (p.lng - v.lng) * (w.lng - v.lng)) / l2;
                    t = Math.max(0, Math.min(1, t));
                }
                
                const pLat = v.lat + t * (w.lat - v.lat);
                const pLng = v.lng + t * (w.lng - v.lng);
                
                const sqDist = (p.lat - pLat)**2 + (p.lng - pLng)**2;
                
                if (sqDist < minSqDist) {
                    minSqDist = sqDist;
                    bestEdge = edge;
                    projPoint = [pLat, pLng];
                }
            }
        }
        
        // Convert approx sq degree distance to meters (1 deg ≈ 111320m)
        const distMeters = Math.sqrt(minSqDist) * 111320;
        return { edge: bestEdge, distMeters, projPoint };
    }

    calculateCosts(networkState, edge, isAuraCooperative) {
        const travel_time = edge.distance / this.nominal_speed;
        
        // Find utilization ONLY if target is a controlled junction
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

        // Individual congestion factor applies at controlled junctions
        const individual_factor = 1.0 + (utilization * 1.0);
        let cost = travel_time * individual_factor;
        let explanation = '';

        if (isAuraCooperative && targetJunction) {
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
        const explanations = {};
        const pq = new MinHeap();

        for (let node of this.graph.nodes) {
            dist[node.id] = Infinity;
        }
        
        dist[originId] = 0;
        pq.push(originId, 0);

        while (!pq.isEmpty()) {
            let u = pq.pop();

            if (u === destId) break;

            const neighbors = this.adj[u] || [];
            for (let edge of neighbors) {
                const { cost, explanation } = this.calculateCosts(networkState, edge, isAuraCooperative);
                const alt = dist[u] + cost;
                
                if (alt < dist[edge.to]) {
                    dist[edge.to] = alt;
                    prev[edge.to] = u;
                    pq.push(edge.to, alt);
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
            const neighbors = this.adj[path[i]] || [];
            const e = neighbors.find(edge => edge.to === path[i+1]);
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
        
        let originNodeId = origin;
        let projectedStartGeometry = null;

        if (typeof origin === 'object' && origin.lat && origin.lng) {
            const nearest = this.findNearestEdge(origin.lat, origin.lng);
            // Configurable threshold: 1000 meters
            if (!nearest.edge || nearest.distMeters > 1000) {
                return { error: "Please choose a starting location on or near a road." };
            }
            originNodeId = nearest.edge.to;
            const targetNode = this.graph.nodes.find(n => n.id === nearest.edge.to);
            if (targetNode && nearest.projPoint) {
                projectedStartGeometry = [nearest.projPoint, [targetNode.lat, targetNode.lng]];
            }
        }

        let destNodeId = destination;
        let projectedEndGeometry = null;

        if (typeof destination === 'object' && destination.lat && destination.lng) {
            const nearestDest = this.findNearestEdge(destination.lat, destination.lng);
            if (!nearestDest.edge || nearestDest.distMeters > 1000) {
                return { error: "Please choose a destination on or near a road." };
            }
            destNodeId = nearestDest.edge.from;
            const fromNode = this.graph.nodes.find(n => n.id === nearestDest.edge.from);
            if (fromNode && nearestDest.projPoint) {
                projectedEndGeometry = [[fromNode.lat, fromNode.lng], nearestDest.projPoint];
            }
        }
        
        const individual = this.dijkstra(originNodeId, destNodeId, networkState, false);
        const aura = this.dijkstra(originNodeId, destNodeId, networkState, true);

        // Name bottleneck node if it's a controlled junction
        let bNodeName = individual.bottleneckNode;
        const bJunc = this.graph.controlledJunctions.find(j => j.id === individual.bottleneckNode || j.osmNodeId === individual.bottleneckNode);
        if (bJunc) bNodeName = bJunc.name;
        
        if (individual.route.join('->') !== aura.route.join('->')) {
            aura.explanation = `Individual route uses saturated ${bNodeName} (${Math.round(individual.congestionExposure*100)}%). AURA recommends alternative to prevent spillback.`;
        } else if (individual.route.join('->') === aura.route.join('->') && individual.congestionExposure < 0.4) {
            aura.explanation = `Network has capacity. No routing diversion needed.`;
        }

        // Return full geometry and POI info for frontend rendering
        const enhanceRoute = (rResult) => {
            let geom = [];
            if (projectedStartGeometry) {
                geom.push(...projectedStartGeometry);
            }
            
            let controlledJunctionsPassed = [];
            for (let i = 0; i < rResult.route.length - 1; i++) {
                const e = (this.adj[rResult.route[i]] || []).find(edge => edge.to === rResult.route[i+1]);
                if (e && e.geometry) {
                    geom.push(...e.geometry);
                }
                
                const cj = this.graph.controlledJunctions.find(j => j.osmNodeId === rResult.route[i+1] || j.id === rResult.route[i+1]);
                if (cj) controlledJunctionsPassed.push({ id: cj.id, name: cj.name });
            }
            if (projectedEndGeometry) {
                geom.push(...projectedEndGeometry);
            }
            rResult.geometry = geom;
            rResult.controlledJunctionsPassed = controlledJunctionsPassed;
            return rResult;
        };

        return { 
            individual: enhanceRoute(individual), 
            aura: enhanceRoute(aura), 
            timestamp: new Date().toISOString() 
        };
    }
}

module.exports = { RoutingEngine };
