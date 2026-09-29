# BAND outside view and startup blueprint

**Verification status (29 September 2026):** A live transport smoke test verified two distinct agent profiles under one human owner, room creation and rename, adding Critic and the human owner, two separate WebSocket subscriptions, `@mentions` delivered in both directions, message `processing` → `processed`, and a visible `task` event. A live BAND + Crusoe room completed the Scout → Critic → Scout exchange with an [`approve` verdict](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af). A separate [live room produced `block`](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d): Critic recognized the founder-reported anonymous interest response, identified the absence of a recorded metric, and the final answer withheld endorsement of the proposed decision. A [live Create room](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85) completed the two-agent exchange with `approve` and a full structured proposal whose first experiment was complete. The browser's **Put in chat** handoff and optional automatic-suggestion mode still need a live end-to-end check.

The floating BAND button opens a compact menu with **Challenge the AI** and **Create**, with no BAND text field. Challenge the AI asks Scout and Critic for an outside view of the current project and mission; Create asks them to draft and challenge a startup blueprint. Each action starts the Band exchange immediately and opens a small popover beside the button with the result, up to three copyable choices, and a room link. The founder selects one choice, then presses **Put in chat** to insert its BAND card and send one message to Lia for a response, or **Ignore** to leave the conversation unchanged. The **BAND joins Lia** switch is off by default; turning it on opts in to preparing a BAND suggestion after an ordinary Lia reply, again subject to the founder's choice. BAND does not edit missions, evidence, score, or experiment review.

## What to provision

1. Create a [Band account](https://app.band.ai) and register two separate **External/Remote** agents under the same human owner. Suggested names: **BUEELD Scout** and **BUEELD Critic**. Each must have its own agent UUID and API key; Band shows a newly created key once. A single agent switching roles does not demonstrate the required collaboration.
2. Keep a usable `CRUSOE_API_KEY` for the agents' model calls. The existing AdaL credit-exhaustion fallback can be used where separately configured. Band coordinates the agents; it does not supply this application's model key.
3. Use Node.js 22 and one BUEELD server instance. Band allows only one active WebSocket connection per agent identity, so running multiple copies with the same keys can interrupt an active review.

Put these values in the server's private `.env` file (or the host's secret environment variables). The example names are placeholders; never put real keys in browser code or a commit:

```dotenv
CRUSOE_API_KEY=your-crusoe-key
BAND_SCOUT_AGENT_ID=scout-agent-uuid
BAND_SCOUT_API_KEY=scout-agent-key
BAND_CRITIC_AGENT_ID=critic-agent-uuid
BAND_CRITIC_API_KEY=critic-agent-key
```

The two IDs and two keys must differ, and both Band agents must have the same owner. The server validates their identities with `GET /api/v1/agent/me` before opening a room. It creates the room as Scout, adds Critic and the human owner as participants, and gives the room a mission or startup-concept title. No Band human API key is required. The [Agent API](https://docs.band.ai/api/agent-api) uses server-side `X-API-Key` authentication.

## Start and check availability

Run `npm start`, sign in to a Lab account, and open the floating **BAND** button at the lower right of the main application. This opens the compact menu; the model exchange starts when the founder chooses **Challenge the AI** or **Create**. `GET /api/band/status` reports only whether the four Band environment values have a valid local shape (`{"configured":true}`); it does **not** prove the keys work or the agents can connect.

**Challenge the AI** calls the authenticated, CSRF-protected `POST /api/band/advice` endpoint with a question derived from the current project context. **Create** calls the similarly protected `POST /api/band/create` endpoint with optional mission and context, but no typed question. The server rebuilds the mission from the signed-in project rather than trusting a client-supplied mission description. A request is limited to one active BAND exchange at a time. A Band or model error is shown as an error; no fabricated outside advice or blueprint is returned.

Create returns a room link and a structured draft with a name, target customer, problem, solution, first experiment, risks, and assumptions. Scout proposes it; Critic reviews it over a Band `@mention`; Scout receives the verdict and revises the draft when Critic requests changes. If Critic returns `block`, the server suppresses endorsement and marks the blueprint as an unvalidated hypothesis with Critic's reason. The Create route passed deterministic tests and a [live Band room](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85) with `approve` and a complete first experiment.

## Optional BAND suggestions after Lia's replies

The **BAND joins Lia** switch sits in the compact menu. It starts off and is remembered locally for each Lab account. When enabled, each new ordinary Lia reply in free chat prompts one separate BAND exchange through the authenticated, CSRF-protected `POST /api/band/chat-reply` route. This route accepts a question of up to 500 characters, Lia's reply of up to 2,000 characters, and up to 4 KB of bounded context. The resulting outside view stays in the small BAND popover. The founder chooses one point to send to Lia with **Put in chat**, or **Ignore** to leave the conversation unchanged. The switch itself never inserts BAND text into the Lia conversation, and the Lia reply to an accepted BAND point does not trigger another BAND review.

For a demo, first leave the switch off and send a free-chat message to Lia; that chat turn should open no additional BAND room. Turn the switch on, send a new free-chat message, and inspect the BAND suggestion in the popover. Show that **Ignore** leaves the conversation unchanged, then use **Put in chat** only for a suggestion the founder wants to share. Switch the mode off again to stop subsequent BAND calls. This mode also requires the two live agent keys and should be verified with real Band credentials before presenting it as working end to end.

For a hosted demo, add all four `BAND_*` values as service secrets alongside `CRUSOE_API_KEY`. The current `render.yaml` does not provide those secrets. Validate the hosted service with real credentials after deployment; a local simulation does not prove hosted WebSocket access.

## Live room demonstration

Use a signed-in project with a mission whose evidence is still incomplete. BAND will use the current project, mission, and recent conversation as context.

1. Open the compact BAND menu and select **Challenge the AI**. The exchange starts on that click; its verdict waits in a small BAND popover at the right. Select the main challenge or a suggested follow-up. **Put in chat** sends that selected point to Lia and requests one answer; **Ignore** leaves the chat untouched.
2. Select **Create** for a separate startup-blueprint exchange. Inspect the draft preview in the popover, select the full proposal or a suggested follow-up, and decide explicitly whether to send it to Lia.
3. Use the room link in the BAND suggestion, or find the new `BUEELD · …` room in the [Band console](https://app.band.ai). The `https://app.band.ai/sessions/{roomId}` link was checked in the transport smoke test. Check that the participant list contains **Scout**, **Critic**, and the human owner as three distinct identities.
4. Follow the room's actual messages. A Band `@mention` wakes Scout; Scout posts an evidence-aware provisional assessment and `@mentions` Critic; Critic challenges that assessment and `@mentions` Scout with `approve`, `revise`, or `block`; Scout uses that verdict before sending the founder-facing answer. The flow also posts task, thought, and tool-result events, plus an error event if it fails. Enable **Tasks** in the Band room filter to see task events. The messages, not a pasted transcript, should show the dependent handoff.
5. Inspect BAND's advice and verdict in the popover. For a **block** in Challenge the AI, verify that Critic explicitly rejects the unsupported decision it identified, even if Scout already cautioned against it. The final outside view must explain what evidence would change that verdict. For a Create block, verify that the blueprint stays a hypothetical draft. These vetoes affect BAND's endorsement; they do not prevent the founder from acting or silently rewrite Lia's advice.
6. Compare the Lia conversation, mission, and score before and after the BAND request. The chat stays unchanged until the founder chooses **Put in chat**. That click inserts the selected BAND card and sends one **BAND → Lia** message; Lia's reply does not trigger BAND again. The mission and score stay unchanged either way. If a guided mission is active, the CTA reads **Pause mission & put in chat** and saves its progress before moving to free chat.

For judges, capture the Band room with visible identities, `@mentions`, Critic's actual response, Scout's final conclusion, and event records. The transport smoke room was `5523ea65-88e7-49b2-8ccd-5e34d0662668`; the first complete model run is [room `2b68431a-f04e-4236-8cf9-bd9cbf2ed5af`](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af). The verified veto is [room `ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d`](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d), and the verified Create exchange is [room `9933ebf9-8dd5-4251-8336-d1ae3057cd85`](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85). The guide's [meaningful-use criteria](https://www.band.ai/hacker-guide) reject a single agent wearing multiple roles or an application that merely copies its own orchestration log into a room.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Menu says BAND is unavailable | Confirm all four `BAND_*` variables are set on the running server, then restart. `/api/band/status` checks shape only. |
| A BAND action starts another room | Each click on **Challenge the AI** or **Create** requests a fresh room and spends AI quota. Wait for the previous exchange to finish before starting another. |
| Credential or permission error | Confirm each API key belongs to the configured UUID, both agents are External/Remote agents under the same owner, and the keys have not been rotated. |
| Room opens but no agent answers | Confirm Scout and Critic are participants; inspect `@mentions` in the Band room. Band routes only text messages that explicitly mention the target agent. |
| Connection or response timeout | Confirm outbound HTTPS and WebSocket access to `app.band.ai`, and that no second server instance is using the same agent identities. Retry a single review after connectivity recovers. |
| Critic does not block an under-evidenced proposal | Check the actual question sent by Challenge, the mission evidence, and Scout/Critic messages in the room. Verdicts are model-produced; report what occurred rather than asserting a scripted veto. |
| BAND completed but nothing appeared in Lia chat | Open the small BAND suggestion beside the floating button, choose which point Lia should consider, then press **Put in chat**. **Ignore** leaves the conversation unchanged. |

The implementation uses Band's [REST Agent API](https://docs.band.ai/api/agent-api) for rooms, participants, messages, and events, and its [Phoenix WebSocket](https://docs.band.ai/websocket/overview) for mention-scoped delivery. The current flow starts fresh, short-lived listeners for each room; an interrupted review must be retried. Band documents `GET /messages/next` for crash recovery, and this implementation does not continuously poll. Agent clients never receive `event_created`; the human participant can inspect the complete event log in the Band console.
