// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');

/* Build a state from an ASCII layout. Letters: B C G L M S, '.' empty.
   Lowercase means the module is spent. */
function layout(rows) {
    const map = { b: 'brain', c: 'coil', g: 'gripper', l: 'laser', m: 'motor', s: 'sensor' };
    const s = R.newGame(() => 0);
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
        const id = map[ch.toLowerCase()];
        if (!id) return;
        s.pos[id] = { x, y };
        s.spent[id] = ch === ch.toLowerCase();
    }));
    assert.ok(R.isValidLayout(s.pos), 'test layout must be valid');
    return s;
}

const cells = list => list.map(c => `${c.x},${c.y}`).sort();
const has = (list, x, y) => list.some(c => c.x === x && c.y === y);

test('new game deals a 2x3 block, all active', () => {
    const s = R.newGame();
    assert.ok(R.isValidLayout(s.pos));
    const b = R.bbox(s.pos);
    assert.deepEqual([b.maxX - b.minX, b.maxY - b.minY], [2, 1]);
    assert.ok(R.IDS.every(id => !s.spent[id]));
});

test('layout validity: diagonal touch connects, gaps and stacking do not', () => {
    const s = layout(['BC.', '.GL', '..MS']);
    assert.ok(R.isValidLayout(s.pos));
    const broken = JSON.parse(JSON.stringify(s.pos));
    broken.sensor = { x: 5, y: 5 };
    assert.equal(R.isValidLayout(broken), false);
    const stacked = JSON.parse(JSON.stringify(s.pos));
    stacked.sensor = { ...stacked.motor };
    assert.equal(R.isValidLayout(stacked), false);
});

test('Brain slides orthogonally, can pass over modules, stays connected', () => {
    const s = layout(['BCG', 'LMS']);
    // Brain at (0,0). Right: passes over C,G to (3,0) — touches G. (4,0) disconnected.
    // Up: (0,-1) touches C diagonally. (0,-2) disconnected. Left: (-1,0) touches L diagonally.
    // Down: passes over L to (0,2) — touches M diagonally.
    // Moving Brain away must also keep the rest connected (it does here).
    assert.deepEqual(cells(R.legalMoves(s, 'brain')), ['-1,0', '0,-1', '0,2', '3,0']);
});

test('Sensor slides only diagonally', () => {
    const s = layout(['BCG', 'LMS']);
    const moves = R.legalMoves(s, 'sensor');
    assert.ok(moves.every(m => Math.abs(m.dir[0]) === 1 && Math.abs(m.dir[1]) === 1));
    // Up-left passes over C to (0,-1); up-right (3,0); down-left (1,2).
    // Down-right (3,2) would only touch Sensor's own vacated cell: disconnected.
    assert.deepEqual(cells(moves), ['0,-1', '1,2', '3,0']);
});

test('Laser slides in all 8 directions', () => {
    const s = layout(['BCG', 'LMS']);
    const dirs = new Set(R.legalMoves(s, 'laser').map(m => m.dir.join(',')));
    assert.ok(dirs.has('-1,0') && dirs.has('0,1') && dirs.has('1,1') && dirs.has('-1,-1'));
});

test('Coil jump must pass over at least one module', () => {
    const s = layout(['BCG', 'LMS']);
    const moves = R.legalMoves(s, 'coil');
    // Coil at (1,0). Straight up (1,-1) passes nothing: illegal. Down passes M to (1,2): legal.
    assert.equal(has(moves, 1, -1), false);
    assert.ok(has(moves, 1, 2));
    // Left passes over B to (-1,0): legal. Right passes over G to (3,0): legal.
    assert.ok(has(moves, -1, 0) && has(moves, 3, 0));
    assert.ok(moves.every(m => m.dist >= 2));
});

test('Gripper steps exactly one space, any direction', () => {
    const s = layout(['BCG', 'LMS']);
    assert.deepEqual(cells(R.legalMoves(s, 'gripper')), ['1,-1', '2,-1', '3,0', '3,1']);
});

test('Motor pushes a chain of modules one space', () => {
    const s = layout(['BCG', 'LMS']);
    const left = R.legalMoves(s, 'motor').find(m => m.dir[0] === -1);
    // Motor (1,1) moves left into L, which goes to (-1,1)
    assert.deepEqual(left.pushed, ['laser']);
    assert.deepEqual(left.pos.laser, { x: -1, y: 1 });
    assert.deepEqual(left.pos.motor, { x: 0, y: 1 });

    const s2 = layout(['MBCG', '.LS.']);
    const right = R.legalMoves(s2, 'motor').find(m => m.dir[0] === 1);
    assert.deepEqual(right.pushed, ['brain', 'coil', 'gripper']);
    assert.deepEqual(right.pos.gripper, { x: 4, y: 0 });
});

test('Motor push that would disconnect the group is not offered', () => {
    // Motor at the end of a line; pushing up leaves it isolated? M below S only.
    const s = layout(['BCGL', '...S', '...M']);
    // Motor moving down (3,3) only touches nothing -> illegal. Up pushes S into L? chain S,L -> L to (3,-1)
    const moves = R.legalMoves(s, 'motor');
    assert.equal(moves.some(m => m.dir[1] === 1), false);
    const up = moves.find(m => m.dir[1] === -1);
    assert.deepEqual(up.pushed, ['sensor', 'laser']);
});

test('moving counts moves, illegal moves throw', () => {
    let s = layout(['BCG', 'LMS']);
    s = R.applyMove(s, 'gripper', { x: 3, y: 0 });
    assert.equal(s.movesMission, 1);
    assert.equal(s.movesTotal, 1);
    assert.throws(() => R.applyMove(s, 'sensor', { x: 2, y: 2 }));
});

test('mission complete resets mission moves and wins at 7', () => {
    let s = layout(['BCG', 'LMS']);
    s = R.applyMove(s, 'gripper', { x: 3, y: 0 });
    s = R.completeMission(s);
    assert.equal(s.missions, 1);
    assert.equal(s.movesMission, 0);
    assert.equal(s.movesTotal, 1);
    for (let i = 0; i < 6; i++) s = R.completeMission(s);
    assert.equal(s.status, 'won');
    assert.throws(() => R.applyMove(s, 'brain', { x: -1, y: 0 }));
});

test('Laser ability swaps two modules and flips Laser', () => {
    const s = layout(['BCG', 'LMS']);
    const n = R.applyAbility(s, 'laser', { a: 'brain', b: 'sensor' });
    assert.deepEqual(n.pos.brain, { x: 2, y: 1 });
    assert.deepEqual(n.pos.sensor, { x: 0, y: 0 });
    assert.equal(n.spent.laser, true);
    assert.equal(n.movesMission, 0, 'abilities are free');
    assert.throws(() => R.applyAbility(n, 'laser', { a: 'brain', b: 'coil' }), 'already spent');
});

test('Brain ability pulls a module next to Brain', () => {
    const s = layout(['BCG', 'LMS']);
    const step = R.abilityStep(s, 'brain', { a: 'sensor' });
    assert.equal(step.kind, 'cell');
    assert.ok(step.options.every(c => Math.max(Math.abs(c.x), Math.abs(c.y)) === 1));
    assert.ok(has(step.options, -1, -1));
    const n = R.applyAbility(s, 'brain', { a: 'sensor', cell: { x: -1, y: -1 } });
    assert.deepEqual(n.pos.sensor, { x: -1, y: -1 });
    assert.equal(R.abilityStep(s, 'brain', { a: 'brain' }).kind, 'invalid');
});

test('Coil ability repositions Coil anywhere valid', () => {
    const s = layout(['BCG', 'LMS']);
    const step = R.abilityStep(s, 'coil', {});
    assert.equal(step.kind, 'cell');
    assert.ok(has(step.options, 3, 1));
    assert.equal(has(step.options, 5, 5), false);
    const n = R.applyAbility(s, 'coil', { cell: { x: 3, y: 1 } });
    assert.deepEqual(n.pos.coil, { x: 3, y: 1 });
});

test('Motor ability shifts any module 1 space in 8 directions, no push', () => {
    const s = layout(['BCG', 'LMS']);
    const step = R.abilityStep(s, 'motor', { a: 'sensor' });
    assert.deepEqual(cells(step.options), ['1,2', '2,2', '3,0', '3,1']);
});

test('Gripper activates an adjacent spent module; only Gripper flips', () => {
    const s = layout(['BcG', 'LMS']); // coil spent, adjacent to gripper
    assert.ok(R.gripperTargets(s.pos).includes('coil'));
    assert.equal(R.gripperTargets(s.pos).includes('brain'), false, 'brain not adjacent');
    const n = R.applyAbility(s, 'gripper', { target: 'coil', cell: { x: 3, y: 1 } });
    assert.deepEqual(n.pos.coil, { x: 3, y: 1 });
    assert.equal(n.spent.gripper, true);
    assert.equal(n.spent.coil, true);
    assert.equal(n.spent.motor, false);
});

test('Gripper activating Brain places the chosen module next to Brain', () => {
    const s = layout(['GB.', 'LMS', 'C..']);
    const n = R.applyAbility(s, 'gripper', { target: 'brain', a: 'coil', cell: { x: 2, y: 0 } });
    assert.deepEqual(n.pos.coil, { x: 2, y: 0 });
    assert.equal(n.spent.brain, false);
});

test('Sensor ability resolves immediately', () => {
    const s = layout(['BCG', 'LMS']);
    assert.equal(R.abilityStep(s, 'sensor', {}).kind, 'done');
    const n = R.applyAbility(s, 'sensor', {});
    assert.equal(n.spent.sensor, true);
    assert.deepEqual(n.pos, s.pos);
});

test('saved state validation', () => {
    const s = layout(['BCG', 'LMS']);
    assert.ok(R.isState(JSON.parse(JSON.stringify(s))));
    assert.equal(R.isState({}), false);
    assert.equal(R.isState(null), false);
});
