<div align="center">

# Oficina

**A team of AI helpers that builds software for you, on your own computer.**

You say what you want. They plan it, build it, and test it.
You stay the boss.

<img src="docs/screenshots/dashboard.png" alt="The dashboard after a finished job, with every goal checked off" width="900">

</div>

## What is this?

Think of a small office. Each worker is an AI. One makes the plan. One writes the code. One tests it. One checks the work.

You tell the office what you want. They do the job. Nothing is kept until you say yes.

A worker is called an **agent**. A group of agents is a **team**. Each team has its own **office**.

## How it works

1. **You ask.** Type what you want. For example: "Add a dark mode button."
2. **They plan.** The planner breaks your idea into small jobs.
3. **They build.** The coder changes the files in your project.
4. **They check.** Your project's own tests run. Then a tester looks it over.
5. **You decide.** You say yes or no before anything is saved. You can always undo.

## Start in 3 minutes

First, install two free things: Node.js (version 22.5 or newer) and Git.

Then open a command window in this folder and type:

```bash
npm install
npm run build -w ui
npm start
```

Open http://localhost:4780 in your browser. Click **New run**.

A demo team is ready to try. It uses pretend AI. You don't need an account and it costs nothing.

On Windows, you can double-click `start-office.bat` instead. Or double-click `start-office-tray.bat` to put a small Oficina icon by your clock.

## A tour, one feature at a time

### Ask for something

Type what you want. Press **Send to PM**. The planner takes it from there.

You can also add files, like a design or a list of rules. The agents will read them.

<img src="docs/screenshots/new-run.png" alt="The New run box with a request typed in" width="900">

### Save ideas for later

Not ready yet? Press **Queue for later**. Your idea waits in a list. Press **Start** when you want it done.

You can also type an idea from the small icon by your clock.

<img src="docs/screenshots/queue.png" alt="A waiting list of three ideas, each with a Start button" width="900">

<img src="docs/screenshots/tray-quick-request.png" alt="The clock icon popup where you type a quick idea" width="420">
<img src="docs/screenshots/tray-menu.png" alt="The menu you get when you right-click the clock icon" width="260">

### It learns what your project is made of

Oficina looks at your files. It can tell if you have a website, a phone app, a game, a small device, or a server. Then it tells the agents what matters most.

It also finds your tests and runs them after every change. Green means the test must pass. Yellow means the test was already broken, so Oficina won't blame the agents.

<img src="docs/screenshots/project.png" alt="A project with an API, a dashboard and device code, and the tests found for each" width="900">

### Watch the team work

See who is working and who is waiting. Read what each agent says and does, as it happens. Changes to your files show up on the right.

<img src="docs/screenshots/activity.png" alt="Live activity: working agents on the left, their steps in the middle" width="900">

### You say yes or no

Before a change is saved, you get to look at it. You see which files changed and what the note says. Press **Approve** or **Reject**. If you reject, tell the agent what to do differently.

<img src="docs/screenshots/needs-you.png" alt="An approval panel showing the changed files and the note, with Reject and Approve buttons" width="900">

### See every task

Each job gets a card. The cards move across the board as the work goes on.

<img src="docs/screenshots/tasks.png" alt="The task board with columns from On hold to Done" width="900">

Click a card to see the details and the exact code that changed.

<img src="docs/screenshots/task-detail.png" alt="One task, with its goals and the lines of code that changed" width="900">

### Replay what happened

Everything is written down. Slide back in time. Press play and watch the whole job again, step by step. Nothing runs twice.

<img src="docs/screenshots/timeline.png" alt="A timeline with one row for each agent and a play button" width="900">

### Undo anything

Every change is saved as it happens. You can take back a whole job, or just one file. You can put it back again too.

<img src="docs/screenshots/checkpoints.png" alt="A list of saved points with Undo and Redo buttons" width="900">

This page shows everything that happens to your project. That includes changes by the AI and changes by you.

<img src="docs/screenshots/repo-timeline.png" alt="A list of every change to the project, from the AI and from you" width="900">

### Choose how the work flows

There is a standard flow. Plan, write, build, test, check, done.

<img src="docs/screenshots/workflow.png" alt="The standard flow drawn as boxes and arrows" width="900">

You can draw your own. Add steps. Add choices, like "if it is a docs job, go this way." Add loops, like "if the test fails, try again." Add stops where you say yes or no.

<img src="docs/screenshots/workflow-custom.png" alt="A custom flow that splits docs jobs and code jobs, with try-again loops" width="900">

### Pick the right AI for each step

Easy jobs go to a fast, cheap AI. Hard or risky jobs go to a smarter one. This page shows who does each step. You can pick the AI level for any step, or for any agent: Auto, Fast, Standard or Strong.

<img src="docs/screenshots/routing.png" alt="The flow as a numbered list, with the agent for each step" width="900">

<img src="docs/screenshots/tier-override.png" alt="Choices for how smart the AI should be: Auto, Fast, Standard, Strong" width="900">

### Use any AI you like

Claude Code, Cursor, Devin, OpenAI, Ollama, LM Studio or Anthropic. Each agent can use a different one.

Add one on the Providers page. If you use Claude Code, Cursor or Devin, log in to that tool first. You don't need to paste in a key.

<img src="docs/screenshots/providers.png" alt="The list of AI providers you can use" width="900">

<img src="docs/screenshots/add-backend.png" alt="The form for adding a new AI provider" width="900">

### Meet your agents

Each agent has one job and its own AI. You can change the AI, set a spending limit, or send the agent a message.

<img src="docs/screenshots/agents.png" alt="Cards for each agent with their job, AI and limits" width="900">

<img src="docs/screenshots/agent-settings.png" alt="Agent settings: the AI to use, how smart it should be, and how it keeps its chat" width="900">

### Agents remember

Each agent keeps one chat going, so it does not forget your project from one job to the next. You can open the same chat in a command window and keep talking to it yourself.

<img src="docs/screenshots/sessions.png" alt="A list of agent chats, with how many times each was used" width="900">

### Agents talk to each other

They pass notes, questions and warnings. You can read all of it. You can also send your own note to any agent.

<img src="docs/screenshots/messages.png" alt="The team conversation, with notes passed between agents" width="900">

### A running summary

One page tells you the goal, the plan, who does what, how far along it is, and what was decided. It is written for you, and you can download it.

<img src="docs/screenshots/project-record.png" alt="A summary page with the goals, the plan and the decisions" width="900">

### Problems get written down

When a test fails, Oficina makes a report. It shows how bad it is and whether it is fixed. It also remembers fixes from before.

<img src="docs/screenshots/errors.png" alt="A list of reports about failed tests, marked resolved" width="900">

### Teach agents your habits

Write a short rule, like "keep changes small." Give it to every agent, or just one job. Agents follow it.

<img src="docs/screenshots/skills.png" alt="Your rules for agents, listed by job" width="900">

### One office for each project

Each project gets its own office. Each office has its own team and its own flow. Drag agents between desks to change what they are allowed to do.

<img src="docs/screenshots/office.png" alt="An office with agents sitting at their desks" width="900">

Make a new office. Start empty, or copy a team you already have.

<img src="docs/screenshots/new-office.png" alt="The new office form with Blank and Copy choices" width="900">

A new office tells you what to do next.

<img src="docs/screenshots/office-setup.png" alt="An empty office with a four-step to-do list" width="900">

### Small extras

Press Ctrl+K to jump to any page, task or agent.

<img src="docs/screenshots/command-palette.png" alt="The search box that jumps to any page" width="900">

There is a dark mode too.

<img src="docs/screenshots/dark-mode.png" alt="Live activity in dark mode" width="900">

## You stay in charge

- Say yes or no to plans and saves.
- Set limits on time and money.
- Pause or stop at any time.
- Undo any change.
- Your data stays on your computer.

## Want more?

- [Full guide](docs/guide.md): every feature and setting.
- [Design notes](spec/AI-Agent-Office-Spec.md): why it is built this way.

<details>
<summary><b>For developers</b></summary>

```bash
npm run dev               # run with auto-reload
npm run dev:ui            # UI with hot reload
npm test -w daemon        # run the tests
npm run bench -w daemon   # full demo run, no AI calls
```

The code lives in two folders: `daemon/` (the engine) and `ui/` (the web page). Your data stays on your computer, in `daemon/data/`.

</details>

<sub>The screenshots use the demo team, so no real AI was used.</sub>
