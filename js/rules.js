/* ROVE rules engine.
 *
 * Pure functions over plain state objects: nothing here touches the DOM, so the
 * same file runs in the browser (as window.Rove) and in Node tests (module.exports).
 *
 * Grid: integer cells {x, y}, x grows to the right, y grows downwards.
 * Every function that changes something returns a NEW state; inputs are never mutated.
 */
(function (root) {
    'use strict';

    var IDS = ['brain', 'coil', 'gripper', 'laser', 'motor', 'sensor'];
    var MISSIONS_TO_WIN = 7;
    var LOG_LIMIT = 60;

    var ORTHO = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var DIAG = [[1, -1], [1, 1], [-1, 1], [-1, -1]];
    var ALL8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

    /* How each module moves when you spend a movement point on it (the arrows on the card).
       slide: any distance in a straight line, may pass over modules
       jump:  any distance in a straight line, must pass over at least one module
       step:  exactly one space
       push:  exactly one space, pushing every module in the way one space further */
    var MODULES = {
        brain:   { name: 'Brain',   key: 'B', move: 'slide', dirs: ORTHO,
                   ability: 'Choose any other module and reposition it to be adjacent to Brain.' },
        coil:    { name: 'Coil',    key: 'C', move: 'jump',  dirs: ALL8,
                   ability: 'Reposition Coil to any valid location.' },
        gripper: { name: 'Gripper', key: 'G', move: 'step',  dirs: ALL8,
                   ability: 'Activate the ability of an adjacent module, even if that module is already spent.' },
        laser:   { name: 'Laser',   key: 'L', move: 'slide', dirs: ALL8,
                   ability: 'Swap any 2 modules (can include Laser).' },
        motor:   { name: 'Motor',   key: 'M', move: 'push',  dirs: ORTHO,
                   ability: 'Shift any module (including Motor) 1 space in any direction.' },
        sensor:  { name: 'Sensor',  key: 'S', move: 'slide', dirs: DIAG,
                   ability: 'If you have fewer than 5 cards in your hand, draw 1 card from the deck.' }
    };

    var MOVE_TEXT = {
        slide: 'Any number of spaces in one direction. May pass over other modules.',
        jump: 'Any number of spaces in one direction. Must pass over at least one module.',
        step: 'Exactly 1 space.',
        push: '1 space. Modules in the way are pushed 1 space in the same direction.'
    };

    var DIR_TEXT = { 4: 'straight directions', 8: 'all 8 directions' };

    function dirsText(id) {
        var m = MODULES[id];
        if (m.dirs === DIAG) return 'diagonal directions';
        return DIR_TEXT[m.dirs.length];
    }

    /* ---------- small helpers ---------- */

    function key(x, y) { return x + ',' + y; }

    function clonePos(pos) {
        var out = {};
        IDS.forEach(function (id) { out[id] = { x: pos[id].x, y: pos[id].y }; });
        return out;
    }

    function occupancy(pos) {
        var occ = {};
        IDS.forEach(function (id) { occ[key(pos[id].x, pos[id].y)] = id; });
        return occ;
    }

    function isAdjacent(a, b) {
        var dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        return Math.max(dx, dy) === 1;
    }

    function bbox(pos) {
        var b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        IDS.forEach(function (id) {
            var p = pos[id];
            if (p.x < b.minX) b.minX = p.x;
            if (p.y < b.minY) b.minY = p.y;
            if (p.x > b.maxX) b.maxX = p.x;
            if (p.y > b.maxY) b.maxY = p.y;
        });
        return b;
    }

    /* Valid layout: no two modules share a cell, and all six form one group where
       "adjacent" means touching edge-to-edge or corner-to-corner. */
    function isValidLayout(pos) {
        var occ = occupancy(pos);
        if (Object.keys(occ).length !== IDS.length) return false;
        var seen = {}, stack = [IDS[0]];
        seen[IDS[0]] = true;
        while (stack.length) {
            var id = stack.pop(), p = pos[id];
            for (var i = 0; i < ALL8.length; i++) {
                var other = occ[key(p.x + ALL8[i][0], p.y + ALL8[i][1])];
                if (other && !seen[other]) { seen[other] = true; stack.push(other); }
            }
        }
        return Object.keys(seen).length === IDS.length;
    }

    /* Empty cells touching at least one module other than `except`: the only cells
       a single repositioned module can land on and keep the group connected. */
    function frontierCells(pos, except) {
        var occ = occupancy(pos), out = [], seen = {};
        IDS.forEach(function (id) {
            if (id === except) return;
            var p = pos[id];
            ALL8.forEach(function (d) {
                var x = p.x + d[0], y = p.y + d[1], k = key(x, y);
                if (seen[k]) return;
                seen[k] = true;
                if (!occ[k]) out.push({ x: x, y: y });
            });
        });
        return out;
    }

    function withModuleAt(pos, id, cell) {
        var next = clonePos(pos);
        next[id] = { x: cell.x, y: cell.y };
        return next;
    }

    /* ---------- setup ---------- */

    function shuffle(list, rng) {
        var a = list.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(rng() * (i + 1));
            var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    function newGame(rng) {
        rng = rng || Math.random;
        var order = shuffle(IDS, rng), pos = {}, spent = {};
        order.forEach(function (id, i) { pos[id] = { x: i % 3, y: Math.floor(i / 3) }; });
        IDS.forEach(function (id) { spent[id] = false; });
        return {
            version: 1,
            pos: pos,
            spent: spent,
            missions: 0,
            movesMission: 0,
            movesTotal: 0,
            status: 'playing',
            log: [{ kind: 'info', text: 'New game. Draw your mission and starting hand.' }]
        };
    }

    function nextState(state, changes, logEntry) {
        var s = {
            version: state.version,
            pos: changes.pos || clonePos(state.pos),
            spent: Object.assign({}, state.spent, changes.spent || {}),
            missions: 'missions' in changes ? changes.missions : state.missions,
            movesMission: 'movesMission' in changes ? changes.movesMission : state.movesMission,
            movesTotal: 'movesTotal' in changes ? changes.movesTotal : state.movesTotal,
            status: changes.status || state.status,
            log: state.log.slice()
        };
        if (logEntry) {
            s.log.push(logEntry);
            if (s.log.length > LOG_LIMIT) s.log = s.log.slice(s.log.length - LOG_LIMIT);
        }
        return s;
    }

    /* ---------- movement (costs 1 movement point) ---------- */

    /* All legal destinations for module `id`. Each entry:
       { x, y, pos: layout after the move, pushed: [ids pushed], dir: [dx,dy], dist } */
    function legalMoves(state, id) {
        var pos = state.pos, mod = MODULES[id], from = pos[id], occ = occupancy(pos), out = [];
        var b = bbox(pos);
        var reach = (b.maxX - b.minX) + (b.maxY - b.minY) + 3;

        mod.dirs.forEach(function (d) {
            if (mod.move === 'step') {
                var c = { x: from.x + d[0], y: from.y + d[1] };
                if (occ[key(c.x, c.y)]) return;
                var np = withModuleAt(pos, id, c);
                if (isValidLayout(np)) out.push({ x: c.x, y: c.y, pos: np, pushed: [], dir: d, dist: 1 });
                return;
            }

            if (mod.move === 'push') {
                var cx = from.x + d[0], cy = from.y + d[1], chain = [];
                var hit = occ[key(cx, cy)];
                var tx = cx, ty = cy;
                while (hit) {
                    chain.push(hit);
                    tx += d[0]; ty += d[1];
                    hit = occ[key(tx, ty)];
                }
                var pp = clonePos(pos);
                pp[id] = { x: cx, y: cy };
                chain.forEach(function (pid) { pp[pid] = { x: pos[pid].x + d[0], y: pos[pid].y + d[1] }; });
                if (isValidLayout(pp)) out.push({ x: cx, y: cy, pos: pp, pushed: chain, dir: d, dist: 1 });
                return;
            }

            // slide / jump
            var passed = false;
            for (var k = 1; k <= reach; k++) {
                var x = from.x + d[0] * k, y = from.y + d[1] * k;
                if (occ[key(x, y)]) { passed = true; continue; }
                if (mod.move === 'jump' && !passed) continue;
                var sp = withModuleAt(pos, id, { x: x, y: y });
                if (isValidLayout(sp)) out.push({ x: x, y: y, pos: sp, pushed: [], dir: d, dist: k });
            }
        });
        return out;
    }

    function applyMove(state, id, cell) {
        if (state.status !== 'playing') throw new Error('Game is over');
        var move = legalMoves(state, id).filter(function (m) { return m.x === cell.x && m.y === cell.y; })[0];
        if (!move) throw new Error('Illegal move for ' + id);
        var text = MODULES[id].name + ' ' + arrow(move.dir) + (move.dist > 1 ? ' ' + move.dist : '');
        if (move.pushed.length) text += ', pushing ' + move.pushed.map(nameOf).join(', ');
        return nextState(state, {
            pos: move.pos,
            movesMission: state.movesMission + 1,
            movesTotal: state.movesTotal + 1
        }, { kind: 'move', text: text });
    }

    var ARROWS = { '0,-1': '↑', '1,-1': '↗', '1,0': '→', '1,1': '↘', '0,1': '↓', '-1,1': '↙', '-1,0': '←', '-1,-1': '↖' };
    function arrow(d) { return ARROWS[d[0] + ',' + d[1]]; }
    function nameOf(id) { return MODULES[id].name; }

    /* ---------- abilities (free; flip the module to its spent side) ---------- */

    function brainCells(pos, target) {
        var brain = pos.brain, occ = occupancy(pos), out = [];
        ALL8.forEach(function (d) {
            var c = { x: brain.x + d[0], y: brain.y + d[1] };
            var at = occ[key(c.x, c.y)];
            if (at) return; // occupied (target's own cell counts as occupied: staying put is no move)
            var np = withModuleAt(pos, target, c);
            if (isValidLayout(np)) out.push({ x: c.x, y: c.y, pos: np });
        });
        return out;
    }

    function coilCells(pos) {
        return frontierCells(pos, 'coil').map(function (c) {
            return { x: c.x, y: c.y, pos: withModuleAt(pos, 'coil', c) };
        }).filter(function (c) { return isValidLayout(c.pos); });
    }

    function motorCells(pos, target) {
        var from = pos[target], occ = occupancy(pos), out = [];
        ALL8.forEach(function (d) {
            var c = { x: from.x + d[0], y: from.y + d[1] };
            if (occ[key(c.x, c.y)]) return;
            var np = withModuleAt(pos, target, c);
            if (isValidLayout(np)) out.push({ x: c.x, y: c.y, pos: np });
        });
        return out;
    }

    function swapped(pos, a, b) {
        var np = clonePos(pos);
        np[a] = { x: pos[b].x, y: pos[b].y };
        np[b] = { x: pos[a].x, y: pos[a].y };
        return np;
    }

    /* Can `ability` (a module id) be resolved at all on this layout? */
    function abilityHasEffect(pos, ability) {
        switch (ability) {
            case 'brain': return IDS.some(function (id) { return id !== 'brain' && brainCells(pos, id).length > 0; });
            case 'coil': return coilCells(pos).length > 0;
            case 'motor': return IDS.some(function (id) { return motorCells(pos, id).length > 0; });
            case 'laser': return true;
            case 'sensor': return true;
            case 'gripper': return gripperTargets(pos).length > 0;
        }
        return false;
    }

    function gripperTargets(pos) {
        return IDS.filter(function (id) {
            return id !== 'gripper' && isAdjacent(pos[id], pos.gripper) && abilityHasEffect(pos, id);
        });
    }

    function canActivate(state, id) {
        return state.status === 'playing' && !state.spent[id] && abilityHasEffect(state.pos, id);
    }

    /* Step-by-step resolution of an ability flipped on module `source`.
       `picks` holds what the player chose so far: { target, a, b, cell }.
       Returns the next choice to make:
         { kind: 'module', field, options: [{ id, pos? }], prompt }
         { kind: 'cell',   field, options: [{ x, y, pos }], prompt }
         { kind: 'done',   ability, pos }                 (pos: layout after resolving)
       or { kind: 'invalid' } when a pick is not allowed. */
    function abilityStep(state, source, picks) {
        picks = picks || {};
        var pos = state.pos, ability = source;

        if (source === 'gripper') {
            var targets = gripperTargets(pos);
            if (!picks.target) {
                return { kind: 'module', field: 'target', prompt: 'Pick a module next to Gripper to activate.',
                         options: targets.map(function (id) { return { id: id }; }) };
            }
            if (targets.indexOf(picks.target) < 0) return { kind: 'invalid' };
            ability = picks.target;
        }

        function pickedOption(options, field) {
            var v = picks[field];
            return options.filter(function (o) {
                return o.id ? o.id === v : (v && o.x === v.x && o.y === v.y);
            })[0];
        }

        var opts, chosen;
        switch (ability) {
            case 'sensor':
                return { kind: 'done', ability: ability, pos: clonePos(pos) };

            case 'laser':
                opts = IDS.map(function (id) { return { id: id }; });
                if (!picks.a) return { kind: 'module', field: 'a', options: opts, prompt: 'Laser: pick the first module to swap.' };
                if (!pickedOption(opts, 'a')) return { kind: 'invalid' };
                opts = IDS.filter(function (id) { return id !== picks.a; })
                          .map(function (id) { return { id: id, pos: swapped(pos, picks.a, id) }; });
                if (!picks.b) return { kind: 'module', field: 'b', options: opts, prompt: 'Laser: pick the module to swap with ' + nameOf(picks.a) + '.' };
                chosen = pickedOption(opts, 'b');
                return chosen ? { kind: 'done', ability: ability, pos: chosen.pos } : { kind: 'invalid' };

            case 'brain':
                opts = IDS.filter(function (id) { return id !== 'brain' && brainCells(pos, id).length > 0; })
                          .map(function (id) { return { id: id }; });
                if (!picks.a) return { kind: 'module', field: 'a', options: opts, prompt: 'Brain: pick a module to move next to Brain.' };
                if (!pickedOption(opts, 'a')) return { kind: 'invalid' };
                opts = brainCells(pos, picks.a);
                if (!picks.cell) return { kind: 'cell', field: 'cell', options: opts, prompt: 'Brain: pick where ' + nameOf(picks.a) + ' goes next to Brain.' };
                chosen = pickedOption(opts, 'cell');
                return chosen ? { kind: 'done', ability: ability, pos: chosen.pos } : { kind: 'invalid' };

            case 'coil':
                opts = coilCells(pos);
                if (!picks.cell) return { kind: 'cell', field: 'cell', options: opts, prompt: 'Coil: pick where Coil goes.' };
                chosen = pickedOption(opts, 'cell');
                return chosen ? { kind: 'done', ability: ability, pos: chosen.pos } : { kind: 'invalid' };

            case 'motor':
                opts = IDS.filter(function (id) { return motorCells(pos, id).length > 0; })
                          .map(function (id) { return { id: id }; });
                if (!picks.a) return { kind: 'module', field: 'a', options: opts, prompt: 'Motor: pick a module to shift 1 space.' };
                if (!pickedOption(opts, 'a')) return { kind: 'invalid' };
                opts = motorCells(pos, picks.a);
                if (!picks.cell) return { kind: 'cell', field: 'cell', options: opts, prompt: 'Motor: pick where ' + nameOf(picks.a) + ' shifts to.' };
                chosen = pickedOption(opts, 'cell');
                return chosen ? { kind: 'done', ability: ability, pos: chosen.pos } : { kind: 'invalid' };
        }
        return { kind: 'invalid' };
    }

    function abilityText(ability, picks) {
        switch (ability) {
            case 'sensor': return 'draw 1 card if your hand has fewer than 5';
            case 'laser': return 'swapped ' + nameOf(picks.a) + ' and ' + nameOf(picks.b);
            case 'brain': return 'pulled ' + nameOf(picks.a) + ' next to Brain';
            case 'coil': return 'repositioned Coil';
            case 'motor': return 'shifted ' + nameOf(picks.a);
        }
        return '';
    }

    function applyAbility(state, source, picks) {
        if (!canActivate(state, source)) throw new Error('Cannot activate ' + source);
        var step = abilityStep(state, source, picks);
        if (step.kind !== 'done') throw new Error('Ability not fully resolved');
        var spent = {}; spent[source] = true;
        var label = nameOf(source) + (source === 'gripper' ? ' → ' + nameOf(step.ability) : '');
        return nextState(state, { pos: step.pos, spent: spent },
            { kind: 'ability', text: label + ': ' + abilityText(step.ability, picks) });
    }

    /* ---------- missions ---------- */

    function completeMission(state) {
        if (state.status !== 'playing') throw new Error('Game is over');
        var n = state.missions + 1;
        var won = n >= MISSIONS_TO_WIN;
        return nextState(state, { missions: n, movesMission: 0, status: won ? 'won' : 'playing' },
            { kind: 'mission', text: 'Mission ' + n + ' complete' + (won ? '. You win!' : ' in ' + state.movesMission + ' move' + (state.movesMission === 1 ? '' : 's')) });
    }

    function giveUp(state) {
        if (state.status !== 'playing') throw new Error('Game is over');
        return nextState(state, { status: 'lost' },
            { kind: 'mission', text: 'Could not complete mission ' + (state.missions + 1) + '. Game lost.' });
    }

    /* Accept only well-formed saved states. */
    function isState(s) {
        if (!s || typeof s !== 'object' || s.version !== 1 || !s.pos || !s.spent || !Array.isArray(s.log)) return false;
        for (var i = 0; i < IDS.length; i++) {
            var p = s.pos[IDS[i]];
            if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y)) return false;
        }
        return isValidLayout(s.pos) && ['playing', 'won', 'lost'].indexOf(s.status) >= 0;
    }

    var api = {
        IDS: IDS,
        MODULES: MODULES,
        MOVE_TEXT: MOVE_TEXT,
        MISSIONS_TO_WIN: MISSIONS_TO_WIN,
        dirsText: dirsText,
        newGame: newGame,
        isValidLayout: isValidLayout,
        bbox: bbox,
        legalMoves: legalMoves,
        applyMove: applyMove,
        canActivate: canActivate,
        abilityStep: abilityStep,
        applyAbility: applyAbility,
        gripperTargets: gripperTargets,
        completeMission: completeMission,
        giveUp: giveUp,
        isState: isState
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.Rove = api;
})(this);
