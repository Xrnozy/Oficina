# Omni Router integration

Labels are in the [README](README.md). Requirements: REQ-OMR-01 to 05.

The owner wants Oficina connected to "Omni Router". **Nothing about it exists in the repository**, and the name belongs to more than one project. This document sets out what each candidate is, what connecting it needs, and how the best-fitting one would sit in the architecture. The owner must choose (Q-07) before any design is final.

## 1. What "Omni Router" could mean

Research done on 2026-10-21 from public pages. The sources are listed at the end. Facts about other projects are **external** and can change.

| | A. OmniRoute | B. OmniRouter (research) | C. Lemonade Omni Router |
|---|---|---|---|
| What it is | A self-hosted gateway. One local address in front of many model providers. | A method from a research paper on choosing among language models under a total budget. | A part of the Lemonade server that offers image, audio and other tools to an agent. |
| Kind | A running service with a dashboard. | Code and a dataset. Not described as a service. | A feature of another server. |
| Interface | OpenAI-compatible `/v1/chat/completions`, `/v1/models`, `/v1/responses`. Also claims Claude and Gemini compatibility under `/v1`. | A set of queries, a pool of models with predicted cost and ability, and a budget. | OpenAI-compatible tool endpoints. |
| Default address | `http://localhost:20128` | none | not checked |
| Licence | MIT | not checked | not checked |
| Fit with Oficina | **Good.** Oficina already calls any OpenAI-compatible endpoint. | **Indirect.** It would be an idea to build into Oficina's own router, not something to connect to. | **Poor.** It exposes tools. Oficina's agents need text models that edit code. |
| Evidence strength | Read from its own GitHub page. | Read from its paper page. | A search result only. Its documentation page returned 404, so nothing was confirmed. |

**[A] Working assumption:** the owner means **A, OmniRoute**. Reasons: the owner said "connect the application to Omni Router", which describes a service; A is the only candidate that is a connectable service for text models; Oficina's OpenAI-compatible adapter already matches its interface. This is an assumption, not a decision. If the owner means B, the work is a routing-policy change inside Oficina (level v2+), not an integration. If the owner means C, it likely does not apply.

## 2. How Oficina routes today **[V]**

`daemon/src/services/router.ts`, `routing.ts`, `adapters/llm.ts`.

1. Oficina picks an **agent** for the step (role pool or pinned agent).
2. It works out the **tier** needed (fast, standard, strong) from the work kind and task difficulty, with a risk floor.
3. It orders the agent's model options and takes the cheapest usable one at or above the tier. Plan-billed accounts are preferred over metered ones.
4. It skips options with an open circuit, an exhausted quota window or a spent monthly budget, and it tries the next option on failure.
5. It records token use and cost from its own price table, and quota windows from response headers.

The `openai-compatible` adapter posts to `<baseUrl>/chat/completions` with an optional bearer key. It sends `model`, `max_tokens`, optional `temperature`, optional `reasoning_effort` and two messages. It reads `usage.prompt_tokens` and `usage.completion_tokens`. The `anthropic` adapter posts to `<baseUrl>/v1/messages`. Both time out at 240 and 300 seconds and cannot be cancelled by a stop. **[V]** `llm.ts`.

## 3. How A (OmniRoute) would fit

### 3.1 Facts about OmniRoute **[V]** against its own page, 2026-10-21

- Self-hostable, MIT licence, local-first. Install through npm (`omniroute`), Docker (`diegosouzapw/omniroute`) or a desktop build. Default address `http://localhost:20128`. Headless mode runs only the `/v1/*` proxy.
- Clients send a gateway key as a bearer token. Keys come from its dashboard and can be pinned to one model or combo.
- `model: "auto"` builds a combo from the connected providers. Variants include `auto/coding`, `auto/fast`, `auto/cheap`. It lists many routing strategies (priority, round-robin, cost-optimized and others) and fallback across tiers (subscription, API key, cheap, free). It has circuit breakers, cooldowns and per-model lockouts.
- Responses carry `X-OmniRoute-*` cost and usage headers and a decision header. Per-key spend quotas exist.
- Provider keys are stored encrypted. Whether prompts are stored is **not clear from the page**.
- Warnings on its page: a transparent interception mode exists and needs careful review; a generated `.env` must never be committed; some providers are marked as against their terms and are excluded from automatic routing by default.
- Provider counts differ by source (about 236, 290 and 375). The version and numbers move quickly. **[?]** pin a version before relying on any claim.

### 3.2 Where it plugs in

```
            Oficina router                      OmniRoute (optional)
 step  ->   picks agent + tier + model   ->     picks the upstream provider
            (decides WHAT is asked)             (decides WHO answers)
                         |                               |
                         +--- openai-compatible adapter -+---> provider
                         +--- direct adapter (fallback) -----> provider
```

Three ways in, from least to most work:

| Way | What it takes | Level |
|---|---|---|
| 1. A provider entry. Add an `openai-compatible` provider with base URL `http://localhost:20128/v1` and a gateway key. Agents that should use it point their account at it. | No code. Configuration only. **[A]** that the gateway accepts the fields the adapter sends (`reasoning_effort`, `max_tokens`). | v0 or v1 **class?** |
| 2. Make it safe and visible: fallback to a direct provider when the gateway is down, per-agent opt-in, consent per repository, a health check, usage and cost still shown per agent. | Adapter and router changes. See requirements below. | v1 |
| 3. Read the gateway's cost and decision headers, and map Oficina's tier names to gateway model names or combos. | Adapter change plus a mapping table in settings. | v1 |

CLI agents are a separate case. OmniRoute's page shows a command that runs Claude Code through it (`omniroute run claude --model ...`) and one that writes the tool's own configuration. Whether Oficina's CLI adapter can use either without breaking session continuity (resume with `--resume`) is **[?]** and needs a test.

### 3.3 Overlap and conflict to design around **[P]**

Two routers can make the same decision twice or fight.

| Concern | Risk | Proposed rule |
|---|---|---|
| Retries and fallback | Oficina retries and falls back; the gateway does the same. A failure can multiply retries. | Oficina treats the gateway as one provider. It sets the gateway to no retry across tiers for Oficina calls, or Oficina does not retry a failure the gateway already retried. Decide per call. |
| Model choice | Oficina picks a tier and a model name; a gateway combo may pick a different model. | Use named combos or fixed model ids for Oficina agents. Do not use `auto` for work with a risk floor. |
| Cost accounting | Oficina uses its own price table; the gateway knows the true cost and shows flat-rate providers as zero. | Prefer the gateway's cost headers when present. Label the source on each record ("gateway", "estimate"). |
| Quota windows | Oficina learns windows from provider headers; behind a gateway, headers may be different or absent. | Treat the gateway's own limits as a separate account with its own windows. |
| Circuit breakers | Both keep one. | Oficina's breaker trips on gateway failure only. |
| Cache | Oficina has a result cache; the gateway may cache. | Oficina's cache stays first. Do not count a gateway cache hit as a model call without evidence. |
| Cancellation | A stop cannot abort an API call today. | Fix REQ-STP-03 first, or the gateway keeps running and billing after a stop. |

### 3.4 Privacy and security

| Topic | Fact or rule |
|---|---|
| Extra hop | Prompts and code now pass through the gateway before the provider. On the owner's own machine this adds no third party. A hosted gateway would. |
| Keys | Provider keys would live in the gateway, and the gateway key in Oficina's `secrets.json`. Two places to protect. |
| Logging | Not clear whether the gateway stores prompts. **[?]** verify before use. The original spec forbids a third-party router ("no intermediary proxy"). **[V]** `spec/AI-Agent-Office-Spec.md` 8.4. Using one is a change to a recorded decision and needs the owner's approval. |
| Per-repository consent | A repository can be marked as "direct providers only". Oficina refuses the gateway for it. **[P]** |
| Default credential | An article on self-hosting it warns that its dashboard password defaults to a known value unless set. **[?]** verify on the pinned version. |
| Interception mode | Never enable it for Oficina. |

## 4. Requirements and dependencies

| ID | Requirement | Label |
|---|---|---|
| REQ-OMR-01 | The owner decides which Omni Router is meant and what it should do. | **[?]** |
| REQ-OMR-02 | Oficina can use the chosen gateway as a backend with no engine change. | **[P]** |
| REQ-OMR-03 | Use is optional per agent. If the gateway fails or is unreachable, the call falls back to a direct provider, and the event says so. | **[P]** |
| REQ-OMR-04 | Tokens and cost still show per agent and per task, with the source labelled. | **[P]** |
| REQ-OMR-05 | The owner approves, per repository, that prompts pass through it. | **[P]** |
| REQ-OMR-06 | Health: Oficina checks the gateway before use and shows its state on the Providers page. | **[P]** |
| REQ-OMR-07 | The gateway version is pinned and recorded. | **[P]** |

Dependencies:

- Node and npm, or Docker, to run the gateway. **[?]** the required versions were not read from its page; check them.
- A free local port (20128 by default).
- At least one upstream provider connected inside the gateway.
- Fix for cancelling API calls (REQ-STP-03) before heavy use.
- The owner's decision on privacy (Q-03, Q-07).

## 5. Open questions

| # | Question |
|---|---|
| Q-07 | Which Omni Router, and what should it do for you? |
| OQ-1 | Do you already run a gateway? If yes, it is a v0 configuration task. |
| OQ-2 | Should all API calls go through it, or only some agents? |
| OQ-3 | Is a hosted gateway ever acceptable, or only one on this machine? |
| OQ-4 | What should happen when it is down: fall back to direct, wait, or stop? |
| OQ-5 | Who decides the model: Oficina's tiers, or the gateway's `auto`? |
| OQ-6 | Does the owner want CLI agents (Claude Code) routed through it too? |

## 6. What to verify before building

1. That OmniRoute accepts `reasoning_effort` and `max_tokens` and returns `usage` the way the adapter expects.
2. Whether it supports `/v1/messages` for the `anthropic` adapter.
3. Its cost and decision headers, and their exact names, on the pinned version.
4. Whether it stores prompts, and where.
5. The default dashboard credential and how to set a secure one.
6. How its fallback interacts with a call Oficina cancels.
7. A Windows install and start, since Windows is the main platform.

## 7. Sources

- OmniRoute project page: <https://github.com/diegosouzapw/OmniRoute> (read 2026-10-21; the last 40,000 characters of the page were not read).
- Third-party write-ups of OmniRoute: <https://pinggy.io/blog/omniroute_ai_gateway_security/>, <https://railway.com/deploy/omniroute>.
- OmniRouter research paper: <https://arxiv.org/abs/2502.20576>. Code: <https://github.com/dongyuanjushi/OmniRouter>.
- Lemonade Omni Router: <https://lemonade-server.ai/docs/omni-router/> (returned 404 on 2026-10-21; known only from a search result).
