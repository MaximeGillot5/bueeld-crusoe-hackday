"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const card = byId("build-experiment-card");
  if (!card) return;
  let experiment = null;
  let review = null;
  let stats = null;
  let responses = [];
  let busy = false;
  let loadingGeneration = 0;

  function status(message, error = false) {
    const node = byId("build-exp-status");
    node.textContent = message || "";
    node.dataset.error = String(error);
  }
  function id() { return experiment?.id || null; }
  function publicUrl() {
    const url = experiment?.publicUrl || (experiment?.publicId ? `/e/${encodeURIComponent(experiment.publicId)}` : "");
    return url ? new URL(url, location.origin).href : "";
  }
  function fieldValues() {
    const options = [byId("build-exp-option-yes").value.trim(), byId("build-exp-option-no").value.trim()];
    return {
      missionId: "interest_test",
      title: byId("build-exp-title").value.trim(),
      audience: byId("build-exp-audience").value.trim(),
      hypothesis: byId("build-exp-hypothesis").value.trim(),
      question: byId("build-exp-question").value.trim(),
      options,
      successOption: options[Number(byId("build-exp-success").value) || 0],
      minimumResponses: Number(byId("build-exp-minimum").value),
      thresholdPercent: Number(byId("build-exp-percent").value)
    };
  }
  function setFields(value) {
    if (!value) return;
    byId("build-exp-title").value = value.title || "";
    byId("build-exp-audience").value = value.audience || "";
    byId("build-exp-hypothesis").value = value.hypothesis || "";
    byId("build-exp-question").value = value.question || "";
    const options = Array.isArray(value.options) ? value.options : [];
    byId("build-exp-option-yes").value = options[0] || "Yes, I would try it";
    byId("build-exp-option-no").value = options[1] || "Not right now";
    byId("build-exp-success").value = String(Math.max(0, options.indexOf(value.successOption)));
    byId("build-exp-minimum").value = String(value.minimumResponses || 10);
    byId("build-exp-percent").value = String(value.thresholdPercent || 40);
  }
  function resultNumbers() {
    const total = Number(stats?.totalResponses ?? stats?.responses ?? responses.length);
    const qualified = Number(stats?.qualified ?? responses.filter((item) => item.qualified).length);
    const positive = Number(stats?.matching ?? responses.filter((item) => item.qualified && item.choice === experiment?.successOption).length);
    return { total, qualified, positive, rate: qualified ? Math.round(100 * positive / qualified) : 0 };
  }
  function renderResults() {
    const box = byId("build-exp-results");
    box.hidden = !stats && !responses.length && !review;
    if (box.hidden) return;
    const { total, qualified, positive, rate } = resultNumbers();
    byId("build-exp-count").textContent = `${total} response${total === 1 ? "" : "s"} · ${qualified} from the stated audience`;
    byId("build-exp-signal").textContent = `${positive} of ${qualified} qualified respondents selected the interest signal (${rate}%). This is stated interest, not a sale.`;
    const reviewText = review?.summary || review?.interpretation || review?.decision || review?.text || "";
    byId("build-exp-review-text").textContent = reviewText ? `Lia's review: ${reviewText}` : "";
    const comments = Array.isArray(responses) ? responses.map((item) => item.comment).filter(Boolean).slice(0, 5) : [];
    byId("build-exp-comments").replaceChildren(...comments.map((comment) => {
      const item = document.createElement("li");
      item.textContent = comment;
      return item;
    }));
  }
  function render() {
    const state = experiment?.status || "new";
    byId("build-experiment-state").textContent = state === "new" ? "Not started" : state;
    const locked = state === "published" || state === "closed";
    for (const input of card.querySelectorAll("#build-experiment-form input, #build-experiment-form select, #build-experiment-form textarea")) input.disabled = locked || busy;
    byId("build-exp-save").hidden = locked;
    byId("build-exp-save").disabled = busy;
    byId("build-exp-save").textContent = state === "draft" ? "Save draft →" : "Prepare draft →";
    byId("build-exp-publish").hidden = state !== "draft";
    byId("build-exp-refresh").hidden = !["published", "closed"].includes(state);
    byId("build-exp-close").hidden = state !== "published";
    byId("build-exp-review").hidden = state !== "closed";
    byId("build-exp-apply").hidden = state !== "closed" || !review;
    for (const action of ["build-exp-publish", "build-exp-refresh", "build-exp-close", "build-exp-review", "build-exp-apply"]) byId(action).disabled = busy;
    const url = publicUrl();
    byId("build-exp-public").hidden = !url || state === "draft";
    if (url) { byId("build-exp-link").href = url; byId("build-exp-link").textContent = url; }
    renderResults();
  }
  async function call(method, path, body) { return accountApi(method, path, body); }
  async function load() {
    const generation = ++loadingGeneration;
    if (!accountSession.authenticated) return;
    try {
      const data = await call("GET", "/api/experiments");
      if (generation !== loadingGeneration) return;
      const list = Array.isArray(data.experiments) ? data.experiments : [];
      const previousId = id();
      experiment = list.find((item) => item.missionId === "interest_test") || null;
      if (id() !== previousId) { setFields(experiment); review = experiment?.review || null; }
      render();
      if (experiment && ["published", "closed"].includes(experiment.status)) await loadResults();
    } catch (error) { status(error.message || "Could not load your test.", true); }
  }
  async function loadResults() {
    if (!id()) return;
    try {
      const data = await call("GET", `/api/experiments/${encodeURIComponent(id())}/results`);
      if (data.experiment) experiment = data.experiment;
      stats = data.stats || null;
      responses = Array.isArray(data.responses) ? data.responses : [];
      review = data.review || experiment?.review || review;
      render();
      status("Results are up to date.");
    } catch (error) { status(error.message || "Could not refresh results.", true); }
  }
  async function save(event) {
    event.preventDefault();
    if (busy || !byId("build-experiment-form").reportValidity()) return;
    const payload = fieldValues();
    if (payload.options[0] === payload.options[1]) { status("Use two distinct responses.", true); return; }
    busy = true; render(); status(experiment?.status === "draft" ? "Saving draft…" : "Preparing draft…");
    try {
      const data = experiment?.status === "draft"
        ? await call("PATCH", `/api/experiments/${encodeURIComponent(id())}`, payload)
        : await call("POST", "/api/experiments/propose", payload);
      experiment = data.experiment;
      if (!experiment?.id) throw new Error("The test draft was not returned.");
      status("Draft saved. Check the exact question and threshold, then approve publication.");
    } catch (error) { status(error.message || "Could not save draft.", true); }
    finally { busy = false; render(); }
  }
  async function action(kind) {
    if (busy || !id()) return;
    busy = true; render();
    const messages = { publish: "Publishing approved form…", close: "Closing test…", review: "Lia is reviewing the results…" };
    status(messages[kind]);
    try {
      const data = await call("POST", `/api/experiments/${encodeURIComponent(id())}/${kind}`);
      if (data.experiment) experiment = data.experiment;
      if (data.publicUrl) experiment.publicUrl = data.publicUrl;
      if (data.stats) stats = data.stats;
      if (data.review) review = data.review;
      status(kind === "publish" ? "Test published. Share the link to collect real responses."
        : kind === "close" ? "Test closed. The responses remain saved; request Lia's review next."
          : "Review saved. You can now attach the result to this mission.");
      if (kind !== "publish") await loadResults();
    } catch (error) { status(error.message || `Could not ${kind} the test.`, true); }
    finally { busy = false; render(); }
  }
  function applyEvidence() {
    if (!experiment || experiment.status !== "closed" || !review) return;
    const { total, qualified, positive, rate } = resultNumbers();
    const summary = `Interest test "${experiment.title}" was closed and reviewed. ${total} people responded; ${qualified} matched the intended audience and ${positive} of those selected the interest signal (${rate}%). The result is stated interest, not a sale.`;
    window.BUILDHome?.prefillEvidence?.({ summary, experimentId: experiment.id, outcome: "learned" });
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(publicUrl()); status("Public link copied."); }
    catch { status("Copy the public link shown above.", true); }
  }

  byId("build-experiment-form").addEventListener("submit", save);
  byId("build-exp-publish").addEventListener("click", () => action("publish"));
  byId("build-exp-close").addEventListener("click", () => action("close"));
  byId("build-exp-review").addEventListener("click", () => action("review"));
  byId("build-exp-refresh").addEventListener("click", loadResults);
  byId("build-exp-copy").addEventListener("click", copyLink);
  byId("build-exp-apply").addEventListener("click", applyEvidence);
  window.addEventListener("build:mission-opened", (event) => {
    const active = (event.detail?.mission?.milestoneId || event.detail?.mission?.id) === "interest_test";
    card.hidden = !active;
    if (active) void load();
  });
})();
