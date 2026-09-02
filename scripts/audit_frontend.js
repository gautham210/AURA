const fs = require('fs');
const appJs = fs.readFileSync('frontend/app.js', 'utf8');
const html = fs.readFileSync('frontend/dashboard.html', 'utf8');

// Find all document.getElementById in appJs
const idRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
let match;
const usedIds = new Set();
while ((match = idRegex.exec(appJs)) !== null) {
    usedIds.add(match[1]);
}

console.log('Total getElementById in app.js:', usedIds.size);
for (const id of usedIds) {
    if (!html.includes(`id="${id}"`) && !html.includes(`id='${id}'`)) {
        // Some IDs might be dynamically created like sig-NORTHBOUND, marker-J1, etc.
        console.log('MISSING IN STATIC HTML (could be dynamic): id =', id);
    }
}

// Find all top level variable usages that look like element IDs without const/let/var
const lines = appJs.split('\n');
lines.forEach((line, idx) => {
    const m = line.match(/^(\s*)([a-zA-Z0-9_$]+)\.(addEventListener|disabled|classList|textContent|innerHTML|style|value)/);
    if (m) {
        const varName = m[2];
        const isDecl = new RegExp(`(const|let|var|function|class)\\s+${varName}\\b`).test(appJs.slice(0, appJs.indexOf(line)));
        if (!isDecl && !['window', 'document', 'map', 'ws', 'store', 'ctx', 'canvas'].includes(varName)) {
            console.log(`UNDECLARED VARIABLE USED AT LINE ${idx + 1}: ${varName} -> ${line.trim()}`);
        }
    }
});
