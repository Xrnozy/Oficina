# Visual Routing: design spec

The Workflow page is a drag-and-drop canvas like n8n. You build the agent flow by placing agents on a canvas, connecting them with lines, and moving them around. Nothing needs to be typed to build a basic flow.

This file defines how it looks and behaves. It extends `spec/DESIGN-figma.md` and reuses the existing Tailwind tokens in `ui/tailwind.config.js` (`canvas`, `surface`, `raised`, `line`, `fg`, `accent`, `ok`, `warn`, `bad`, `lime`, `lilac`, `cream`, `pink`, `mint`, `coral`, `navy`). Do not add new fonts or colors; use `Geist Variable` for text and `Geist Mono Variable` for ids, labels and counts. Use `reactflow` (already installed).

## 1. What you can do (interaction summary)

| You want to | You do |
|---|---|
| Add an agent | Drag it from the left palette onto the canvas |
| Move an agent | Drag the node anywhere; it snaps to a faint grid |
| Connect two agents | Drag from the right dot (output) of one node to the left dot (input) of another |
| Insert an agent between two | Drop the new agent on top of an existing line, or click the **+** on the line |
| Reorder the flow | Drag nodes and re-drag line ends; the flow order follows the lines |
| Delete a connection | Click the line, press `Delete` (or the trash icon in its toolbar) |
| Add a branch | Drag a **Condition** node in, connect its **Yes / Else** outputs to different agents |
| Let two agents talk directly | Drag from a node's bottom dot to another node: a dashed **Message** line |
| Give an agent skills | Select the node, use **Skills** in the right panel, or drag a skill from the Skills tab onto the node |
| Undo a mistake | `Ctrl+Z` / `Ctrl+Y` |
| Pan and zoom | Drag the empty canvas, scroll to zoom, or use the buttons/minimap |

## 2. Page layout

```
+--------------------------------------------------------------------------------+
| Workflow name v   Draft / v12 Active   [Validate] [Dry run] [Save] [Activate]  |
+---------+----------------------------------------------------+-----------------+
| PALETTE |                                                    | INSPECTOR       |
| Agents  |                 CANVAS                             | (selected node  |
| Logic   |      [Start]--->[PM]--->[Prompt]--->[Dev]--->[QA]  |  or line)       |
| Skills  |                              \--cond-->[Analyst]   |                 |
|         |                                                    | Skills          |
|         |   [-][+][fit][grid]   minimap (bottom-right)       | Limits          |
+---------+----------------------------------------------------+-----------------+
| Problems (2)  ·  Worst case: 14 agent calls  ·  Est. +3,100 skill tokens/run    |
+--------------------------------------------------------------------------------+
```

- Left palette 260px, right inspector 320px, both collapsible (`[` and `]` keys). Canvas fills the rest.
- Top bar is sticky, white with a hairline bottom border. Primary action **Activate** is a black pill; **Save**, **Validate**, **Dry run** are outlined pills.
- Bottom status bar (32px) shows validation problems (click to jump to the node), the worst-case agent call count, and estimated skill tokens.
- On narrow screens (<1024px) the palette and inspector become slide-over drawers. The canvas stays usable with touch (pinch to zoom, long-press to drag).

## 3. Canvas

- Background: `canvas` with a dot grid (1px dots every 20px in `line` color, 40% opacity). Grid snap 20px (toggle in the toolbar).
- Controls (bottom-left): zoom in/out, fit view, lock, toggle grid, auto-layout. Minimap (bottom-right): nodes tinted by role color, viewport rectangle in `accent`.
- Selection: click selects; `Shift`+click or drag a rectangle on empty canvas multi-selects; `Ctrl+A` selects all. Selected items get a 2px `accent` outline.
- Smooth: pan/zoom at 60fps with 50+ nodes. Node components are memoized; WebSocket events update only the nodes they affect.
- Keyboard: `Delete` remove, `Ctrl+C/V` copy/paste (pasted nodes offset 20px and keep config but get new ids), `Ctrl+D` duplicate, `Ctrl+Z/Y` undo/redo, `Space`+drag pan, `F` fit view, `Esc` clear selection, arrow keys nudge a selected node (Shift = 10 steps).
- Undo/redo covers add, move, delete, connect, disconnect, config edits. Draft autosaves every few seconds; a "Saved a moment ago" label appears in the top bar.

## 4. Palette (left)

Tabs: **Agents**, **Logic**, **Skills**. A search box filters the current tab (`/` focuses it).

- **Agents tab**: every workspace agent, grouped by role. Each row: colored role dot, agent name, backend/model in mono caption, status dot. Drag a row onto the canvas, or double-click to add at the center of the view. The same agent may appear in several nodes. Roles also appear as "Any <role>" entries for load-balanced routing.
- **Logic tab**: Condition, Merge, Human approval, End, plus Note (a sticky comment with no effect on the flow).
- **Skills tab**: every skill with name, size in characters, and an approval badge when pending. Drag a skill onto an agent node to attach it. A button creates a skill inline or imports a `SKILL.md` folder.

Role colors (reuse the pastel blocks): pm `lilac`, prompt-creator `cream`, developer `lime`, qa `mint`, reviewer `pink`, analyst `coral`, docs `cream`, logic nodes `surface` with a navy glyph, human approval `navy` with white text.

## 5. Nodes

Agent node (220px wide, 12px radius, 1px `line` border, soft shadow on hover only):

```
+--------------------------------------+
| (o) PM                         [..]  |  role-colored header: role dot, label, menu
| Maria (Claude Code · sonnet)         |  agent + model in mono caption
|--------------------------------------|
| Plan the request into tasks          |  one-line purpose (editable)
| [skill] [skill] +2                   |  skill chips (max 2 shown + count)
|--------------------------------------|
| status: idle   ~1.2k tok             |  live status + estimate
+--------------------------------------+
 (o) input                    output (o)
```

- **Handles**: input on the left, output on the right (round dots, 10px, filled `fg` on hover). A message handle on the bottom edge. Handles grow to 14px and glow when a compatible target is being dragged to.
- **Node states** (shown by a left color bar and a status chip): idle (gray), running (accent, subtle pulse, respects reduced-motion), done (ok), failed (bad), waiting for human (warn), skipped (dashed border), has validation error (red outline plus an icon with the message on hover).
- **Condition node**: a diamond-cornered card with the plain-language rule on its face ("If checks fail and attempts < 3"), outputs labeled **Yes** and **Else** (more outputs can be added, evaluated top to bottom). Else cannot be removed.
- **Merge node**: small pill with "Wait for all" / "Wait for any" toggle, multiple inputs, one output.
- **Human approval node**: navy card with a hand glyph and the question text; shows a "Needs you" badge while a run is waiting at it.
- **Start** (black pill) and **End** (black pill with check) are fixed, cannot be deleted, and each exists exactly once.
- Double-click a node title to rename inline. Right-click opens a context menu: duplicate, disable (node is bypassed and the flow passes through), replace agent, delete, open in Skills.
- Node menu (`..`): duplicate, disable, replace agent, delete.

## 6. Lines (edges)

- Smooth bezier curves, 2px, with an arrowhead. Straight on `Shift` held for a "step" style option in the toolbar.
- **Kinds** (also a legend in the toolbar):
  - **Next**: solid `fg`.
  - **On success**: solid `ok` green.
  - **On failure**: solid `bad` red.
  - **On reject / send back**: solid `warn` amber, curving backwards, with a loop counter badge (`2/3`).
  - **Message** (direct agent to agent): dashed `info` blue, with a small envelope icon at its midpoint.
- Every line shows its label in a small white pill at the midpoint; branch lines show their condition summary.
- Hover a line: a floating toolbar appears with **+ insert agent**, **edit**, **trash**. Click selects it and shows its settings in the inspector (label, kind, condition, "wait for reply" and timeout for message lines).
- **Insert on a line**: drag any palette item over a line; the line highlights and a "Drop to insert here" tip shows. On drop the line splits into two, the node is placed in the middle, and neighbors shift apart if overlapped. The **+** button opens a quick-pick (search agents/logic) and does the same.
- **Connecting rules**: an output may connect to many inputs (fan-out); an input may receive many lines (use Merge to join). You can't connect a node to itself, can't connect into Start or out of End, and can't create a loop unless the line is an on-reject/on-failure line (which prompts for max loops, default 3). Invalid targets show a red "not allowed because ..." tooltip while dragging.
- Dropping a line end on empty canvas opens the quick-pick to create and connect a new node in one move (like n8n).

## 7. Inspector (right)

Context-sensitive; empty state says "Select a node or line to edit it".

- **Node**: Overview (label, purpose, agent or role, model tier override), **Prompt** (extra instructions, inputs it receives: full previous output / hand-off summary only / specific earlier nodes), **Skills**, **Limits** (token budget, timeout, read-only vs can edit files), **Routing** (what happens on failure), **Advanced** (disable, ids).
- **Skills section**: attached skills as chips with a source badge (node / agent / role; agent and role ones greyed), drag handles to reorder priority, an **Add skill** picker, remove (x), and a meter: "2,400 of 6,000 characters used". A skill pending approval shows an amber "Waiting for approval" badge and a warning in the status bar.
- **Line**: label, kind, condition builder, max loops, message options.
- **Condition builder**: rows of `[field v] [operator v] [value]` with `+ and` / `+ or`, and a plain-language preview line above. Fields: previous step result, checks passed/failed, files changed match, task type, difficulty, attempt count, reviewer verdict, field in the hand-off summary.

## 8. Run view (live, read-only overlay)

- Toggle **Edit | Live** in the top bar. In Live the canvas is locked.
- Pick a run from a dropdown (or open from a run page). The path taken is drawn in bold `accent`, untaken branches fade to 30% opacity, loops show their count, the currently running node pulses and shows elapsed time.
- Click a node to open its task and live activity in a side drawer. Click a line to see why the branch was taken ("checks failed: unit:all").
- A scrubber replays a finished run step by step.
- Events update only the nodes they touch; no full re-render.

## 9. Dry run

A **Dry run** button opens a panel: choose a sample task and set each step's outcome (pass / fail / approve / reject) with toggles. The canvas animates the path through the graph with no model calls and no tokens used, and lists the sequence of steps and the number of agent calls. Use it to test branches and loops before activating.

## 10. Validation and feedback

- Problems appear in the status bar and on the node, with plain messages ("PM has no outgoing line", "Condition needs an Else line", "Loop needs a max count"). Clicking one centers and selects the node.
- Save and Activate are disabled while errors remain; warnings don't block.
- Toasts for save, activate, import/export, auto-layout. Destructive actions (deleting several nodes, restoring an old version) show an undo toast instead of a confirm dialog.
- Empty canvas shows a friendly starter: **Start from template** (Default pipeline, Fast path, Strict, Docs only, Bug-fix, Parallel review), **Clone active workflow**, or **Blank**.
- The built-in default workflow opens read-only with a banner: "Built-in. Clone to edit".

## 11. Accessibility and responsiveness

- All actions reachable by keyboard: `Tab` moves between nodes, `Enter` opens the inspector, arrow keys nudge, `C` starts a connection from the selected node (then arrows + `Enter` choose the target).
- Minimum contrast 4.5:1 for text; do not rely on color alone for edge kinds (line style, icon and label also differ). Focus rings visible. Respect `prefers-reduced-motion` (no pulsing, no animated paths).
- Light and dark themes follow the app's existing theme variables.

## 12. Acceptance checklist

The design is done when all of these work in the browser:

1. Drag an agent from the palette onto the canvas, then move it; position persists after reload.
2. Connect two nodes by dragging between handles; an invalid connection is refused with a tooltip.
3. Drop an agent onto an existing line and it is inserted between the two nodes; the order of work in a run follows the new order.
4. Add a Condition node with Yes/Else branches, save, and a run takes the right branch.
5. Add a Message line between two agents; the recipient receives the message in its next prompt.
6. Attach a skill to a node by dragging it on; the meter updates and the run's `skill.applied` event shows source `node`.
7. Undo/redo works for every edit; copy/paste and multi-select work.
8. 50 nodes pan and zoom smoothly.
9. Live view highlights the running node and the path taken.
10. With no custom workflow, the app behaves exactly as before.
