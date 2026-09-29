# Lia: two-minute guided example

The welcome action **Try Lia in 2 minutes** opens a self-contained fictional walkthrough. No account, API key, internet connection, or model request is needed. All replies are pre-written and every screen says **Guided example · fictional · no live AI**.

## Present the loop

1. Start with the fictional tutor-booking project and its current uncertainty.
2. Show the mission, measurable target, and explicit human approval.
3. Choose **Target missed**: only one of three tutors completed the booking unaided.
4. Show the change in advice: pause expansion, clarify confirmation, repeat the same test.
5. Choose **Try the other result**, then **Target met**. The next mission explores rescheduling instead.
6. Choose **Try with my project** to return to the real chat. Any unsent draft is preserved.

This demonstrates a product flow, not a live model response, an actual customer test, verified traction, or earned rewards. The example does not write missions, XP, account data, chat messages, or browser storage.

## Separate live BAND demonstration

The fictional tour above does not demonstrate BAND. For a live sponsor walkthrough, configure two distinct Band agents using [BAND_SETUP.md](BAND_SETUP.md), then sign in with a real Lab project and open the floating BAND button at the lower right.

1. Show one mission in progress, then open the compact BAND menu and select **Challenge the AI**. That action starts one outside review using bounded project and mission context; opening the menu alone makes no model call.
2. Show BAND's small suggestion at the right with its verdict and follow-up questions. Select the main point or a suggested follow-up. Explain that **Put in chat** sends only that chosen point to Lia for a response, while **Ignore** leaves the conversation unchanged. Select **Create** to ask the same two agents to draft and challenge a startup blueprint; inspect the draft preview and choose whether to send the full proposal or a follow-up to Lia. A Create veto leaves the draft explicitly hypothetical.
3. In the Band console, open the new `BUEELD · …` room. Show separate Scout and Critic participants, their `@mention` handoff, the Critic's verdict, and the Scout's answer after it receives that verdict. Show the room's event records.
4. Return to BUEELD and show the challenge verdict in the BAND suggestion. If Critic blocked a decision proposed in the question, show that BAND does not endorse it and names the evidence needed to reconsider. The BUEELD conversation, mission, and score stay under the founder's control.

Optionally show the chat mode: with **BAND joins Lia** off, send a free-chat message to Lia and confirm there is no BAND review. Turn the switch on, send another free-chat message, and show BAND's resulting suggestion in the popover. Show that **Ignore** leaves the chat unchanged, while **Put in chat** asks Lia to consider the selected point only after a click. That Lia answer does not trigger another BAND review. Turn the switch off to stop further BAND reviews.

The real Band identities, room setup, WebSocket mentions, acknowledgments, and a task event passed a local transport smoke test on 29 September. A [live BAND + Crusoe room](https://app.band.ai/sessions/2b68431a-f04e-4236-8cf9-bd9cbf2ed5af) completed the model-driven Scout → Critic → Scout exchange with `approve`. A [separate live room](https://app.band.ai/sessions/ed3a6b7a-1e41-4c82-90e3-4b74c7e50f9d) produced `block` and withheld endorsement, with a rationale that accounted for one founder-reported anonymous response and the absence of a recorded metric. Do not use the offline replay as evidence of Band integration.

The [live Create room](https://app.band.ai/sessions/9933ebf9-8dd5-4251-8336-d1ae3057cd85) completed the Scout → Critic → Scout exchange with `approve` and a full proposal, including a complete first experiment. A separate [browser Challenge room](https://app.band.ai/sessions/4632d6b1-c330-47b2-b406-f19e6bb603c1) showed a Critic veto in the small suggestion, then **Put in chat** sent the selected point to Lia only after approval; Lia answered and the exchange survived a page reload. A live Create suggestion was also ignored without changing the chat. The optional automatic-suggestion mode still needs a live end-to-end check.

## Offline backup

Download **demo-replay.html** from the walkthrough, then open the downloaded file in a browser. The single file includes its own styles and pre-written interactions, with no external fonts, scripts, images, network requests, or storage. Keep it ready before presenting. The offline page can also be printed to show a static recap.

Do not describe the backup as live AI. Its label remains visible throughout. This is an interactive backup rather than a recorded video; a truthful screen recording can be made from it if the event requires video.

## Integrate

- Load `demo-tour.js` before `app.js`, both with `defer`.
- Merge `demo-tour.css` into the application stylesheet (the application CSP does not permit injected styles).
- Supply a welcome button with ID `start-demo` and call `initDemoTour()` once at the end of app initialization. It attaches the click listener itself.
- `startDemoTour()` can also open the walkthrough from another application action.
- Ship `demo-replay.html` next to `index.html` so the download link resolves.
- Run `node --test demo-tour.test.mjs` for branch, non-mutation, focus, and dismissal checks.

## Quick real-user check

After the example, give two or three people this task: “Use your own project to choose a small experiment, understand the target, and explain what you would bring back.” Observe without coaching. Record where they hesitate, whether they understand that the guided example is fictional, and whether they can find the next action without opening a long sidebar. Report actual observations separately from the fictional walkthrough.
