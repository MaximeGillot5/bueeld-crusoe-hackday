# BUEELD — Crusoe Hack Day edition

A founder workspace for turning a project into a clear next mission. Completing a documented mission can advance the project's **maturity toward a first pilot**. The September 29 edition adds one shareable interest test: publish a question, collect actual responses, close the test, and ask Lia to review the result through [Crusoe Foundry Serverless Inference](https://docs.cloud.crusoe.ai/serverless-inference/index.html).

This is an independent copy of the September 28 BUEELD Lab prototype. See [provenance](PROVENANCE.md) for the inherited foundation and today's changes. The [29 September repository](https://github.com/MaximeGillot5/bueeld-crusoe-hackday) is private. **A real local Crusoe request has been verified. A public deployment is not yet verified.** The guided example is fictional and makes no AI call.

## What this edition does

- A simpler Project / Journey interface places the current maturity score and the next mission first. The visual direction uses a light Bay Area workspace palette with a matcha accent.
- A fixed, versioned 100-point rubric covers customer need, demand, solution, and pilot viability (25 points each). Each of its 12 milestones has a published weight. The server derives the score from credited milestones, and duplicate validation does not add points.
- A signed-in founder can document evidence for milestones. The integrated public form serves the **interest-test** mission only. An unsuccessful interest test may document learning; it does not credit a separate engagement milestone.
- For that test, the founder sets the hypothesis, audience, answer options, minimum qualified responses, and success threshold before publishing. Visitors answer without an account. The founder sees private aggregates, closes the test, and can then request Lia's review. No AI call is made when a visitor responds.
- Lia's chat, source analysis, mission learning, decision planning, and final experiment review use a server-side Crusoe adapter. The default model is `deepseek-ai/Deepseek-V4-Flash`; set `CRUSOE_MODEL` to a supported model if needed. If Crusoe explicitly reports exhausted credits or required billing, those same requests fall back to the local AdaL CLI connected to the founder's ChatGPT account. Response metadata identifies the provider actually used.
- A floating BAND button opens a compact menu with **Challenge the AI** and **Create**. Challenge returns an outside view; Create drafts a startup blueprint. Each action uses two separate Band agents in a real room, and puts its result in a small suggestion beside the button. The founder selects a point and presses **Put in chat** to send it to Lia for a response, or **Ignore** to leave the conversation unchanged. The agents exchange `@mentions`. The **BAND joins Lia** switch is off by default and can prepare another suggestion after an ordinary Lia reply, subject to the same explicit choice. [Setup and live verification](BAND_SETUP.md).

One Lab account corresponds to one project in this edition. The older chat, optional Decision canvas, OAuth connection code, and fictional tour are inherited. Google/Notion OAuth for public visitors has not been configured or verified here; manual import and public GitHub README analysis remain available. The Decision canvas stores its plans in process memory and is outside the main Journey flow.

## Run locally

Requires Node.js 22. There are no npm runtime dependencies. The AdaL CLI is optional for normal Crusoe use but required for the credit-exhaustion fallback.

1. Copy `.env.example` to `.env` and put a **Crusoe Intelligence API key** in `CRUSOE_API_KEY`. Keep `.env` private. The server loads it for both `npm start` and direct `node server.mjs` launches. Without a key, the pages and stored project data can run, but live Lia requests return a configuration error by default. For a local-only preview with AdaL instead, set `ADAL_IF_CRUSOE_UNCONFIGURED=1` and keep `HOST=127.0.0.1` or `localhost`.
2. For the fallback, install and sign in to the AdaL CLI with the connected ChatGPT account used by the September 28 prototype. Set `ADAL_BIN` only if the executable is not on `PATH`; `ADAL_MODEL` optionally selects a connected model.
3. Run `npm start` in this directory.
4. Open `http://127.0.0.1:4173`. `GET /health` returns a basic availability check.
5. Create a Lab account, save the project name, target, and goal, then open **Project**. The **Journey** view lists the milestones and evidence conditions.
6. Open the interest-test mission, create a draft, review its questions and threshold, then publish. Share its `/e/<publicId>` link with a different browser. Close the test before requesting Lia's final review. Link that completed test as evidence when validating the interest-test milestone.

For the optional BAND menu, register two distinct Band External/Remote agents and set their IDs and keys in `.env` as described in [BAND_SETUP.md](BAND_SETUP.md). The four `BAND_*` settings are server secrets.

For a local shell with an already exported key, `CRUSOE_API_KEY=… npm start` also works. Do not put a real key into chat, source files, a commit, or client-side JavaScript.

The default data directory is `.data/`, which is ignored by Git. `LAB_DATA_DIR` moves accounts, sessions, quota, maturity, and experiment JSON files together. Use a private writable directory. `HOST` defaults to localhost and `PORT` defaults to 4173.

## Verification

`npm test` runs the unit and frontend state suites with simulated Crusoe responses and a fake AdaL executable. `npm run test:integration` runs the local account/project/experiment API flow; it needs permission to bind a loopback port and uses an isolated data directory. The simulated suites alone do **not** prove that a Crusoe account has a usable key, the AdaL login works, or that a Render deployment works. On 29 September, a real local chat API request returned `source: crusoe`, model `deepseek-ai/Deepseek-V4-Flash`, and token usage; a separate real AdaL CLI request also succeeded. `npm run test:fallback` verifies the credit-exhaustion relay with simulated provider responses. The inherited AdaL-era chat/API tests target older guest and CLI behavior and are not the release gate for this edition.

The BAND client and review tests simulate API and WebSocket responses. A live transport smoke test on 29 September verified two real agent identities, a room with the human owner, mentions received in both directions over separate sockets, processing acknowledgments, and a task event. A [live BAND + Crusoe room](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af) completed the Scout → Critic → Scout exchange with `approve`; a [separate live room](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d) produced `block` and withheld endorsement of the proposed decision. Critic accounted for a founder-reported anonymous response while pointing out that no metric was recorded. A [live Create room](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85) produced an approved, complete structured proposal. The browser approval and Lia handoff still need a live end-to-end check; see [BAND_SETUP.md](BAND_SETUP.md).

For an actual end-to-end smoke test, make one bounded real Lia request with the intended model, record the returned provider/model and usage, publish an experiment, answer from another browser, close it, review it, validate the milestone once, and restart the server to confirm persistence. Repeating the same milestone validation must keep the score unchanged.

## Data, access, and limits

Accounts, conversations, sessions, quota, maturity records, and experiments are separate JSON files under `LAB_DATA_DIR`. Account sign-in and a CSRF token are required for project and AI actions. The public form exposes only the founder-approved title, audience, question, and answer options. Results and respondent comments are owner-only. Published questions are fixed; closing freezes the response set used by the final review.

The public form collects a qualification answer, one selected response, and an optional short comment. Results describe a self-selected sample. A submission ID prevents accidental retry duplicates, but it does **not** establish unique people or verified customer commitment. A negative or undersized result must not be presented as demand validation.

Each outbound Crusoe or AdaL attempt uses the global and per-account quota. Defaults are `MAX_AI_CALLS=100` and `MAX_AI_CALLS_PER_USER=20`; a Crusoe credit failure followed by an AdaL call consumes two local attempts. Each 429/503 retry and structured-output repair also spends another attempt. The Lia analysis routes allow one active request at a time. The adapters time out and reject incomplete output. A 402 or an explicit credit/billing error opens the AdaL fallback for five minutes, then Crusoe is tried again. A missing key opens AdaL only with the explicit local-only flag above. A generic 429 rate limit, a 503 overload, or a bad key does not trigger the fallback. The Crusoe key stays on the server. Public response submission does not spend AI quota.

Each BAND model attempt spends this same quota. Choosing **Challenge the AI** or **Create** starts a room; an enabled BAND chat reply starts another one. Opening the compact menu alone does not start a model call. The server accepts one active BAND exchange at a time because each Band agent identity supports one active WebSocket connection.

The current JSON storage and in-process AI guard require **one Node process / one service instance**. A backup must capture all state files consistently while writes are paused. Scaling or transactional migrations need a shared database later. Deleting a Lab account removes its linked maturity and experiment records from the active store.

## Proposed Render deployment

[render.yaml](render.yaml) defines a single Node web service, a 1 GB persistent disk mounted at `/var/data`, and `LAB_DATA_DIR=/var/data/lab`. It uses the paid `0.5c-512mb` compute plan, because a persistent disk is required for this file-backed app. Review Render's current cost and the Blueprint changes before applying it. The Blueprint has automatic deploys off. Set the secret `CRUSOE_API_KEY` in Render, then set `LAB_PUBLIC_ORIGIN` to the actual HTTPS service origin if the inferred origin is not correct. The app listens on `0.0.0.0` and Render's `PORT`. This Blueprint does not install or sign in to AdaL, so the fallback is available only on hosts where AdaL is separately provisioned.

To enable the optional BAND menu on that service, also set `BAND_SCOUT_AGENT_ID`, `BAND_SCOUT_API_KEY`, `BAND_CRITIC_AGENT_ID`, and `BAND_CRITIC_API_KEY` as secrets. Their presence in the service does not replace the live Band room verification in [BAND_SETUP.md](BAND_SETUP.md).

After deployment, verify the health endpoint, signup and cookies, private results, public response form, a real Crusoe answer, a restart, and a coordinated backup/restore into a separate test directory. A Render URL, video, and judges' access are intentionally absent until created and checked.

## Historical references

The [September 28 README](docs/baseline-2026-09-28/README.md) and [submission draft](docs/baseline-2026-09-28/SUBMISSION.md) explain yesterday's prototype. Their AdaL, tunnel, and prize-track descriptions are historical. [SUBMISSION.md](SUBMISSION.md) is the current, still-unsubmitted draft.
