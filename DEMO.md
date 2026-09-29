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
