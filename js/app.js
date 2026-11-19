/* ROVE Tabletop — UI. All rule decisions come from js/rules.js (window.Rove). */
(function () {
    'use strict';

    var R = window.Rove;
    var STORE_KEY = 'rove.game';
    var HUD_KEY = 'rove.hud';
    var HISTORY_LIMIT = 400;
    var CARD_ASPECT = 720 / 497;   // width / height of the module card art
    var GAP_RATIO = 0.035;         // gap between cards, relative to card width
    var RING = 0.6;                // how much of the empty ring around the modules stays on screen (in cards)
    var EDGE = 12;                 // px kept free at the screen edge
    var MAX_CARD_W = 520;
    var DRAG_THRESHOLD = 5;
    var MOVE_GLYPH = { slide: '→', jump: '⇔', step: '●', push: '⊣' };
    var MOVE_NAME = { slide: 'Slide', jump: 'Jump', step: 'Step', push: 'Push' };
    var ARROWS = { '0,-1': '↑', '1,-1': '↗', '1,0': '→', '1,1': '↘', '0,1': '↓', '-1,1': '↙', '-1,0': '←', '-1,-1': '↖' };

    var $ = function (id) { return document.getElementById(id); };
    var board = $('board'), promptEl = $('prompt'), hud = $('hud');

    var history = [], index = -1;
    var ui = { selected: null, flow: null };      // flow: { source, picks }
    var modEls = {}, slots = [], ghostEls = [];
    var view = null;
    var cam = { zoom: 1, panX: 0, panY: 0 };      // wheel zoom and background-drag pan
    var MIN_ZOOM = 0.35, MAX_ZOOM = 3;
    var SHUFFLES = 10, SHUFFLE_STEP = 200;
    var drag = null;                               // active pointer drag
    var suppressClick = false;

    function state() { return history[index]; }

    /* ---------- persistence & history ---------- */

    function load() {
        try {
            var saved = JSON.parse(localStorage.getItem(STORE_KEY));
            if (saved && Array.isArray(saved.history) && saved.history.length && saved.history.every(R.isState) &&
                Number.isInteger(saved.index) && saved.index >= 0 && saved.index < saved.history.length) {
                history = saved.history;
                index = saved.index;
                return false;
            }
        } catch (e) { /* start fresh */ }
        history = [R.newGame()];
        index = 0;
        return true;
    }

    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ history: history, index: index })); } catch (e) {}
    }

    function commit(next) {
        history = history.slice(0, index + 1);
        history.push(next);
        if (history.length > HISTORY_LIMIT) history = history.slice(history.length - HISTORY_LIMIT);
        index = history.length - 1;
        save();
    }

    function undo() {
        if (index <= 0) return;
        index--;
        ui.flow = null;
        save();
        render();
    }

    function redo() {
        if (index >= history.length - 1) return;
        index++;
        ui.flow = null;
        save();
        render();
    }

    /* ---------- actions ---------- */

    function select(id) {
        if (state().status !== 'playing' || ui.flow) return;
        ui.selected = ui.selected === id ? null : id;
        render();
    }

    function moveTo(id, cell) {
        commit(R.applyMove(state(), id, cell));
        ui.selected = null;
        render();
    }

    function startAbility(id) {
        var s = state();
        if (ui.flow || s.status !== 'playing') return;
        if (!R.canActivate(s, id)) {
            toast(s.spent[id] ? R.MODULES[id].name + ' is already spent.' : R.MODULES[id].name + "'s ability has no legal use right now.");
            return;
        }
        ui.selected = null;
        ui.flow = { source: id, picks: {} };
        advanceFlow();
    }

    function advanceFlow() {
        var f = ui.flow;
        var step = R.abilityStep(state(), f.source, f.picks);
        if (step.kind === 'done') {
            commit(R.applyAbility(state(), f.source, f.picks));
            ui.flow = null;
            if (step.ability === 'sensor') toast('Sensor: draw 1 card if you hold fewer than 5.');
        }
        render();
    }

    function pick(field, value) {
        ui.flow.picks[field] = value;
        advanceFlow();
    }

    function cancelFlow() {
        ui.flow = null;
        render();
    }

    function missionComplete() {
        if (state().status !== 'playing') return;
        ui.flow = null;
        ui.selected = null;
        commit(R.completeMission(state()));
        render();
        var s = state();
        if (s.status === 'won') {
            showDialog('Mission accomplished', '<p>You completed all 7 missions in <b>' + s.movesTotal + '</b> ' + plural(s.movesTotal, 'move') + '. The ROVE gets home.</p>',
                [{ label: 'Undo last mission', action: undo }, { label: 'New game', cls: 'kt-btn--primary', action: newGame }]);
        } else {
            toast('Mission ' + s.missions + ' complete. Place the next mission and draw 1 card if you hold fewer than 5.');
        }
    }

    function giveUp() {
        if (state().status !== 'playing') return;
        showDialog("Can't complete the mission?", '<p>This ends the game as a loss. You can still undo it afterwards.</p>', [
            { label: 'Keep playing' },
            { label: 'End game', cls: 'kt-btn--danger', action: function () {
                ui.flow = null; ui.selected = null;
                commit(R.giveUp(state()));
                render();
                showDialog('Game over', '<p>Stranded after ' + state().missions + ' of 7 missions.</p>',
                    [{ label: 'Undo', action: undo }, { label: 'New game', cls: 'kt-btn--primary', action: newGame }]);
            } }
        ]);
    }

    function confirmNewGame() {
        var s = state();
        if (s.status === 'playing' && (s.movesTotal > 0 || s.missions > 0 || R.IDS.some(function (id) { return s.spent[id]; }))) {
            showDialog('Start a new game?', '<p>The modules are reshuffled and your progress and history are cleared.</p>', [
                { label: 'Cancel' },
                { label: 'New game', cls: 'kt-btn--primary', action: newGame }
            ]);
        } else {
            newGame();
        }
    }

    function newGame() {
        history = [R.newGame()];
        index = 0;
        ui.flow = null;
        ui.selected = null;
        cam.zoom = 1; cam.panX = 0; cam.panY = 0;
        save();
        shuffleIn();
    }

    /* Deal animation: the cards fly through a few random 2x3 layouts before settling. */
    var shuffling = false;
    function shuffleIn() {
        shuffling = true;
        board.classList.add('is-shuffling');
        render();                                   // camera fits the final 2x3 block, cards flip face up
        var final = state().pos, cells = R.IDS.map(function (id) { return final[id]; });
        var count = 0;
        var timer = setInterval(function () {
            var order = cells.slice();
            for (var i = order.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
            }
            R.IDS.forEach(function (id, i) { place(modEls[id], order[i]); });
            if (++count >= SHUFFLES) {
                clearInterval(timer);
                setTimeout(function () {
                    shuffling = false;
                    board.classList.remove('is-shuffling');
                    render();                       // settle into the dealt layout
                }, SHUFFLE_STEP);
            }
        }, SHUFFLE_STEP);
    }

    /* ---------- camera: fit the modules as large as the screen allows ---------- */

    function computeView() {
        var b = R.bbox(state().pos);
        var cols = b.maxX - b.minX + 1 + 2 * RING;
        var rows = b.maxY - b.minY + 1 + 2 * RING;
        var W = window.innerWidth, H = window.innerHeight;
        var w = Math.min(
            (W - 2 * EDGE) / (cols * (1 + GAP_RATIO)),
            (H - 2 * EDGE) / (rows * (1 / CARD_ASPECT + GAP_RATIO)),
            MAX_CARD_W
        );
        w = Math.max(60, Math.floor(w));
        var h = Math.round(w / CARD_ASPECT), gap = Math.max(4, Math.round(w * GAP_RATIO));
        board.style.setProperty('--cw', w + 'px');
        board.style.setProperty('--ch', h + 'px');
        board.style.setProperty('--cr', Math.round(w * 0.035) + 'px');
        view = {
            cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2,
            W: W, H: H, w: w, h: h, pitchX: w + gap, pitchY: h + gap,
            ox: W / 2, oy: H / 2
        };
        applyCamera();
    }

    /* Zoom and pan move the whole table as one piece (scale around the screen centre). */
    function applyCamera() {
        board.style.transform = 'translate(' + cam.panX + 'px,' + cam.panY + 'px) scale(' + cam.zoom + ')';
    }

    function setCameraMode(mode) {   // 'smooth' (reset), 'follow' (wheel), 'none' (panning)
        board.classList.toggle('cam-follow', mode === 'follow');
        board.classList.toggle('cam-none', mode === 'none');
    }

    function cellToPx(cell) {
        return {
            x: view.ox + (cell.x - view.cx) * view.pitchX - view.w / 2,
            y: view.oy + (cell.y - view.cy) * view.pitchY - view.h / 2
        };
    }

    function pxToCell(px, py) {
        return {
            x: Math.round(view.cx + (px - view.ox) / view.pitchX),
            y: Math.round(view.cy + (py - view.oy) / view.pitchY)
        };
    }

    function place(el, cell, dx, dy) {
        var p = cellToPx(cell);
        el.style.setProperty('--t', 'translate(' + (p.x + (dx || 0)) + 'px,' + (p.y + (dy || 0)) + 'px)');
    }

    function src(id, spent) { return 'img/' + id + '-' + (spent ? 'back' : 'front') + '.jpg'; }

    /* ---------- rendering ---------- */

    function buildModules() {
        R.IDS.forEach(function (id) {
            var m = R.MODULES[id];
            var el = document.createElement('div');
            el.className = 'mod';
            el.dataset.id = id;
            el.innerHTML =
                '<div class="mod__flipper"><img alt="' + m.name + '" draggable="false"></div>' +
                '<kbd class="mod__key">' + m.key + '</kbd>' +
                '<button type="button" class="mod__ability" aria-label="Use ' + m.name + ' ability" title="Use ' + m.name + "'s ability\"></button>";
            board.appendChild(el);
            modEls[id] = el;
        });
    }

    function currentStep() {
        return ui.flow ? R.abilityStep(state(), ui.flow.source, ui.flow.picks) : null;
    }

    /* The module that moves in the current cell-picking ability step (so it can be dragged). */
    function flowMover(step) {
        if (!step || step.kind !== 'cell') return null;
        var ability = ui.flow.picks.target || ui.flow.source;
        return ability === 'coil' ? 'coil' : ui.flow.picks.a;
    }

    function render() {
        var s = state();
        computeView();
        clearPreview();

        var step = currentStep();
        var optionIds = step && step.kind === 'module' ? step.options.map(function (o) { return o.id; }) : null;

        R.IDS.forEach(function (id) {
            var el = modEls[id];
            if (!(drag && drag.active && drag.id === id) && !shuffling) place(el, s.pos[id]);
            setFace(el, id, s.spent[id]);
            var chosen = ui.flow && (ui.flow.picks.a === id || ui.flow.picks.target === id || ui.flow.source === id);
            el.classList.toggle('is-selected', ui.selected === id || !!chosen);
            el.classList.toggle('is-option', !!optionIds && optionIds.indexOf(id) >= 0);
            el.classList.toggle('is-dim', !!step && step.kind !== 'cell' && (!optionIds || optionIds.indexOf(id) < 0) && !chosen);
            el.querySelector('.mod__ability').hidden = s.spent[id] || !!ui.flow || s.status !== 'playing';
        });
        board.classList.toggle('is-over', s.status !== 'playing');

        // Destination slots
        slots.forEach(function (sl) { sl.el.remove(); });
        slots = [];
        var occupied = {};
        R.IDS.forEach(function (id) { occupied[s.pos[id].x + ',' + s.pos[id].y] = true; });

        if (step && step.kind === 'cell') {
            var mover = flowMover(step);
            step.options.forEach(function (o) {
                addSlot(o, '', o.pos, mover, occupied, function () { pick(step.field, { x: o.x, y: o.y }); });
            });
        } else if (!ui.flow && ui.selected && s.status === 'playing') {
            var sel = ui.selected;
            R.legalMoves(s, sel).forEach(function (mv) {
                var label = ARROWS[mv.dir[0] + ',' + mv.dir[1]] + (mv.dist > 1 ? ' ' + mv.dist : '');
                addSlot(mv, label, mv.pos, sel, occupied, function () { moveTo(sel, { x: mv.x, y: mv.y }); });
            });
        }

        renderPrompt(step);
        renderHud(step);
    }

    function setFace(el, id, spent) {
        var img = el.querySelector('img');
        var want = src(id, spent);
        if (!img.getAttribute('src')) { img.setAttribute('src', want); return; }
        if (img.getAttribute('src') === want) return;
        el.classList.add('is-flipping');
        setTimeout(function () {
            img.setAttribute('src', want);
            el.classList.remove('is-flipping');
        }, 220);
    }

    function addSlot(cell, label, previewPos, mover, occupied, onClick) {
        var el = document.createElement('div');
        el.className = 'slot' + (occupied[cell.x + ',' + cell.y] ? ' is-over' : '');
        el.setAttribute('role', 'button');
        if (label) el.innerHTML = '<span class="slot__label">' + label + '</span>';
        place(el, cell);
        var slot = { el: el, x: cell.x, y: cell.y, pos: previewPos, mover: mover, go: onClick };
        el.addEventListener('click', function (e) { e.stopPropagation(); if (!suppressClick) onClick(); });
        el.addEventListener('mouseenter', function () { if (!drag) showPreview(previewPos); });
        el.addEventListener('mouseleave', function () { if (!drag) clearPreview(); });
        board.appendChild(el);
        slots.push(slot);
    }

    /* Faded copies of every module whose cell would change (except one being dragged). */
    function showPreview(pos, skip) {
        clearPreview();
        if (!pos) return;
        var s = state();
        R.IDS.forEach(function (id) {
            if (id === skip) return;
            if (pos[id].x === s.pos[id].x && pos[id].y === s.pos[id].y) return;
            var g = document.createElement('div');
            g.className = 'ghost';
            g.innerHTML = '<img alt="" src="' + src(id, s.spent[id]) + '">';
            place(g, pos[id]);
            board.appendChild(g);
            ghostEls.push(g);
            modEls[id].classList.add('is-leaving');
        });
    }

    function clearPreview() {
        ghostEls.forEach(function (g) { g.remove(); });
        ghostEls = [];
        R.IDS.forEach(function (id) { if (modEls[id]) modEls[id].classList.remove('is-leaving'); });
    }

    function renderPrompt(step) {
        var s = state(), html = '', quiet = false;
        if (step) {
            html = '<span>' + esc(step.prompt) + '</span><button class="hud-btn" data-action="cancel">Cancel <kbd>Esc</kbd></button>';
        } else if (ui.selected && s.status === 'playing' && R.legalMoves(s, ui.selected).length === 0) {
            html = '<span>' + R.MODULES[ui.selected].name + ' has no legal moves right now.</span>';
            quiet = true;
        } else if (!ui.selected && s.status === 'playing' && history.length === 1) {
            html = '<span>Drag a module onto a glowing space, or click ★ on a card to use its ability.</span>';
            quiet = true;
        }
        promptEl.innerHTML = html;
        promptEl.classList.toggle('is-quiet', quiet);
    }

    var lastCounts = {};
    function setCounter(id, value) {
        var el = $(id);
        if (lastCounts[id] !== undefined && lastCounts[id] !== value) {
            el.classList.remove('is-bump');
            void el.offsetWidth;
            el.classList.add('is-bump');
        }
        lastCounts[id] = value;
        el.textContent = value;
    }

    function renderHud(step) {
        var s = state();
        var playing = s.status === 'playing';

        $('missionCount').textContent = s.status === 'won' ? 'All 7 missions complete'
            : playing ? 'Mission ' + (s.missions + 1) + ' / ' + R.MISSIONS_TO_WIN : 'Stranded · ' + s.missions + ' / 7';
        var pips = '';
        for (var i = 0; i < R.MISSIONS_TO_WIN; i++) {
            pips += '<span class="pip' + (i < s.missions ? ' is-done' : '') + (i === s.missions && playing ? ' is-current' : '') + '"></span>';
        }
        $('pips').innerHTML = pips;
        setCounter('movesMission', s.movesMission);
        setCounter('movesTotal', s.movesTotal);

        $('missionBtn').disabled = !playing;
        $('missionBtn').textContent = playing ? 'Mission ' + (s.missions + 1) + ' complete' : (s.status === 'won' ? 'You win' : 'Game over');
        $('giveUpBtn').disabled = !playing;
        $('undoBtn').disabled = index <= 0;
        $('redoBtn').disabled = index >= history.length - 1;

        $('context').innerHTML = contextHtml(s, step);

        $('log').innerHTML = s.log.slice().reverse().map(function (e) {
            return '<li class="is-' + e.kind + '">' + esc(e.text) + '</li>';
        }).join('');
    }

    function contextHtml(s, step) {
        if (s.status !== 'playing') {
            return title(s.status === 'won' ? 'You win!' : 'Game over') +
                '<p>' + (s.status === 'won' ? 'All 7 missions complete in ' + s.movesTotal + ' ' + plural(s.movesTotal, 'move') + '.' : 'Stranded after ' + s.missions + ' of 7 missions.') + '</p>' +
                '<div><button class="hud-btn hud-btn--primary" data-action="new">New game</button></div>';
        }
        if (ui.flow) {
            var abilityId = ui.flow.picks.target || ui.flow.source;
            return title(R.MODULES[ui.flow.source].name + (ui.flow.picks.target ? ' → ' + R.MODULES[ui.flow.picks.target].name : ''), '<span class="tag">★ Ability</span>') +
                '<p>' + esc(R.MODULES[abilityId].ability) + '</p>';
        }
        if (!ui.selected) return '';
        var id = ui.selected, m = R.MODULES[id];
        var can = R.canActivate(s, id);
        var n = R.legalMoves(s, id).length;
        return title(m.name, s.spent[id] ? '<span class="tag tag--spent">✕ Spent</span>' : '<span class="tag">★ Active</span>') +
            '<p><span class="glyph">' + MOVE_GLYPH[m.move] + '</span> ' + MOVE_NAME[m.move] + ', ' + R.dirsText(id) + '. ' +
                '<span class="muted">' + esc(R.MOVE_TEXT[m.move]) + ' ' + n + ' legal ' + plural(n, 'move') + '.</span></p>' +
            '<p class="muted">' + esc(m.ability) + '</p>' +
            (can ? '<div><button class="hud-btn" data-action="ability" data-id="' + id + '">★ Use ability <kbd>A</kbd></button></div>' : '');
    }

    function title(text, extra) {
        return '<div class="context__title"><span>' + esc(text) + '</span>' + (extra || '') + '</div>';
    }

    function plural(n, word) { return n === 1 ? word : word + 's'; }

    function esc(t) {
        return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }

    /* ---------- dragging ---------- */

    function canDrag(id) {
        var s = state();
        if (s.status !== 'playing') return false;
        if (!ui.flow) return true;
        return flowMover(currentStep()) === id;
    }

    board.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        var modEl = e.target.closest('.mod');
        if (!modEl || e.target.closest('.mod__ability')) return;
        var id = modEl.dataset.id;
        if (!canDrag(id)) return;
        drag = { id: id, el: modEl, x0: e.clientX, y0: e.clientY, active: false, hot: null, pointerId: e.pointerId };
    });

    window.addEventListener('pointermove', function (e) {
        if (!drag || e.pointerId !== drag.pointerId) return;
        var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.active) {
            if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
            drag.active = true;
            if (!ui.flow && ui.selected !== drag.id) { ui.selected = drag.id; render(); }
            drag.el.classList.add('is-dragging');
        }
        dx /= cam.zoom; dy /= cam.zoom;
        place(drag.el, state().pos[drag.id], dx, dy);

        // Which slot is under the card's centre?
        var p = cellToPx(state().pos[drag.id]);
        var cell = pxToCell(p.x + view.w / 2 + dx, p.y + view.h / 2 + dy);
        var hot = slots.filter(function (sl) { return sl.x === cell.x && sl.y === cell.y && sl.mover === drag.id; })[0] || null;
        if (hot !== drag.hot) {
            if (drag.hot) drag.hot.el.classList.remove('is-hot');
            drag.hot = hot;
            if (hot) { hot.el.classList.add('is-hot'); showPreview(hot.pos, drag.id); }
            else clearPreview();
        }
    });

    function endDrag(e) {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        var d = drag;
        drag = null;
        if (!d.active) return;
        suppressClick = true;
        setTimeout(function () { suppressClick = false; }, 0);
        d.el.classList.remove('is-dragging');
        if (d.hot) d.hot.go();
        // A dropped card is let go of: deselect it (whether it moved or snapped back).
        if (!ui.flow) ui.selected = null;
        render();
    }
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    /* ---------- toasts & dialogs ---------- */

    function toast(text) {
        $('toasts').innerHTML = '';
        var el = document.createElement('div');
        el.className = 'kt-toast';
        el.setAttribute('role', 'status');
        el.textContent = text;
        $('toasts').appendChild(el);
        requestAnimationFrame(function () { el.classList.add('is-visible'); });
        setTimeout(function () {
            el.classList.remove('is-visible');
            setTimeout(function () { el.remove(); }, 300);
        }, 4500);
    }

    function showDialog(titleText, bodyHtml, buttons) {
        var dlg = $('dialog');
        $('dialogTitle').textContent = titleText;
        $('dialogBody').innerHTML = bodyHtml;
        var footer = $('dialogFooter');
        footer.innerHTML = '';
        buttons.forEach(function (b) {
            var btn = document.createElement('button');
            btn.className = 'kt-btn ' + (b.cls || '');
            btn.textContent = b.label;
            btn.addEventListener('click', function () { closeModal(dlg); if (b.action) b.action(); });
            footer.appendChild(btn);
        });
        dlg.classList.add('is-open');
        var last = footer.lastElementChild;
        if (last) last.focus();
    }

    function closeModal(m) { m.classList.remove('is-open'); }
    function openModal() { return document.querySelector('.kt-modal.is-open'); }

    document.querySelectorAll('.kt-modal').forEach(function (m) {
        m.addEventListener('click', function (e) {
            if (e.target === m || e.target.closest('[data-close]')) closeModal(m);
        });
    });

    function buildRules() {
        $('moveTable').innerHTML = R.IDS.map(function (id) {
            var m = R.MODULES[id];
            return '<tr><td>' + m.name + '</td><td class="arrow-cell">' + MOVE_GLYPH[m.move] + ' ' + MOVE_NAME[m.move] + '</td><td>' +
                   R.dirsText(id).replace(/^./, function (c) { return c.toUpperCase(); }) + '. ' + esc(R.MOVE_TEXT[m.move]) + '</td></tr>';
        }).join('');
        $('abilityList').innerHTML = R.IDS.map(function (id) {
            var m = R.MODULES[id];
            var note = id === 'gripper' ? ' If you activate Brain, the chosen module goes next to Brain. If you activate Coil, Coil moves, not Gripper.' : '';
            return '<div class="kt-kv__row"><dt>' + m.name + '</dt><dd>' + esc(m.ability + note) + '</dd></div>';
        }).join('');
    }

    /* ---------- HUD controls ---------- */

    function setHudHidden(hidden) {
        hud.classList.toggle('is-hidden', hidden);
        $('showHudBtn').hidden = !hidden;
        try { localStorage.setItem(HUD_KEY, hidden ? 'hidden' : 'shown'); } catch (e) {}
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(function () {});
        else document.exitFullscreen();
    }

    function toggleDrawer(force) {
        var d = $('drawer');
        d.hidden = force === undefined ? !d.hidden : !force;
    }

    /* ---------- input ---------- */

    board.addEventListener('click', function (e) {
        if (suppressClick) return;
        var abilityBtn = e.target.closest('.mod__ability');
        var modEl = e.target.closest('.mod');
        if (abilityBtn && modEl) { e.stopPropagation(); startAbility(modEl.dataset.id); return; }
        if (!modEl) return;
        e.stopPropagation();
        var id = modEl.dataset.id;
        if (ui.flow) {
            var step = currentStep();
            if (step.kind === 'module' && step.options.some(function (o) { return o.id === id; })) pick(step.field, id);
            return;
        }
        select(id);
    });

    // Preview for module picks that change the layout (Laser's second pick).
    board.addEventListener('mouseover', function (e) {
        var modEl = e.target.closest('.mod');
        if (!modEl || !ui.flow || drag) return;
        var step = currentStep();
        if (step.kind !== 'module') return;
        var opt = step.options.filter(function (o) { return o.id === modEl.dataset.id; })[0];
        if (opt && opt.pos) showPreview(opt.pos);
    });
    board.addEventListener('mouseout', function (e) {
        if (e.target.closest('.mod') && ui.flow && !drag) clearPreview();
    });

    /* ---------- zoom (mouse wheel / trackpad pinch) and pan (drag the table) ---------- */

    var zoomFrame = null, zoomIdle = null, pendingZoom = null;
    var WHEEL_DEADZONE = 40, WHEEL_GESTURE_GAP = 250, PAN_THRESHOLD = 12;
    var wheelGesture = { sum: 0, last: 0, armed: false };

    window.addEventListener('wheel', function (e) {
        if (e.target.closest && e.target.closest('.hud__panel, .kt-modal')) return;
        e.preventDefault();
        var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;   // lines -> pixels

        // Ignore light brushes and leftover momentum: a scroll gesture only zooms once it adds up
        // to a deliberate amount. Pinch (ctrlKey) is always deliberate.
        var now = Date.now();
        if (now - wheelGesture.last > WHEEL_GESTURE_GAP) { wheelGesture.sum = 0; wheelGesture.armed = false; }
        wheelGesture.last = now;
        if (!e.ctrlKey && !wheelGesture.armed) {
            wheelGesture.sum += dy;
            if (Math.abs(wheelGesture.sum) < WHEEL_DEADZONE) return;
            wheelGesture.armed = true;
            dy = wheelGesture.sum;
        }

        var factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
        pendingZoom = pendingZoom || { factor: 1, x: e.clientX, y: e.clientY };
        pendingZoom.factor *= factor;
        pendingZoom.x = e.clientX; pendingZoom.y = e.clientY;
        if (!zoomFrame) zoomFrame = requestAnimationFrame(applyZoom);
    }, { passive: false });

    function applyZoom() {
        zoomFrame = null;
        var z = pendingZoom; pendingZoom = null;
        if (!z || drag) return;
        var next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * z.factor));
        if (next === cam.zoom) return;
        // keep the table point under the cursor fixed: screen = C + pan + (local - C) * zoom
        var Cx = view.W / 2, Cy = view.H / 2;
        var lx = Cx + (z.x - Cx - cam.panX) / cam.zoom;
        var ly = Cy + (z.y - Cy - cam.panY) / cam.zoom;
        cam.zoom = next;
        cam.panX = z.x - Cx - (lx - Cx) * next;
        cam.panY = z.y - Cy - (ly - Cy) * next;
        setCameraMode('follow');
        applyCamera();
        clearTimeout(zoomIdle);
        zoomIdle = setTimeout(function () { setCameraMode('smooth'); }, 200);
    }

    function resetCamera() {
        cam.zoom = 1; cam.panX = 0; cam.panY = 0;
        setCameraMode('smooth');
        applyCamera();
    }

    var pan = null;
    $('boardArea').addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || e.target.closest('.mod, .slot')) return;
        pan = { x0: e.clientX, y0: e.clientY, px: cam.panX, py: cam.panY, active: false, id: e.pointerId };
    });
    window.addEventListener('pointermove', function (e) {
        if (!pan || e.pointerId !== pan.id) return;
        var dx = e.clientX - pan.x0, dy = e.clientY - pan.y0;
        if (!pan.active && Math.hypot(dx, dy) < PAN_THRESHOLD) return;
        if (!pan.active) { pan.active = true; setCameraMode('none'); document.body.classList.add('is-panning'); }
        cam.panX = pan.px + dx; cam.panY = pan.py + dy;
        applyCamera();
    });
    function endPan(e) {
        if (!pan || (e && e.pointerId !== pan.id)) return;
        if (pan.active) {
            suppressClick = true;
            setTimeout(function () { suppressClick = false; }, 0);
            setCameraMode('smooth');
            document.body.classList.remove('is-panning');
        }
        pan = null;
    }
    window.addEventListener('pointerup', endPan);
    window.addEventListener('pointercancel', endPan);
    $('boardArea').addEventListener('dblclick', function (e) {
        if (!e.target.closest('.mod, .slot')) resetCamera();
    });

    $('boardArea').addEventListener('click', function (e) {
        if (suppressClick || e.target.closest('.mod, .slot')) return;
        if (!ui.flow && ui.selected) { ui.selected = null; render(); }
    });

    document.addEventListener('click', function (e) {
        var a = e.target.closest('[data-action]');
        if (!a) return;
        var act = a.dataset.action;
        if (act === 'cancel') cancelFlow();
        else if (act === 'ability') startAbility(a.dataset.id);
        else if (act === 'new') confirmNewGame();
    });

    $('missionBtn').addEventListener('click', missionComplete);
    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('newGameBtn').addEventListener('click', function () { toggleDrawer(false); confirmNewGame(); });
    $('giveUpBtn').addEventListener('click', function () { toggleDrawer(false); giveUp(); });
    $('logBtn').addEventListener('click', function () { toggleDrawer(); });
    $('drawerClose').addEventListener('click', function () { toggleDrawer(false); });
    $('rulesBtn').addEventListener('click', function () { $('rules').classList.add('is-open'); });
    $('fullBtn').addEventListener('click', toggleFullscreen);
    $('hideBtn').addEventListener('click', function () { setHudHidden(true); });
    $('showHudBtn').addEventListener('click', function () { setHudHidden(false); });

    var KEY_TO_ID = {};
    R.IDS.forEach(function (id) { KEY_TO_ID[R.MODULES[id].key.toLowerCase()] = id; });

    document.addEventListener('keydown', function (e) {
        if (shuffling) return;
        var modal = openModal();
        if (modal) {
            if (e.key === 'Escape') closeModal(modal);
            return;
        }
        var k = e.key.toLowerCase();

        if (k === 'z' && !e.altKey) {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
            return;
        }
        if (k === 'y' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); redo(); return; }
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === 'Escape') {
            if (!$('drawer').hidden) toggleDrawer(false);
            else if (ui.flow) cancelFlow();
            else if (ui.selected) { ui.selected = null; render(); }
        } else if (e.key === '?') {
            $('rules').classList.add('is-open');
        } else if (k === 'h') {
            setHudHidden(!hud.classList.contains('is-hidden'));
        } else if (k === '0') {
            resetCamera();
        } else if (k === 'f') {
            toggleFullscreen();
        } else if (k === 'a') {
            if (ui.selected) startAbility(ui.selected);
        } else if (KEY_TO_ID[k]) {
            if (!ui.flow) select(KEY_TO_ID[k]);
            else {
                var step = currentStep();
                if (step.kind === 'module' && step.options.some(function (o) { return o.id === KEY_TO_ID[k]; })) pick(step.field, KEY_TO_ID[k]);
            }
        }
    });

    var resizeTimer;
    window.addEventListener('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(render, 60);
    });

    /* ---------- boot ---------- */

    R.IDS.forEach(function (id) { [false, true].forEach(function (sp) { new Image().src = src(id, sp); }); });

    var fresh = load();
    save();
    buildModules();
    buildRules();
    try { if (localStorage.getItem(HUD_KEY) === 'hidden') setHudHidden(true); } catch (e) {}
    board.classList.add('no-anim');
    render();
    requestAnimationFrame(function () { requestAnimationFrame(function () {
        board.classList.remove('no-anim');
        if (fresh) shuffleIn();
    }); });
})();
