/* A deterministic walkthrough. It never invokes AI or changes project data. */
(() => {
  "use strict";

  const LABEL = "Guided example · fictional · no live AI";
  const STEP_NAMES = ["Context", "Mission", "Result", "Learning"];
  let overlay;
  let dialog;
  let content;
  let navigation;
  let progress;
  let step = 0;
  let outcome = null;
  let returnFocus = null;
  let inertElements = [];

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(label, action, primary = false) {
    const element = node("button", primary ? "tour-button tour-button-primary" : "tour-button", label);
    element.type = "button";
    element.addEventListener("click", action);
    return element;
  }

  function message(author, text, isFounder = false) {
    const element = node("div", `tour-message${isFounder ? " tour-message-founder" : ""}`);
    element.append(node("p", "tour-author", author), node("p", "tour-message-text", text));
    return element;
  }

  function detail(label, text) {
    const element = node("div", "tour-detail");
    element.append(node("dt", "", label), node("dd", "", text));
    return element;
  }

  function closeDemoTour(focusComposer = false) {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    inertElements.forEach(([element, wasInert]) => { element.inert = wasInert; });
    inertElements = [];
    const composer = focusComposer ? document.getElementById("chat-input") : null;
    const target = composer || returnFocus;
    if (target && target.isConnected && typeof target.focus === "function") target.focus();
  }

  function renderStep() {
    content.replaceChildren();
    navigation.replaceChildren();
    progress.replaceChildren();
    STEP_NAMES.forEach((name, index) => {
      const item = node("li", `tour-progress-item${index === step ? " is-current" : ""}${index < step ? " is-complete" : ""}`);
      if (index === step) item.setAttribute("aria-current", "step");
      item.append(node("span", "tour-step-number", String(index + 1)), node("span", "", name));
      progress.append(item);
    });

    const headings = ["A real question to start from.", "One small test. Your call.", "Bring back what happened.", "The evidence changes the next move."];
    const heading = node("h3", "tour-step-title", headings[step]);
    heading.id = "tour-step-title";
    heading.tabIndex = -1;
    content.append(node("p", "tour-step-kicker", `STEP ${step + 1} OF 4`), heading);

    if (step === 0) {
      content.append(
        message("Founder · fictional", "I’m building a booking tool for independent tutors. Before I build more, I need to know if tutors can create their first booking without help.", true),
        message("Lia · scripted example", "Let’s test that specific assumption. Your next decision is whether to improve onboarding or move on to the booking workflow."),
        node("p", "tour-note", "This walkthrough uses a made-up project. Every reply is pre-written; nothing is sent or saved.")
      );
      navigation.append(button("See the proposed mission", () => { step = 1; renderStep(); }, true));
    }

    if (step === 1) {
      const mission = node("section", "tour-mission");
      mission.setAttribute("aria-label", "Example proposed mission");
      mission.append(node("p", "tour-card-kicker", "PROPOSED MISSION"), node("h4", "", "Test the first booking with 3 tutors"));
      const details = node("dl", "tour-details");
      details.append(
        detail("Assumption", "Tutors can create a first booking without guidance."),
        detail("Test", "Ask 3 tutors to book a first session on the prototype. Observe without coaching."),
        detail("Success target", "At least 2 of 3 finish without help within 2 minutes."),
        detail("Bring back", "Completion count, time taken, and where anyone gets stuck.")
      );
      mission.append(details);
      content.append(message("Lia · scripted example", "Here’s a small experiment. You decide whether to take it on."), mission, node("p", "tour-note", "Approving here only advances this example. It creates no real mission."));
      navigation.append(button("Back", () => { step = 0; renderStep(); }), button("Approve example mission", () => { step = 2; renderStep(); }, true));
    }

    if (step === 2) {
      content.append(message("Lia · scripted example", "A test is useful even when the target is missed. Choose a fictional result to see how it changes the next decision."));
      const choices = node("div", "tour-outcomes");
      const met = button("", () => { outcome = "met"; step = 3; renderStep(); });
      met.className = "tour-outcome";
      met.append(node("span", "tour-outcome-state", "TARGET MET"), node("strong", "", "3 of 3 finish without help"), node("span", "", "All finish in under 2 minutes. Two ask how to handle a reschedule."), node("span", "tour-outcome-action", "Explore this result →"));
      const missed = button("", () => { outcome = "missed"; step = 3; renderStep(); });
      missed.className = "tour-outcome";
      missed.append(node("span", "tour-outcome-state", "TARGET MISSED"), node("strong", "", "1 of 3 finishes without help"), node("span", "", "Two get stuck on “Confirm slot” and ask whether the booking is final."), node("span", "tour-outcome-action", "Explore this result →"));
      choices.append(met, missed);
      content.append(choices, node("p", "tour-note", "These are fictional observations, not customer research or measured results."));
      navigation.append(button("Back", () => { step = 1; renderStep(); }));
    }

    if (step === 3) {
      const missed = outcome === "missed";
      const learning = node("section", "tour-learning");
      learning.append(node("p", "tour-card-kicker", missed ? "TARGET MISSED · A USEFUL CHANGE OF DIRECTION" : "TARGET MET · A NEXT QUESTION TO TEST"));
      const details = node("dl", "tour-details");
      details.append(
        detail("Before", "We expected tutors to create a first booking without guidance."),
        detail("Observed", missed ? "Only 1 of 3 finished independently. Two hesitated at “Confirm slot”." : "All 3 finished independently in under 2 minutes. Two asked about rescheduling."),
        detail("Decision", missed ? "Pause new booking features. Clarify the confirmation step before expanding the workflow." : "Keep the first-booking flow for now. Explore rescheduling as the next problem to understand."),
        detail("Next mission", missed ? "Change “Confirm slot” to “Confirm booking”, add a clear confirmation screen, then repeat the same test with 3 new tutors. Keep the target: 2 of 3 finish independently within 2 minutes." : "Ask 3 tutors to walk through their most recent reschedule. Identify a repeated difficulty before deciding what to build.")
      );
      learning.append(details);
      content.append(learning, node("p", "tour-note", "Three fictional observations illustrate a decision loop; they are not proof of product-market fit. No XP or rewards are added to your project."));
      navigation.append(button("Try the other result", () => { step = 2; renderStep(); }), button("Try with my project", () => closeDemoTour(true), true));
    }

    const footer = node("div", "tour-secondary-actions");
    if (step > 0) footer.append(button("Replay from the start", () => { step = 0; outcome = null; renderStep(); }));
    if (!document.body.hasAttribute("data-tour-replay")) {
      const download = node("a", "tour-download", "Download offline example");
      download.href = "./demo-replay.html";
      download.download = "lia-guided-example.html";
      footer.append(download);
    }
    content.append(footer);
    content.scrollTop = 0;
    heading.focus();
  }

  function initDemoTour() {
    if (overlay) return;
    overlay = node("div", "tour-overlay");
    overlay.id = "tour-overlay";
    overlay.hidden = true;
    dialog = node("section", "tour-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "tour-title");
    dialog.setAttribute("aria-describedby", "tour-disclosure");
    const header = node("header", "tour-header");
    const identity = node("div", "");
    const title = node("h2", "", "Try Lia in 2 minutes");
    title.id = "tour-title";
    const disclosure = node("p", "tour-disclosure", LABEL);
    disclosure.id = "tour-disclosure";
    identity.append(title, disclosure);
    const close = button("×", () => closeDemoTour());
    close.className = "tour-close";
    close.setAttribute("aria-label", "Close guided example");
    header.append(identity, close);
    progress = node("ol", "tour-progress");
    progress.setAttribute("aria-label", "Example progress");
    content = node("div", "tour-content");
    navigation = node("div", "tour-navigation");
    dialog.append(header, progress, content, navigation);
    overlay.append(dialog);
    document.body.append(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeDemoTour(); });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDemoTour();
      }
      if (event.key !== "Tab") return;
      const targets = Array.from(dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"]')).filter(element => !element.hidden);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !targets.includes(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !targets.includes(active))) {
        event.preventDefault();
        first.focus();
      }
    });
    const launcher = document.getElementById("start-demo");
    if (launcher) launcher.addEventListener("click", startDemoTour);
  }

  function startDemoTour() {
    initDemoTour();
    if (!overlay.hidden) return;
    returnFocus = document.activeElement;
    inertElements = Array.from(document.body.children)
      .filter(element => element !== overlay && element instanceof HTMLElement)
      .map(element => [element, element.inert]);
    inertElements.forEach(([element]) => { element.inert = true; });
    step = 0;
    outcome = null;
    overlay.hidden = false;
    renderStep();
  }

  window.initDemoTour = initDemoTour;
  window.startDemoTour = startDemoTour;
})();
