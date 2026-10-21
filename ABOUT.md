# About Oficina

## What is it?

Oficina is a small office of AI helpers that lives on your computer.

You tell it what you want built, like "add a login page" or "add a dark mode button". The helpers do the work. One makes a plan. One writes the code. One tests it. One checks the result.

You are the boss. Nothing is kept until you say yes.

## Why was it made?

AI helpers can write code now, but using them is messy.

- You run one helper at a time and watch it like a hawk.
- You can't tell what it really did, or whether it tested anything.
- It can change a lot of files before you notice.
- Several helpers don't know about each other, so they undo each other's work.

Oficina fixes that by working like a real team.

- **Everyone has a job.** Planner, coder, tester, checker. They pass work to each other, like in an office.
- **Facts beat promises.** The program runs your project's own tests itself. An agent can't just say "it works".
- **You stay in charge.** You see every change and can approve it, reject it, or undo it later.
- **It stays on your computer.** Your code is not uploaded to a new service. You pick which AI to use and how much it can spend.

> Note for the author: this section explains the idea from how the app is built. If you had a more personal reason for making it, such as a hackathon story or a problem you ran into, replace this section with your own words.

## How a job goes

1. **You ask.** Type what you want.
2. **They plan.** The planner splits it into small jobs.
3. **They build.** The coder edits files in your project.
4. **They check.** Your tests run. A tester and a reviewer look at the work.
5. **You test it yourself.** Oficina starts your app and opens it with a small floating panel on the page. Click around, then press **Approve**, or press **Request changes** and say what is wrong.
6. **They fix it.** If you said no, the helpers read your words and the app's error log, fix the problem, and send you a new review.
7. **It is saved.** Only after you approve.

## What you get

- **A team you can see.** Who is working, who is waiting, and what each one is saying.
- **Safe changes.** Checkpoints and a timeline, so you can go back.
- **A waiting list.** Save ideas now and start them later.
- **Your choice of AI.** Use Claude Code, Cursor, Devin, or a model through an API key. Different helpers can use different ones.
- **A spending limit.** Set how much a job or a day may cost.
- **A demo team.** It uses pretend AI, so you can try everything for free.

## Who is it for?

- People who want AI to build things but don't want to lose control of their code.
- Teams who want a clear record of who changed what, and why.
- Anyone who has been burned by an AI that said "done" when it wasn't.

## Try it

You need Node.js (22.5 or newer) and Git.

```bash
npm install
npm run build -w ui
npm start
```

Open http://localhost:4780 and click **New run**.

For pictures of every screen, see the [README](README.md).
