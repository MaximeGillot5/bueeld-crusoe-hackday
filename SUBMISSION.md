# BUEELD — AI Conference Hack Day submission draft

**Status:** Local implementation with a verified Crusoe chat call, BAND transport smoke test, live BAND + Crusoe Scout → Critic → Scout review exchanges, and a live BAND Create exchange on 29 September 2026. Critic returned `approve` in one review room and `block` in another; the blocked answer withheld endorsement of the proposed decision and gave a rationale consistent with one founder-reported anonymous response and no recorded metric. Create returned `approve` with a complete structured proposal. This file is a draft, not evidence of a completed submission or public deployment.

**One-line pitch:** BUEELD turns a founder's next question into a mission with a visible maturity gain, then helps collect real evidence and choose what to do next.

**Sponsor technology:** Crusoe Foundry Serverless Inference via its OpenAI-compatible Chat Completions endpoint. The server-side adapter supports Lia chat and analysis; the new interest-test review interprets a fixed snapshot of actual responses after the founder closes the test. The app calculates counts and maturity points itself. The configured model is `deepseek-ai/Deepseek-V4-Flash`. A real local chat API request returned a response and token usage from that model.

**Additional BAND prize candidate:** A compact BAND menu offers **Challenge the AI** and **Create**. Both use two separately registered Band agents, Scout and Critic, with a dependent `@mention` handoff in a real room. Each prepares a suggestion in a small BAND popover; the founder selects a point and presses **Put in chat** to send it to Lia for a response, or **Ignore** to leave the conversation unchanged. One [live BAND + Crusoe room](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af) completed the review with `approve`; a [separate live room](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d) returned `block` and withheld endorsement. A [live Create room](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85) returned an approved, complete startup blueprint after Critic's Band review. A separate off-by-default **BAND joins Lia** switch can prepare another suggestion after an ordinary Lia reply; it does not insert BAND content automatically. The browser approval and Lia handoff, plus the chat mode, still need their own live end-to-end check. BAND does not change missions, score, or experiment reviews. See [BAND_SETUP.md](BAND_SETUP.md).

## What was built for 29 September

- An independent copy with a separate local Git history and documented [28 September baseline](PROVENANCE.md).
- A lighter BUEELD Project / Journey experience, using a modern Bay Area workspace direction with a matcha accent. The founder sees one next mission and its announced gain.
- A 100-point maturity rubric across customer need, demand, solution, and pilot viability. Each milestone has fixed credit and requires recorded evidence. Revalidating the same milestone does not increase the score.
- One public interest-test workflow: edit a draft, set answer options and a minimum response count and threshold, publish an opaque link, collect answers without login, inspect private aggregates, close the test, request a Crusoe-assisted review, and link the completed test to the learning milestone.
- Crusoe adapter, server-side API key configuration, bounded retries and structured-output validation, global/per-account quota, and new unit tests.
- An optional compact BAND menu with a Challenge outside view and a Create blueprint flow; both use a separate server-side two-agent room. Transport and live model-driven `approve` and `block` Challenge verdicts, plus an approved Create blueprint, are verified locally.

The 28 September prototype already had Lia chat, account-backed context, sources, approved missions, saved progress, and a fictional guided tour. Those features were inherited. The original runtime used AdaL. The tour remains scripted and is **not** a Crusoe demonstration.

## Demo path for a judge

1. Sign in and show the BUEELD project: maturity score, next mission, and exact points available.
2. Open the interest-test mission. Set a question, target audience, minimum qualified responses, and a success threshold, then publish after human review.
3. Open the public link in another browser and submit an answer. Show that collection uses no AI call and that respondent comments stay out of the public page.
4. Return to the owner view, inspect the counts and denominator, close the experiment, and request Lia's review through Crusoe. Show the reported provider/model from the actual response.
5. Validate the linked learning milestone and show the score transition. Repeat validation to show it cannot award points twice. Explain that a failed threshold documents learning but does not certify demand.

For the BAND prize, add a separate on-demand demonstration after this flow: open the floating BAND menu and choose **Challenge the AI** for an outside view of an active mission. Show Scout and Critic in the live Band room, their directed handoff, the Critic's actual verdict, and the small BAND suggestion awaiting founder approval. The completed `approve` and `block` rooms provide real examples; in the latter, BAND withheld endorsement of the decision proposed in the founder's question. Then choose **Create** to show a startup blueprint and the agents' critique. Show the founder selecting one point and deliberately using **Put in chat** to ask Lia about it, or **Ignore** to keep the conversation unchanged. Follow the [live runbook](BAND_SETUP.md#live-room-demonstration).

## Why the Band room matters

- **Crew:** Scout and Critic are separate Band external agents with different IDs, keys, Node processes, WebSocket listeners, and Crusoe model calls. Scout forms a provisional outside view; Critic checks it against the supplied evidence and the founder's proposed decision.
- **Routing:** The room starts with a directed `@Scout` request. Scout `@mentions` Critic with its actual assessment; Critic's reply `@mentions` Scout with a verdict. Scout sends the founder-facing answer only after receiving that reply through Band.
- **Founder-visible result:** The same room contains the messages and task/thought/result events. Challenge presents the verdict and follow-up questions in a small BAND suggestion; Create presents a structured, explicitly tentative startup proposal. The founder selects what Lia should consider and authorizes a single chat exchange.
- **Delete test:** Without Band's room, participant identities, and mention delivery, Critic cannot receive Scout's assessment and Scout cannot receive the verdict that gates its final answer.

Use a clearly labelled demo response if no genuine participants have answered. Do not describe demo data as real customer research.

## Evidence to fill in before submission

| Item | Verified result |
| --- | --- |
| GitHub repository | [Private BUEELD Hack Day repository](https://github.com/MaximeGillot5/bueeld-crusoe-hackday), first edition commit `a3a8feb` pushed on 29 September |
| Judges' repository access | Pending |
| Independent live application URL | Pending |
| Actual Crusoe request and returned model | Verified locally on 29 September: chat API returned `source: crusoe`, model `deepseek-ai/Deepseek-V4-Flash`, and 1,420 total tokens on an isolated test project |
| BAND Scout and Critic identities | Verified with two distinct real API keys and UUIDs under one owner on 29 September |
| BAND room and transport | Verified locally: room `5523ea65-88e7-49b2-8ccd-5e34d0662668`, human owner added, two WebSockets, directed messages received both ways, processing acknowledgments, and visible task event |
| BAND model exchange and Critic verdict | Verified locally in [room `2b68431a-f04e-4236-8cf9-bd9cbf2ed5af`](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af): Scout → Critic → Scout, `approve`, advice with three suggestions and three questions |
| BAND `block` veto and revised Scout answer | Verified locally in [room `ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d`](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d): real Scout → Critic → Scout handoff, `block`, and final answer without endorsement; Critic accounted for one founder-reported anonymous response and the absence of a recorded metric |
| BAND Create blueprint | Verified locally in [room `9933ebf9-8dd5-4251-8336-d1ae3057cd85`](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85): Scout → Critic → Scout, `approve`, and a complete structured proposal with a complete first experiment |
| BAND browser approval and Lia handoff | Live end-to-end check pending |
| End-to-end external-browser experiment | Pending |
| Persistence after restart or deployment | Pending |
| Demo video or pitch recording | Pending |
| Submission link, deadline, and submitted state | Pending |

The event rules and award eligibility are determined by the organizers. Confirm that extending an existing product is eligible, that the chosen Crusoe endpoint meets the sponsor requirement, and how judges access a private repository. The submitted description should reflect only the verified state above.

## Limits to disclose

The rubric defines readiness for a first pilot, not guaranteed company success. The integrated form measures stated interest, not sales or unique people. One Lab account maps to one project in this edition. Other milestones accept documented evidence but have no dedicated collection tools. The Decision canvas and OAuth connectors were inherited and are outside this demonstration; public Google/Notion OAuth has not been configured or tested. File-backed state runs on a single Node process and requires persistent storage. When Crusoe explicitly reports exhausted credits, local AI requests switch to the signed-in AdaL CLI. Other Crusoe outages still require a retry; saved responses and aggregates remain.
