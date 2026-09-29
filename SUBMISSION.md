# BUEELD — AI Conference Hack Day submission draft

**Status:** Local implementation in progress on 29 September 2026. This file is a draft, not evidence of a completed submission, public deployment, or live Crusoe call.

**One-line pitch:** BUEELD turns a founder's next question into a mission with a visible maturity gain, then helps collect real evidence and choose what to do next.

**Sponsor technology:** Crusoe Foundry Serverless Inference via its OpenAI-compatible Chat Completions endpoint. The server-side adapter supports Lia chat and analysis; the new interest-test review interprets a fixed snapshot of actual responses after the founder closes the test. The app calculates counts and maturity points itself. Model configured initially: `deepseek-ai/DeepSeek-V4-Flash`. Confirm the model and key with a real request before making a live-use claim.

## What was built for 29 September

- An independent copy with a separate local Git history and documented [28 September baseline](PROVENANCE.md).
- A lighter BUEELD Project / Journey experience, using a modern Bay Area workspace direction with a matcha accent. The founder sees one next mission and its announced gain.
- A 100-point maturity rubric across customer need, demand, solution, and pilot viability. Each milestone has fixed credit and requires recorded evidence. Revalidating the same milestone does not increase the score.
- One public interest-test workflow: edit a draft, set answer options and a minimum response count and threshold, publish an opaque link, collect answers without login, inspect private aggregates, close the test, request a Crusoe-assisted review, and link the completed test to the learning milestone.
- Crusoe adapter, server-side API key configuration, bounded retries and structured-output validation, global/per-account quota, and new unit tests.

The 28 September prototype already had Lia chat, account-backed context, sources, approved missions, saved progress, and a fictional guided tour. Those features were inherited. The original runtime used AdaL. The tour remains scripted and is **not** a Crusoe demonstration.

## Demo path for a judge

1. Sign in and show the BUEELD project: maturity score, next mission, and exact points available.
2. Open the interest-test mission. Set a question, target audience, minimum qualified responses, and a success threshold, then publish after human review.
3. Open the public link in another browser and submit an answer. Show that collection uses no AI call and that respondent comments stay out of the public page.
4. Return to the owner view, inspect the counts and denominator, close the experiment, and request Lia's review through Crusoe. Show the reported provider/model from the actual response.
5. Validate the linked learning milestone and show the score transition. Repeat validation to show it cannot award points twice. Explain that a failed threshold documents learning but does not certify demand.

Use a clearly labelled demo response if no genuine participants have answered. Do not describe demo data as real customer research.

## Evidence to fill in before submission

| Item | Verified result |
| --- | --- |
| GitHub repository and judges' access | Pending |
| Independent live application URL | Pending |
| Actual Crusoe request and returned model | Pending |
| End-to-end external-browser experiment | Pending |
| Persistence after restart or deployment | Pending |
| Demo video or pitch recording | Pending |
| Submission link, deadline, and submitted state | Pending |

The event rules and award eligibility are determined by the organizers. Confirm that extending an existing product is eligible, that the chosen Crusoe endpoint meets the sponsor requirement, and how judges access a private repository. The submitted description should reflect only the verified state above.

## Limits to disclose

The rubric defines readiness for a first pilot, not guaranteed company success. The integrated form measures stated interest, not sales or unique people. One Lab account maps to one project in this edition. Other milestones accept documented evidence but have no dedicated collection tools. The Decision canvas and OAuth connectors were inherited and are outside this demonstration; public Google/Notion OAuth has not been configured or tested. File-backed state runs on a single Node process and requires persistent storage. If Crusoe is unavailable, saved responses and aggregates remain; the AI review can be retried later.
