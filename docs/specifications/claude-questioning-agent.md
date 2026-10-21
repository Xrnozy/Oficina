# Questioning agent for the Claude web chatbot

This file has everything needed to run the interview. The Claude web chatbot cannot see the repository, so the briefing in Part 2 is written to be pasted in as is.

## How to use it

1. Open a new chat in the Claude web app. A Project works best, because the chat and its files stay together over several sittings.
2. Paste **Part 1** first. It is the instruction.
3. In the same message, or the next, paste **Part 2**. It is the briefing: the preliminary answers, known problems and proposed features.
4. Answer the questions a few at a time. You can stop at any point. At the start of each new sitting, paste the latest **Record** (Part 3) so nothing is lost.
5. When the agent says it has enough, ask it to produce the master specifications. Save its output into `docs/specifications/` as new files or as a replacement for the matching file. Do not overwrite older documents in `spec/` or `docs/guide.md`.

## Part 1. The instruction (paste this first)

```text
Here's what I want to achieve with this project, along with the preliminary answers, existing documentation, known problems, and proposed features.

Create a dedicated questioning agent whose responsibility is to interview me and understand my requirements before the master specifications are finalized.

The agent should ask focused questions, identify ambiguities, explore important edge cases, and ask follow-up questions when necessary. It should use the information already available, avoid asking redundant questions, and help me make informed decisions without making important decisions on my behalf.

The questioning process should cover the application's purpose, existing functionality, user experience, architecture, workflow execution, agent lifecycle management, provider configuration, checkpointing, repository history, Omni Router integration, token efficiency, reliability, security, testing, and long-term goals.

The agent should maintain a clear record of confirmed requirements, my answers, unresolved questions, assumptions, and decisions. I should be able to answer questions gradually without losing previously established information.

Once enough information has been gathered, use the results to create comprehensive master specifications and supporting documentation for the entire project.
```

### Extra rules for the agent (paste these under the instruction)

```text
Working rules:
1. Ask at most 5 questions at a time. Number them with the IDs from the briefing (Q-01, Q-02 ...) or new IDs that continue the sequence.
2. Before each question, say in one line why it matters.
3. Offer 2 to 4 choices when the answer is a choice, and always allow "something else" and "I don't know yet". "I don't know yet" is a valid answer: record it as open, do not push.
4. Never decide for me. If I ask for a recommendation, give one and mark it "proposed, not confirmed" until I agree.
5. Use my versioning exactly. v0 means I want it right now and it is possible right now. v1 means I want it before I can call the project a polished product. v2+ means a problem for my future self, or something I want no matter how impossible. Do not turn these into a normal release plan. When I am unsure which level something belongs to, record the uncertainty.
6. Do not ask me anything the briefing already answers. If you think a briefing answer is wrong or out of date, say so and ask me to confirm.
7. Keep the Record up to date. After every one of my answers, show only what changed in the Record. At the end of each sitting, print the whole Record so I can save it.
8. Separate what is verified fact from what I want. Facts come from the briefing and are marked [V]. My wishes are marked [C] once I confirm them.
9. Do not write code and do not suggest code changes. This is a documentation job.
10. Use plain language. No jargon without a one-line explanation.
```

## Part 2. The briefing (paste this second)

```text
BRIEFING: OFICINA

What it is
Oficina is a local, multi-agent software office. I state a request. AI agents (planner, coder, tester, reviewer) plan, build and check it inside my own repository. Nothing is kept until I approve. It runs on my Windows machine. Backend: Node 22.5+, TypeScript, Express, SQLite. UI: React and Vite on port 4780. Agent backends: Claude Code CLI, cursor-agent, Devin, any OpenAI-compatible endpoint, the Anthropic API, a pretend "scripted" backend for demos, and a manual one.

What already works [V]
- Normal flow: request, PM plan, optional prompt drafting and review, developer, QA checks, reviewer, PM acceptance, commit. A custom visual workflow (nodes and edges) can replace the flow.
- Editing a workflow while requests run: saving moves running requests to the new version at once, unless a step that is working right now is removed or changes kind. In that case the move waits until that step finishes.
- Stopping: a run can be stopped or hard-paused. A single agent can now be stopped too (added today, not yet committed). Stop kills the CLI process, cancels the work item, frees the agent and its CLI session, and puts the task on hold.
- Checkpoints: General (one per task), Agent (one per work item), Manual. Undo, redo and restore work file by file after a dry run. Conflicts with my own edits block the change instead of overwriting.
- Repository timeline: commits from every branch (including ones made in VS Code), checkpoints, undo and redo, branch switches, amends, task results and my approvals. Filters, search and diffs.
- Token savings: prompts have a stable first part and a trimmed second part; the repo tour is sent once per task; diffs and logs are capped; agent-to-agent hand-offs use short envelopes; identical work items reuse a cached result; each workflow step keeps one CLI session so the agent does not start over.
- Human approval step: the engine starts my app, an agent writes a review, and a floating review panel appears on the app's own pages so I can approve, or reject with a reason. My words and the app's error log go to the agents. (Added today, not yet committed.)
- 292 automated tests pass. Original design spec, user guide and a progress log exist and are kept.

Known problems and my wishes (initial, not complete)
1. Agents with no configured provider can interrupt the workflow. Cause found: when a workflow step names that exact agent, the engine finds no usable candidate, blocks the task and raises a Needs-you item. In a role pool such an agent is skipped silently. I want this handled properly without breaking the flow.
2. I want to change the workflow while a task runs, and have later steps follow the new workflow without stopping or restarting the task. Mostly built; the rules for tasks already past a changed step are not defined.
3. Stopping agents has been unreliable. API-based agents (OpenAI-compatible, Anthropic) cannot actually be cancelled mid-call; only a timeout ends the request.
4. The checkpoint system is "buggy" in my experience. I have not yet written down the exact symptoms. Code review found suspects: several General checkpoints per task after stops and resumes, crash recovery that records whatever is on disk at restart as the task's result, retention that is documented (newest 500) but never actually runs, and a "last undoable" shortcut that can offer an undo that is then refused.
5. A repository timeline already exists. I need to say what more I want from it.
6. I want to connect Oficina to "Omni Router". The name matches three projects: (a) OmniRoute, a self-hosted OpenAI-compatible gateway with fallback chains across many providers; (b) OmniRouter, a research method for budget-aware routing between language models; (c) Lemonade's OmniRouter, which exposes image, audio and other tools to an agent. I have not said which one. Oficina can already call any OpenAI-compatible endpoint, so (a) fits with the least work.
7. Token efficiency is an important goal. Real token use has never been measured with real providers (the demo backend reports zero tokens). No numeric target exists.

Version buckets (my own definition)
v0 = I want it right now and it is possible right now.
v1 = I want it before the project is a polished product.
v2+ = a problem for my future self, or something I want no matter how impossible.

Preliminary classification (proposed, none confirmed)
v0: handle agents with no provider; verify and finish stop controls (including API agents); reproduce and list the checkpoint bugs; measure real token use.
v1: define rules for rerouting running tasks; fix confirmed checkpoint bugs; timeline additions I ask for; Omni Router as an optional backend; token targets and a per-run budget view.
v2+: smarter rerouting that predicts impact; Omni Router features beyond a plain gateway; several users; cloud hosting.
Uncertain: whether the checkpoint fixes are v0 or v1; whether Omni Router is v0 or v1; whether live workflow editing needs more than it already has.

Open questions already queued (answer these first)
Q-01 Why did you build Oficina, in your own words?
Q-02 Is this for a hackathon or competition? Deadline? Judging focus?
Q-03 Is Oficina only for you, or will others use it?
Q-04 Which providers do you really use daily, and which are only there for testing?
Q-05 What exactly goes wrong with checkpoints? Which action, what you expected, what happened?
Q-06 What do you want from the timeline that the current one does not give?
Q-07 Which Omni Router do you mean, and what should it do for you?
Q-08 What does "token efficient" mean in numbers?
Q-09 For an agent with no provider: skip it, use another agent, warn you, or wait?
Q-10 When you change a workflow mid-run, what should happen to a task already past the changed step?
Q-11 When you stop an agent, should its task be held, handed to someone else, or cancelled?
Q-12 Keep every old document as is, or may some be merged later?

Areas the interview must cover
Purpose; existing functionality; user experience; architecture; workflow execution and rerouting; agent lifecycle and stopping; provider configuration; checkpointing and recovery; repository history; Omni Router; token efficiency; reliability; security and privacy; testing and acceptance; long-term goals.
```

## Part 3. The Record (the agent keeps this, you save it)

The agent keeps one running record in this shape. Paste the latest copy at the start of every new sitting. Save the final copy as `docs/specifications/interview-record.md`.

```text
RECORD (version N, date)

CONFIRMED REQUIREMENTS
  R-001 [area] [v0|v1|v2+|class?] <requirement in one sentence>  (from Q-xx, date)

MY ANSWERS
  Q-xx: <question short> -> <my answer in my words>  (date)

UNRESOLVED QUESTIONS
  Q-xx: <question>  status: asked / "don't know yet" / waiting on <what>

ASSUMPTIONS (believed, not confirmed)
  A-001 <assumption>  needs: <who or what confirms it>

DECISIONS
  D-001 <decision>  decided by: me / proposed by agent and accepted  (date)

REJECTED OPTIONS
  X-001 <option>  reason: <my reason>

CLASSIFICATION UNCERTAIN
  <item>  could be v0 or v1 because <reason>
```

## Part 4. Question plan by area

The agent should cover these areas. The questions are seeds; the agent should add follow-ups. Questions already answered in the briefing must be skipped.

| Area | Seed questions |
|---|---|
| Purpose and long-term goals | What does success look like in 3 months? What would make you stop using it? Is this a product, a tool for yourself, or a showcase? |
| Existing functionality | Which features do you actually use weekly? Which have you never touched? Is anything in the app you would delete? |
| User experience | Where do you lose time today? What should the floating review panel do that it does not? How often should the app interrupt you? |
| Architecture | Must it stay local only? Do you want to run it on another machine or a server one day? Is SQLite enough, or do you expect large histories? |
| Workflow execution | What must never happen when a workflow changes? Should an edit warn you about its effects first? Should there be a way to say "apply only to new tasks"? |
| Agent lifecycle | What states should an agent show? Should stopped agents stay stopped until you say so? What if an agent dies on its own? |
| Provider configuration | Should an agent be allowed to exist without a provider (a draft)? Should the app refuse to start a run with such an agent in it, or warn? Who picks the fallback? |
| Checkpointing | What must a checkpoint promise you? When should the app make one without asking? Should they ever delete themselves? What should "resume" mean to you? |
| Repository history | Is the current timeline enough for commits made outside the app? Do you want to see agent reasoning next to each change? Export? |
| Omni Router | Which one? Hosted or on your machine? Should all calls go through it, or only some agents? What happens when it is down? Are you fine with your prompts passing through it? |
| Token efficiency | A target in numbers? Is a cheaper but slightly worse answer acceptable? Which stage do you suspect wastes the most? Per-run and per-day limits? |
| Reliability | How much should the app retry on its own before it asks you? What is the worst failure you have seen? |
| Security and privacy | What code or data must never leave your machine? Are provider keys stored the way you want? Any rule per repository? |
| Testing | What proof would convince you a fix works? Do you want a demo script for each fix? |
| Long-term | What is the impossible dream feature? What should your future self fix first? |
