# ROVE Tabletop

A module board for the solo card game [ROVE: Results-Oriented Versatile Explorer](https://boardgamegeek.com/boardgame/342562/rove-results-oriented-versatile-explorer)
by Button Shy Games. Mission and movement cards stay in your hand on the table. This page handles the six modules.

- A full-screen Mars table that zooms the modules as large as the screen allows. The controls float on top; `H` hides them, `F` goes fullscreen.
- Drag a module onto a glowing space, or click it and then the space. Only legal destinations glow, and Motor shows a preview of what its push moves.
- Click the ★ strip on a card (or select it and press `A`) to resolve its ability step by step.
- Counts moves per mission and in total, tracks missions (7 to win), and keeps a history with undo/redo.
- The game is saved in the browser, so a refresh keeps your progress.

Only moves that follow the rules are offered: no stacking, and the modules always stay in one group
connected edge-to-edge or corner-to-corner.

## Run

Open `index.html` in a browser. There's no build step, and it works from `file://` or GitHub Pages.
Dialogs and type come from [kt-styles](https://koraytugay.github.io/kt-styles/). The Mars scene palette lives in `css/app.css`.

## Files

- `js/rules.js`: the rules engine (pure functions, no DOM)
- `js/app.js`: the board UI
- `css/app.css`: layout on top of kt-styles
- `img/`: module art, front (★ active) and back (✕ spent)

## Tests

```
node --test tests/*.test.js
```
