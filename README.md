# BUEELD — Crusoe Hack Day edition

A founder workspace for turning a project into a clear next mission. Completing a documented mission can advance the project's **maturity toward a first pilot**. The September 29 edition adds one shareable interest test: publish a question, collect actual responses, close the test, and ask Lia to review the result through [Crusoe Foundry Serverless Inference](https://docs.cloud.crusoe.ai/serverless-inference/index.html).

This is an independent copy of the September 28 BUEELD Lab prototype. See [provenance](PROVENANCE.md) for the inherited foundation and today's changes. The source code and simulated-provider tests are local; **a real Crusoe request and a public deployment are not yet verified**. The guided example is fictional and makes no AI call.

## What this edition does

- A simpler Project / Journey interface places the current maturity score and the next mission first. The visual direction uses a light Bay Area workspace palette with a matcha accent.
- A fixed, versioned 100-point rubric covers customer need, demand, solution, and pilot viability (25 points each). Each of its 12 milestones has a published weight. The server derives the score from credited milestones, and duplicate validation does not add points.
- A signed-in founder can document evidence for milestones. The integrated public form serves the **interest-test** mission only. An unsuccessful interest test may document learning; it does not credit a separate engagement milestone.
- For that test, the founder sets the hypothesis, audience, answer options, minimum qualified responses, and success threshold before publishing. Visitors answer without an account. The founder sees private aggregates, closes the test, and can then request Lia's review. No AI call is made when a visitor responds.
- Lia's chat, source analysis, mission learning, decision planning, and final experiment review use a server-side Crusoe adapter. The default model is `deepseek-ai/DeepSeek-V4-Flash`; set `CRUSOE_MODEL` to a supported model if needed. The response metadata identifies Crusoe and the model.

One Lab account corresponds to one project in this edition. The older chat, optional Decision canvas, OAuth connection code, and fictional tour are inherited. Google/Notion OAuth for public visitors has not been configured or verified here; manual import and public GitHub README analysis remain available. The Decision canvas stores its plans in process memory and is outside the main Journey flow.

## Run locally

Requires Node.js 22. No npm runtime dependencies or AdaL CLI are needed.

1. Copy `.env.example` to `.env` and put a **Crusoe Intelligence API key** in `CRUSOE_API_KEY`. Keep `.env` private. Node loads it locally through the start script. Without a key, the pages and stored project data can run, but live Lia requests return a configuration error.
2. Run `npm start` in this directory.
3. Open `http://127.0.0.1:4173`. `GET /health` returns a basic availability check.
4. Create a Lab account, save the project name, target, and goal, then open **Project**. The **Journey** view lists the milestones and evidence conditions.
5. Open the interest-test mission, create a draft, review its questions and threshold, then publish. Share its `/e/<publicId>` link with a different browser. Close the test before requesting Lia's final review. Link that completed test as evidence when validating the interest-test milestone.

For a local shell with an already exported key, `CRUSOE_API_KEY=… npm start` also works. Do not put a real key into chat, source files, a commit, or client-side JavaScript.

The default data directory is `.data/`, which is ignored by Git. `LAB_DATA_DIR` moves accounts, sessions, quota, maturity, and experiment JSON files together. Use a private writable directory. `HOST` defaults to localhost and `PORT` defaults to 4173.

## Verification

`npm test` runs the new unit suite with a simulated Crusoe response. `npm run test:integration` runs the local account/project/experiment API flow once that integration script is present; it needs permission to bind a loopback port and uses an isolated data directory. These checks do **not** prove that a Crusoe account has a usable key or that a Render deployment works. The inherited AdaL-era chat/API tests target older guest and CLI behavior and are not the release gate for this edition.

For an actual end-to-end smoke test, make one bounded real Lia request with the intended model, record the returned provider/model and usage, publish an experiment, answer from another browser, close it, review it, validate the milestone once, and restart the server to confirm persistence. Repeating the same milestone validation must keep the score unchanged.

## Data, access, and limits

Accounts, conversations, sessions, quota, maturity records, and experiments are separate JSON files under `LAB_DATA_DIR`. Account sign-in and a CSRF token are required for project and AI actions. The public form exposes only the founder-approved title, audience, question, and answer options. Results and respondent comments are owner-only. Published questions are fixed; closing freezes the response set used by the final review.

The public form collects a qualification answer, one selected response, and an optional short comment. Results describe a self-selected sample. A submission ID prevents accidental retry duplicates, but it does **not** establish unique people or verified customer commitment. A negative or undersized result must not be presented as demand validation.

Each outbound Crusoe attempt uses the global and per-account quota. Defaults are `MAX_AI_CALLS=100` and `MAX_AI_CALLS_PER_USER=20`; each 429/503 retry and structured-output repair spends another attempt. The server allows one active AI analysis at a time. The adapter times out, limits retries, rejects incomplete output, and has no AdaL fallback. The Crusoe key stays on the server. Public response submission does not spend AI quota.

The current JSON storage and in-process AI guard require **one Node process / one service instance**. A backup must capture all state files consistently while writes are paused. Scaling or transactional migrations need a shared database later. Deleting a Lab account removes its linked maturity and experiment records from the active store.

## Proposed Render deployment

[render.yaml](render.yaml) defines a single Node web service, a 1 GB persistent disk mounted at `/var/data`, and `LAB_DATA_DIR=/var/data/lab`. It uses the paid `0.5c-512mb` compute plan, because a persistent disk is required for this file-backed app. Review Render's current cost and the Blueprint changes before applying it. The Blueprint has automatic deploys off. Set the secret `CRUSOE_API_KEY` in Render, then set `LAB_PUBLIC_ORIGIN` to the actual HTTPS service origin if the inferred origin is not correct. The app listens on `0.0.0.0` and Render's `PORT`.

After deployment, verify the health endpoint, signup and cookies, private results, public response form, a real Crusoe answer, a restart, and a coordinated backup/restore into a separate test directory. A Render URL, GitHub URL, video, and judges' access are intentionally absent until created and checked.

## Historical references

The [September 28 README](docs/baseline-2026-09-28/README.md) and [submission draft](docs/baseline-2026-09-28/SUBMISSION.md) explain yesterday's prototype. Their AdaL, tunnel, and prize-track descriptions are historical. [SUBMISSION.md](SUBMISSION.md) is the current, still-unsubmitted draft.
