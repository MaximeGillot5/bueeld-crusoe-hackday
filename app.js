"use strict";

const STORAGE_KEY = "bueeld-decision-loop-v1";
let accountSession = { authenticated: false, user: null, csrfToken: "" };
let accountReady = false;
const GUEST_HIDDEN_KEY = "bueeld-lab-guest-hidden-v1";
const ACCOUNT_EVENT_KEY = "bueeld-lab-account-event-v1";
let guestHidden = false;
let workspaceGeneration = 0;
function broadcastAccountChange() {
  try { localStorage.setItem(ACCOUNT_EVENT_KEY, crypto.randomUUID()); } catch { /* Other tabs will recheck on reload. */ }
}
window.addEventListener("storage", (event) => {
  if (event.key === ACCOUNT_EVENT_KEY) window.location.reload();
});

function currentStorageKey(base) {
  const id = accountSession.authenticated && accountSession.user?.id;
  return id ? `${base}-user-${String(id).replace(/[^A-Za-z0-9_-]/g, "")}` : base;
}
const DEFAULT_BRIEF = "Atelier Loop is a fictional circular-delivery startup serving independent shops. Twelve founder interviews suggest demand and three shops are ready to pilot. The team must decide whether to launch a neighborhood pilot now or spend another month validating delivery economics. The main uncertainty is whether collection and return routes can be run at a sustainable cost.";
const DEFAULT_EVIDENCE = "Observed: 12 interviews; 3 shops willing to participate in a pilot; shops repeatedly mention convenience. Unknown: route density, time per pickup, and whether enough customers actually return packaging. We have no completed operational pilot yet.";

const $ = (id) => document.getElementById(id);
const el = (tag, className, textValue) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textValue !== undefined) node.textContent = String(textValue);
  return node;
};

function emptyState() {
  return {
    brief: DEFAULT_BRIEF,
    evidence: DEFAULT_EVIDENCE,
    plan: null,
    planId: null,
    chosenOption: null,
    approved: false,
    result: { value: "", notes: "" },
    review: null,
    metThreshold: null,
    journal: []
  };
}

function isPlan(value) {
  const experiment = value?.recommendedExperiment;
  return value &&
    Array.isArray(value.facts) && value.facts.every((item) => typeof item === "string") &&
    value.riskyAssumption && typeof value.riskyAssumption.statement === "string" &&
    typeof value.riskyAssumption.impactIfWrong === "string" &&
    typeof value.riskyAssumption.confidence === "string" &&
    Array.isArray(value.options) && value.options.every((option) =>
      typeof option.name === "string" && typeof option.description === "string" &&
      (typeof option.pros === "string" || Array.isArray(option.pros)) &&
      (typeof option.cons === "string" || Array.isArray(option.cons))) &&
    experiment && typeof experiment.description === "string" &&
    typeof experiment.metric === "string" &&
    Number.isFinite(experiment.threshold) &&
    typeof experiment.unit === "string" &&
    ["at_least", "more_than"].includes(experiment.comparison) &&
    typeof experiment.estimatedDuration === "string" &&
    Array.isArray(experiment.evidenceToCollect);
}

function isReview(value) {
  return value && ["continue", "iterate", "stop"].includes(value.status) &&
    typeof value.rationale === "string" &&
    Array.isArray(value.nextSteps) && value.nextSteps.every((item) => typeof item === "string");
}

function loadState() {
  const fresh = emptyState();
  try {
    const saved = JSON.parse(localStorage.getItem(currentStorageKey(STORAGE_KEY)) || "null");
    if (!saved || typeof saved !== "object") return fresh;
    fresh.brief = typeof saved.brief === "string" ? saved.brief : fresh.brief;
    fresh.evidence = typeof saved.evidence === "string" ? saved.evidence : fresh.evidence;
    if (isPlan(saved.plan) && typeof saved.planId === "string" && saved.planId) {
      fresh.plan = saved.plan;
      fresh.planId = saved.planId;
      if (typeof saved.chosenOption === "string" && fresh.plan.options.some((option) => option.name === saved.chosenOption)) {
        fresh.chosenOption = saved.chosenOption;
      }
      fresh.approved = saved.approved === true && fresh.chosenOption !== null;
    }
    if (saved.result && typeof saved.result === "object") {
      fresh.result.value = saved.result.value === "" || Number.isFinite(Number(saved.result.value)) ? String(saved.result.value) : "";
      fresh.result.notes = typeof saved.result.notes === "string" ? saved.result.notes : "";
    }
    if (fresh.approved && isReview(saved.review) && typeof saved.metThreshold === "boolean") {
      fresh.review = saved.review;
      fresh.metThreshold = saved.metThreshold;
    }
    if (Array.isArray(saved.journal)) {
      fresh.journal = saved.journal.filter((entry) => entry && Number.isFinite(entry.at) && typeof entry.text === "string").slice(-100);
    }
  } catch {
    $("storage-warning").hidden = false;
  }
  return fresh;
}

let state = emptyState();
let planBusy = false;
let reviewBusy = false;

function persist() {
  try {
    localStorage.setItem(currentStorageKey(STORAGE_KEY), JSON.stringify(state));
    $("storage-warning").hidden = true;
  } catch {
    $("storage-warning").hidden = false;
  }
}

function addJournal(textValue) {
  state.journal.push({ at: Date.now(), text: textValue });
  state.journal = state.journal.slice(-100);
  persist();
  renderJournal();
}

function setStatus(id, message, kind = "") {
  const node = $(id);
  node.textContent = message;
  node.className = `form-status${kind ? ` is-${kind}` : ""}`;
}

const busyButtonContents = new WeakMap();

function setBusy(buttonId, formId, busy, label) {
  const button = $(buttonId);
  if (!busyButtonContents.has(button)) {
    busyButtonContents.set(button, [...button.childNodes].map((node) => node.cloneNode(true)));
  }
  button.disabled = busy;
  if (busy) button.textContent = label;
  else button.replaceChildren(...busyButtonContents.get(button).map((node) => node.cloneNode(true)));
  $(formId).setAttribute("aria-busy", busy ? "true" : "false");
}

let demoUsage = null;
let demoUsageRequest = 0;
let demoUsageRefreshTimer = null;
const DEMO_USAGE_REFRESH_INTERVAL_MS = 15_000;
function isDemoQuotaExhausted() {
  return demoUsage !== null && demoUsage.used >= demoUsage.limit;
}
function renderDemoUsage() {
  if (!demoUsage) return;
  const remaining = Math.max(0, demoUsage.limit - demoUsage.used);
  $("demo-usage").textContent = "Shared demo AI calls remaining: " + remaining + " of " + demoUsage.limit + ". Chat and source analyses share this allowance.";
  $("demo-quota-alert").hidden = remaining > 2;
  $("demo-quota-alert").classList.toggle("is-exhausted", remaining === 0);
  $("demo-quota-alert").textContent = remaining === 0
    ? "The shared demo AI limit is reached. Saved chats and missions remain available."
    : "Only " + remaining + " shared AI " + (remaining === 1 ? "call remains." : "calls remain.");
}
async function refreshDemoUsage() {
  const request = ++demoUsageRequest;
  try {
    const response = await fetch("/api/demo/usage", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Usage unavailable");
    const data = await response.json();
    if (request !== demoUsageRequest || !Number.isInteger(data.used) || !Number.isInteger(data.limit)) return;
    demoUsage = { used: data.used, limit: data.limit };
    renderDemoUsage();
    renderChat();
  } catch {
    if (!demoUsage) $("demo-usage").textContent = "Shared demo AI allowance is temporarily unavailable.";
  } finally {
    if (request === demoUsageRequest) scheduleDemoUsageRefresh();
  }
}

function scheduleDemoUsageRefresh() {
  clearTimeout(demoUsageRefreshTimer);
  demoUsageRefreshTimer = null;
  if (!document.hidden && isDemoQuotaExhausted()) {
    demoUsageRefreshTimer = setTimeout(() => void refreshDemoUsage(), DEMO_USAGE_REFRESH_INTERVAL_MS);
  }
}

function refreshDemoUsageWhenVisible() {
  clearTimeout(demoUsageRefreshTimer);
  demoUsageRefreshTimer = null;
  if (!document.hidden) void refreshDemoUsage();
}

async function postJson(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error("The AdaL service could not be reached. Check that the local server is running and try again.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`The service returned an unreadable response (HTTP ${response.status}).`);
  }
  if (["/api/chat", "/api/plan", "/api/review", "/api/mission/learn", "/api/sources/analyze", "/api/sources/github"].includes(path)) void refreshDemoUsage();
  if (!response.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `The request failed (HTTP ${response.status}).`);
  }
  return data;
}

function formatPoints(value) {
  return Array.isArray(value) ? value.join(" · ") : String(value);
}

function renderPlan() {
  if (!state.plan) return;
  const plan = state.plan;
  const experiment = plan.recommendedExperiment;

  $("facts-list").replaceChildren(...plan.facts.map((fact) => el("li", "", fact)));
  $("assumption-statement").textContent = plan.riskyAssumption.statement;
  $("assumption-impact").textContent = plan.riskyAssumption.impactIfWrong;
  $("assumption-confidence").textContent = plan.riskyAssumption.confidence;

  const optionCards = plan.options.map((option) => {
    const card = el("article", "option-card");
    card.append(el("h4", "", option.name), el("p", "", option.description));
    const points = el("div", "option-points");
    for (const [label, value, className] of [["PRO", option.pros, ""], ["RISK", option.cons, "con-label"]]) {
      const row = el("div");
      row.append(el("span", className, label), el("p", "", formatPoints(value)));
      points.append(row);
    }
    card.append(points);
    return card;
  });
  $("options-list").replaceChildren(...optionCards);

  const choiceRows = plan.options.map((option, index) => {
    const row = el("div", "option-choice");
    const inputId = `option-choice-${index}`;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "chosen-option";
    input.id = inputId;
    input.value = option.name;
    input.checked = state.chosenOption === option.name;
    const label = document.createElement("label");
    label.setAttribute("for", inputId);
    label.textContent = option.name;
    row.append(input, label);
    return row;
  });
  $("option-choice-list").replaceChildren(...choiceRows);

  $("experiment-description").textContent = experiment.description;
  $("experiment-metric").textContent = experiment.metric;
  $("experiment-duration").textContent = experiment.estimatedDuration;
  $("evidence-list").replaceChildren(...experiment.evidenceToCollect.map((item) => el("li", "", item)));
  $("comparison-input").value = experiment.comparison;
  $("threshold-input").value = String(experiment.threshold);
  $("threshold-unit").textContent = experiment.unit;
  $("result-unit").textContent = experiment.unit;
  $("result-metric-help").textContent = experiment.metric;
}

function renderReview() {
  if (!state.review || !state.plan) return;
  const { review, plan, result } = state;
  const labels = {
    continue: ["THRESHOLD MET", "Continue the test.", "↗"],
    iterate: ["LEARN AND ADJUST", "Revise the approach.", "↻"],
    stop: ["EVIDENCE SAYS STOP", "Stop this path.", "×"]
  };
  const [kicker, title, icon] = labels[review.status];
  const panel = $("review-section");
  panel.classList.remove("status-continue", "status-iterate", "status-stop");
  panel.classList.add(`status-${review.status}`);
  $("outcome-kicker").textContent = kicker;
  $("review-title").textContent = title;
  $("outcome-icon").textContent = icon;
  const experiment = plan.recommendedExperiment;
  const comparator = experiment.comparison === "more_than" ? ">" : "≥";
  const verdict = state.metThreshold ? "Success bar met" : "Success bar missed";
  $("result-comparison").textContent = `${result.value} ${experiment.unit} measured · target ${comparator} ${experiment.threshold} ${experiment.unit} · ${verdict}`;
  $("review-rationale").textContent = review.rationale;
  $("next-steps-list").replaceChildren(...review.nextSteps.map((step) => el("li", "", step)));
}

function renderJournal() {
  const list = $("journal-list");
  if (state.journal.length === 0) {
    list.replaceChildren(el("li", "journal-empty", "No decisions recorded yet. Generate a plan to start the log."));
  } else {
    const entries = [...state.journal].reverse().map((entry) => {
      const item = el("li");
      const time = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(entry.at);
      item.append(el("span", "journal-time", time), el("span", "journal-event", entry.text));
      return item;
    });
    list.replaceChildren(...entries);
  }
  $("export-button").disabled = !state.plan;
}

function renderSteps() {
  const current = !state.plan ? "brief" : !state.approved ? "approve" : !state.review ? "review" : null;
  for (const item of $("step-list").children) {
    const key = item.dataset.step;
    const done = key === "brief" ? !!state.plan : key === "plan" ? !!state.plan : key === "approve" ? state.approved : !!state.review;
    item.classList.toggle("is-done", done);
    item.classList.toggle("is-current", key === current);
    if (key === current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}

function renderWorkflow() {
  $("plan-section").hidden = !state.plan;
  $("result-section").hidden = !state.approved;
  $("review-section").hidden = !state.review;
  $("brief-state").textContent = state.plan ? "CONTEXT RECORDED" : "READY TO START";
  $("result-state").textContent = state.review ? "RESULT ASSESSED" : "AWAITING RESULT";
  $("approval-indicator").textContent = state.approved ? "Approved by you" : "Approval required";
  renderSteps();
}

function render() {
  renderPlan();
  renderReview();
  renderWorkflow();
  renderJournal();
}

function invalidatePlan() {
  if (!state.plan) return;
  state.plan = null;
  state.planId = null;
  state.chosenOption = null;
  state.approved = false;
  state.review = null;
  state.metThreshold = null;
  state.result = { value: "", notes: "" };
  $("result-input").value = "";
  $("notes-input").value = "";
  setStatus("review-status", "");
  setStatus("plan-status", "The context changed. Generate a new plan before continuing.");
  addJournal("Founder context changed; previous plan and assessment were cleared.");
  renderWorkflow();
}

function updateContext() {
  const brief = $("brief-input").value;
  const evidence = $("evidence-input").value;
  if (brief !== state.brief || evidence !== state.evidence) invalidatePlan();
  state.brief = brief;
  state.evidence = evidence;
  persist();
  renderJournal();
}

async function generatePlan(event) {
  event.preventDefault();
  if (planBusy) return;
  updateContext();
  const brief = state.brief.trim();
  const evidence = state.evidence.trim();
  if (!brief || !evidence) {
    setStatus("plan-status", "Add both a founder brief and evidence before asking AdaL.", "error");
    (!brief ? $("brief-input") : $("evidence-input")).focus();
    return;
  }
  planBusy = true;
  setBusy("plan-button", "plan-form", true, "AdaL is shaping the decision…");
  setStatus("plan-status", "AdaL is comparing options and designing a test.");
  try {
    const data = await postJson("/api/plan", { brief, evidence });
    if (state.brief.trim() !== brief || state.evidence.trim() !== evidence) {
      throw new Error("The context changed while AdaL was working. Generate a new plan for the latest brief.");
    }
    if (data.source !== "adal" || !isPlan(data.plan) || typeof data.planId !== "string" || !data.planId) {
      throw new Error("AdaL returned an incomplete plan. Please try again.");
    }
    state.plan = data.plan;
    state.planId = data.planId;
    state.chosenOption = null;
    state.approved = false;
    state.result = { value: "", notes: "" };
    state.review = null;
    state.metThreshold = null;
    $("result-input").value = "";
    $("notes-input").value = "";
    addJournal(`AdaL proposed an experiment: ${data.plan.recommendedExperiment.description}`);
    render();
    setStatus("plan-status", "Plan ready. Review the assumption and set your success bar.", "success");
    $("plan-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus("plan-status", error.message || "The plan could not be generated.", "error");
  } finally {
    planBusy = false;
    setBusy("plan-button", "plan-form", false);
  }
}

function revokeApproval() {
  if (!state.plan) return;
  if (state.approved) {
    state.approved = false;
    state.review = null;
    state.metThreshold = null;
    setStatus("review-status", "");
    addJournal("Success bar changed; human approval and previous assessment were cleared.");
  }
  const threshold = Number($("threshold-input").value);
  if ($("threshold-input").value.trim() !== "" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1_000_000) {
    state.plan.recommendedExperiment.threshold = threshold;
  }
  state.plan.recommendedExperiment.comparison = $("comparison-input").value;
  persist();
  renderWorkflow();
}

function chooseOption(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== "chosen-option" || !state.plan) return;
  const name = target.value;
  if (state.chosenOption === name) return;
  state.chosenOption = name;
  if (state.approved) {
    state.approved = false;
    state.review = null;
    state.metThreshold = null;
    setStatus("review-status", "");
    addJournal(`Founder changed the chosen option to "${name}"; approval and previous assessment were cleared.`);
  } else {
    persist();
  }
  renderWorkflow();
}

function approveExperiment(event) {
  event.preventDefault();
  if (!state.plan) return;
  if (!state.chosenOption) {
    $("approval-indicator").textContent = "Choose one option above before approving.";
    $("option-choice-list").querySelector("input[type=radio]")?.focus();
    return;
  }
  const raw = $("threshold-input").value.trim();
  const threshold = Number(raw);
  if (!raw || !Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000) {
    $("approval-indicator").textContent = "Enter a threshold between 0 and 1,000,000.";
    $("threshold-input").focus();
    return;
  }
  const comparison = $("comparison-input").value;
  if (!["at_least", "more_than"].includes(comparison)) return;
  const experiment = state.plan.recommendedExperiment;
  experiment.threshold = threshold;
  experiment.comparison = comparison;
  state.approved = true;
  state.review = null;
  state.metThreshold = null;
  setStatus("review-status", "");
  const word = comparison === "more_than" ? "more than" : "at least";
  addJournal(`Human approved the experiment with a success bar of ${word} ${threshold} ${experiment.unit}, choosing "${state.chosenOption}".`);
  renderWorkflow();
  $("result-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateResult() {
  state.result.value = $("result-input").value;
  state.result.notes = $("notes-input").value;
  if (state.review) {
    state.review = null;
    state.metThreshold = null;
    setStatus("review-status", "The result changed. Ask AdaL to reassess it again.");
    renderWorkflow();
  }
  persist();
}

async function reassess(event) {
  event.preventDefault();
  if (reviewBusy || !state.plan || !state.planId || !state.approved) return;
  updateResult();
  const raw = state.result.value.trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
    setStatus("review-status", "Enter a measured result between 0 and 1,000,000.", "error");
    $("result-input").focus();
    return;
  }
  reviewBusy = true;
  const snapshot = {
    planId: state.planId,
    chosenOption: state.chosenOption,
    threshold: state.plan.recommendedExperiment.threshold,
    comparison: state.plan.recommendedExperiment.comparison,
    notes: state.result.notes.trim()
  };
  setBusy("review-button", "review-form", true, "AdaL is reassessing…");
  setStatus("review-status", "AdaL is comparing the result with your approved threshold.");
  try {
    const data = await postJson("/api/review", {
      planId: state.planId,
      approved: true,
      brief: state.brief.trim(),
      evidence: state.evidence.trim(),
      plan: state.plan,
      chosenOption: snapshot.chosenOption,
      result: { value, notes: snapshot.notes }
    });
    if (!state.approved || state.planId !== snapshot.planId || state.chosenOption !== snapshot.chosenOption || state.plan.recommendedExperiment.threshold !== snapshot.threshold || state.plan.recommendedExperiment.comparison !== snapshot.comparison || state.result.value.trim() !== raw || state.result.notes.trim() !== snapshot.notes) {
      throw new Error("The approved choice, bar, or result changed while AdaL was working. Reassess the latest version.");
    }
    if (data.source !== "adal" || !isReview(data.review) || typeof data.metThreshold !== "boolean") {
      throw new Error("AdaL returned an incomplete assessment. Please try again.");
    }
    const { threshold, comparison } = state.plan.recommendedExperiment;
    const locallyMet = comparison === "more_than" ? value > threshold : value >= threshold;
    if (data.metThreshold !== locallyMet) {
      throw new Error("The assessment conflicts with the approved threshold. Please retry before using this recommendation.");
    }
    state.review = data.review;
    state.metThreshold = data.metThreshold;
    state.result.value = String(value);
    addJournal(`AdaL reassessed the measured result (${value} ${state.plan.recommendedExperiment.unit}): ${data.review.status}.`);
    render();
    setStatus("review-status", "Assessment ready. Review AdaL's reasoning below.", "success");
    $("review-section").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus("review-status", error.message || "The assessment could not be completed.", "error");
  } finally {
    reviewBusy = false;
    setBusy("review-button", "review-form", false);
  }
}

function exportMarkdown() {
  if (!state.plan) return;
  const { plan, review, result } = state;
  const experiment = plan.recommendedExperiment;
  const comparison = experiment.comparison === "more_than" ? ">" : "≥";
  const lines = [
    "# Bueeld Decision Loop",
    "",
    "_AI Co-Founder Hackathon prototype. The Atelier Loop sample is fictional._",
    "",
    "## Founder brief",
    state.brief,
    "",
    "## Evidence so far",
    state.evidence,
    "",
    "## Facts identified by AdaL",
    ...plan.facts.map((fact) => `- ${fact}`),
    "",
    "## Risky assumption",
    plan.riskyAssumption.statement,
    `- Impact if wrong: ${plan.riskyAssumption.impactIfWrong}`,
    `- AI confidence: ${plan.riskyAssumption.confidence}`,
    "",
    "## Options",
    ...plan.options.flatMap((option) => [
      `### ${option.name}`,
      option.description,
      `- Upside: ${formatPoints(option.pros)}`,
      `- Risk: ${formatPoints(option.cons)}`,
      ""
    ]),
    "## Experiment",
    experiment.description,
    `- Metric: ${experiment.metric}`,
    `- Success threshold: ${comparison} ${experiment.threshold} ${experiment.unit}`,
    `- Timebox: ${experiment.estimatedDuration}`,
    ...experiment.evidenceToCollect.map((item) => `- Collect: ${item}`),
    `- Chosen option: ${state.chosenOption || "Not yet chosen"}`,
    `- Human approved: ${state.approved ? "yes" : "no"}`
  ];
  if (review) {
    lines.push("", "## Result and reassessment", `- Measured result: ${result.value} ${experiment.unit}`, `- Success bar met: ${state.metThreshold ? "yes" : "no"}`, `- Notes: ${result.notes || "None provided"}`, `- AdaL recommendation: ${review.status}`, "", review.rationale, "", "### Next steps", ...review.nextSteps.map((step) => `- ${step}`));
  }
  lines.push("", "## Decision journal", ...state.journal.map((entry) => `- ${new Date(entry.at).toLocaleString()}: ${entry.text}`), "");
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = `bueeld-decision-loop-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resetScenario() {
  if (!window.confirm("Clear this local decision and start again with the fictional Atelier Loop example?")) return;
  state = emptyState();
  $("brief-input").value = state.brief;
  $("evidence-input").value = state.evidence;
  $("result-input").value = "";
  $("notes-input").value = "";
  setStatus("plan-status", "");
  setStatus("review-status", "");
  persist();
  render();
  $("brief-section").scrollIntoView({ behavior: "smooth", block: "start" });
}

$("brief-input").value = state.brief;
$("evidence-input").value = state.evidence;
$("result-input").value = state.result.value;
$("notes-input").value = state.result.notes;
$("threshold-input").min = "0";
$("threshold-input").max = "1000000";
$("result-input").min = "0";
$("result-input").max = "1000000";
$("brief-input").addEventListener("input", updateContext);
$("evidence-input").addEventListener("input", updateContext);
$("plan-form").addEventListener("submit", generatePlan);
$("option-choice-list").addEventListener("change", chooseOption);
$("threshold-input").addEventListener("input", revokeApproval);
$("comparison-input").addEventListener("change", revokeApproval);
$("approval-form").addEventListener("submit", approveExperiment);
$("result-input").addEventListener("input", updateResult);
$("notes-input").addEventListener("input", updateResult);
$("review-form").addEventListener("submit", reassess);
$("export-button").addEventListener("click", exportMarkdown);
$("reset-button").addEventListener("click", resetScenario);
render();

const SOURCE_CONTEXT_LIMIT = 3;
const SOURCE_WAIT_MESSAGE = "Lia is analyzing a project source. Chat will be available when it finishes.";
const SOURCE_REGISTRY = [
  { id: "gmail", name: "Gmail", description: "Messages and founder or customer signals." },
  { id: "google_drive", name: "Google Drive", description: "Docs, notes, and project files." },
  { id: "google_calendar", name: "Google Calendar", description: "Upcoming meetings and deadlines." },
  { id: "notion", name: "Notion", description: "Decisions, tasks, and project knowledge." },
  { id: "github", name: "GitHub", description: "Public repository metadata and README only." }
];
const SOURCE_SAMPLE = [
  { name: "AL-MAIL-01 · Prospect email · 2026-09-21 · fictional", kind: "gmail", sample: true, content: "From: Maya, independent shop owner. I would consider a small reusable-packaging trial if pickups happen before 10am. I have not signed an agreement, and I need to understand the extra work for my staff." },
  { name: "AL-DRIVE-02 · Interview notes · 2026-09-22 · fictional", kind: "google_drive", sample: true, content: "Atelier Loop interviewed 12 independent shop owners. Three said they are interested in a pilot. These are expressions of interest, not signed commitments. Route density, time per pickup, collection cost, and customer return rate have not been measured." },
  { name: "AL-CAL-03 · Planning event · 2026-09-24 · fictional", kind: "google_calendar", sample: true, content: "Internal event scheduled for 2026-09-29: discuss neighborhood pilot scope and who will record pickup time. No event outcome or pilot result exists yet." },
  { name: "AL-NOTION-04 · Decision note · 2026-09-25 · fictional", kind: "notion", sample: true, content: "Open founder decision: start a small neighborhood pilot now or validate delivery economics for another month. The success threshold and decision owner are not set. Do not claim a pilot launched." }
];
let sourceCapabilities = null;
let sourceLoading = false;
let sourceBusy = false;
let sourceEntries = [];
let manualImportKind = null;
let sourceOpener = null;
let connectorStates = null;
let connectorLoading = false;
let connectorStatusPromise = null;
let connectorItems = [];
let activeConnectorId = null;
let pendingAttachment = null;
let pendingConnectorId = null;
let returnToSourcesAfterAccount = false;
const connectorChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("bueeld-lab-connector-oauth") : null;

function selectedSourceEntries() {
  return sourceEntries.filter((entry) => entry.selected).slice(0, SOURCE_CONTEXT_LIMIT);
}

function renderActiveSources() {
  const selected = selectedSourceEntries();
  $("active-sources").hidden = selected.length === 0;
  $("active-sources-names").textContent = selected.map((entry) => entry.label).join(" · ");
}

function setSourceStatus(message, isError = false) {
  $("source-status").textContent = message;
  $("source-status").classList.toggle("is-error", isError);
}

function sourceCapability(id) {
  return sourceCapabilities?.connectors?.find((connector) => connector.id === id) || null;
}

function connectorState(id) {
  return connectorStates?.find((connector) => connector.id === id) || null;
}

function renderConnectors() {
  $("connector-account-gate").hidden = !accountReady || accountSession.authenticated;
  $("connector-sign-in").disabled = !accountReady || sourceBusy || chatBusy || accountBusy;
  $("connector-create-account").disabled = !accountReady || sourceBusy || chatBusy || accountBusy;
  const cards = SOURCE_REGISTRY.map((registry) => {
    const capability = sourceCapability(registry.id);
    const account = connectorState(registry.id);
    const card = el("article", "connector-card");
    card.append(el("strong", "", registry.name));
    const available = capability?.available === true;
    let status = "Checking availability…";
    if (registry.id === "github") status = sourceCapabilities ? (available ? "Available · public only" : "Unavailable") : "Checking availability…";
    else if (accountReady && !accountSession.authenticated) status = "Lab account required";
    else if (connectorStates) status = !account?.configured ? "OAuth setup needed" : account.connected ? "Connected" : "Ready to connect";
    else if (!connectorLoading) status = "Connection status unavailable";
    card.append(el("span", "connector-state" + ((registry.id === "github" && available) || account?.connected ? " is-available" : ""), status));
    card.append(el("p", "", registry.description));
    if (registry.id !== "github") {
      if (account?.connected) {
        if (account.account) card.append(el("p", "", String(account.account).slice(0, 120)));
        const browse = el("button", "", "Choose items");
        browse.type = "button";
        browse.dataset.connectorBrowse = registry.id;
        browse.disabled = sourceBusy || chatBusy;
        const disconnect = el("button", "", "Disconnect");
        disconnect.type = "button";
        disconnect.dataset.connectorDisconnect = registry.id;
        disconnect.disabled = sourceBusy || chatBusy;
        card.append(browse, disconnect);
      } else if (accountSession.authenticated) {
        const connect = el("button", "", "Connect account");
        connect.type = "button";
        connect.dataset.connectorConnect = registry.id;
        connect.disabled = sourceBusy || chatBusy || !accountReady || !account?.configured;
        card.append(connect);
      }
      const manual = el("button", "", "Import an export");
      manual.type = "button";
      manual.dataset.manualImport = registry.id;
      manual.disabled = sourceBusy || chatBusy || sourceCapabilities?.localImport?.available !== true;
      card.append(manual);
    }
    if (available && registry.id === "github") {
      const button = el("button", "", "Use public repository");
      button.type = "button";
      button.dataset.gotoGithub = "true";
      button.disabled = sourceBusy || chatBusy;
      card.append(button);
    }
    return card;
  });
  $("source-connectors").replaceChildren(...cards);
}

function updateSourceControls() {
  const localAvailable = sourceCapabilities?.localImport?.available === true;
  const githubAvailable = sourceCapability("github")?.available === true;
  const disabled = sourceBusy || chatBusy;
  $("analyze-sample").disabled = disabled || !localAvailable;
  $("local-source-file").disabled = disabled || !localAvailable;
  $("analyze-local").disabled = disabled || !localAvailable || !$("local-source-file").files?.length;
  $("github-repository").disabled = disabled || !githubAvailable;
  $("analyze-github").disabled = disabled || !githubAvailable || !$("github-repository").value.trim();
  $("local-availability").textContent = sourceCapabilities ? (localAvailable ? "Available · manual import" : "Unavailable") : (sourceLoading ? "Checking availability…" : "Status unavailable");
  $("local-availability").classList.toggle("is-available", localAvailable);
  $("github-availability").textContent = sourceCapabilities ? (githubAvailable ? "Available · public only" : "Unavailable") : (sourceLoading ? "Checking availability…" : "Status unavailable");
  $("github-availability").classList.toggle("is-available", githubAvailable);
  $("discuss-sources").disabled = disabled || selectedSourceEntries().length === 0;
  $("connector-import").disabled = disabled || !$("connector-items-list").querySelector("input:checked");
  for (const input of $("connector-items-list").querySelectorAll("input")) input.disabled = disabled;
  for (const input of $("source-results-list").querySelectorAll("input[data-source-select]")) input.disabled = disabled;
  for (const button of $("source-results-list").querySelectorAll("button[data-source-remove]")) button.disabled = disabled;
  $("source-panel").setAttribute("aria-busy", sourceBusy ? "true" : "false");
  renderConnectors();
}

async function loadSourceCapabilities() {
  if (sourceCapabilities || sourceLoading) return;
  sourceLoading = true;
  updateSourceControls();
  try {
    const response = await fetch("/api/sources/capabilities");
    if (!response.ok) throw new Error("Source availability could not be checked.");
    const data = await response.json();
    if (!Array.isArray(data?.connectors) || !data?.localImport) throw new Error("Source availability was incomplete.");
    sourceCapabilities = data;
    setSourceStatus("");
  } catch (error) {
    setSourceStatus(error.message || "Source availability could not be checked. Reopen Sources to retry.", true);
  } finally {
    sourceLoading = false;
    updateSourceControls();
  }
}

function loadConnectorStatus() {
  if (connectorStatusPromise) return connectorStatusPromise;
  const request = refreshConnectorStatus();
  connectorStatusPromise = request;
  void request.finally(() => { if (connectorStatusPromise === request) connectorStatusPromise = null; });
  return request;
}

async function refreshConnectorStatus() {
  const generation = workspaceGeneration;
  connectorLoading = true;
  renderConnectors();
  try {
    const response = await fetch("/api/connectors/status", { credentials: "same-origin" });
    const data = await response.json();
    if (generation !== workspaceGeneration) return;
    if (!response.ok || !Array.isArray(data?.connectors)) throw new Error("Connection status is unavailable.");
    connectorStates = data.connectors.filter((item) => item && SOURCE_REGISTRY.some((registry) => registry.id === item.id));
  } catch {
    if (generation === workspaceGeneration) {
      connectorStates = null;
      setSourceStatus("Connection status could not be checked. File and public GitHub analysis remain available.", true);
    }
  } finally {
    if (generation === workspaceGeneration) {
      connectorLoading = false;
      renderConnectors();
    }
  }
}

function openSources() {
  if (!$("account-drawer").hidden) closeAccount();
  if (!$("mission-drawer").hidden) closeMissionTracker();
  if (!$("decision-drawer").hidden) closeDecisionCanvas();
  if (!$("source-drawer").hidden) return;
  sourceOpener = document.activeElement;
  $("source-drawer").hidden = false;
  document.body.classList.add("source-open");
  $("source-panel").focus();
  loadSourceCapabilities();
  loadConnectorStatus();
}

function openConnectorsFromComposer() {
  openSources();
  requestAnimationFrame(() => {
    const heading = $("connectors-title");
    heading.focus({ preventScroll: true });
    heading.closest(".source-section").scrollIntoView({ block: "start", behavior: "smooth" });
  });
}

function openConnectorAccount(mode) {
  if (!accountReady || accountSession.authenticated || accountBusy || chatBusy || sourceBusy) return;
  returnToSourcesAfterAccount = true;
  setAccountMode(mode);
  openAccount();
  $("account-email").focus();
}

async function refreshConnectorAfterOAuth(id, outcome = null) {
  if (!accountReady || !accountSession.authenticated || !SOURCE_REGISTRY.some((entry) => entry.id === id && id !== "github")) return;
  await loadConnectorStatus();
  const connected = connectorState(id)?.connected === true;
  if (connected) {
    if (pendingConnectorId === id) pendingConnectorId = null;
    setSourceStatus(`${sourceCapability(id)?.name || id} connected. Choose items to analyze.`);
  } else if (outcome === "error") {
    if (pendingConnectorId === id) pendingConnectorId = null;
    setSourceStatus("Connection was cancelled or failed. You can try again.", true);
  } else if (outcome === "connected") {
    if (pendingConnectorId === id) pendingConnectorId = null;
    setSourceStatus("Connection could not be confirmed. Please try again.", true);
  }
}

function closeSources() {
  if (sourceBusy) setChatStatus(SOURCE_WAIT_MESSAGE);
  $("local-source-file").value = "";
  manualImportKind = null;
  $("source-import-hint").hidden = true;
  $("source-drawer").hidden = true;
  document.body.classList.remove("source-open");
  if (sourceOpener instanceof HTMLElement) sourceOpener.focus();
}

function sourceText(value) {
  return typeof value === "string" ? value : "";
}

function renderCitedSection(parent, title, items) {
  if (!Array.isArray(items) || !items.length) return;
  const section = el("div", "source-result-section");
  section.append(el("strong", "", title));
  const list = el("ul");
  for (const item of items.slice(0, 8)) {
    if (!item || typeof item.text !== "string") continue;
    const row = el("li", "", item.text);
    const cites = Array.isArray(item.sourceIds) ? item.sourceIds.filter((id) => typeof id === "string").slice(0, 4) : [];
    if (cites.length) row.append(el("span", "source-cites", " [" + cites.join(", ") + "]"));
    list.append(row);
  }
  section.append(list);
  parent.append(section);
}

function renderSourceResults() {
  $("source-results").hidden = sourceEntries.length === 0;
  const cards = sourceEntries.map((entry) => {
    const card = el("article", "source-result");
    const heading = el("div");
    heading.append(el("h4", "", entry.label), el("span", "source-result-label", entry.origin));
    const head = el("div", "source-result-head");
    head.append(heading);
    card.append(head, el("p", "source-result-summary", sourceText(entry.analysis.summary)));
    if (entry.analysis.mainRisk?.text) renderCitedSection(card, "Main risk", [entry.analysis.mainRisk]);
    if (entry.analysis.recommendedAction?.text) {
      const action = entry.analysis.recommendedAction;
      renderCitedSection(card, "Proposed next action", [{ text: action.text, sourceIds: action.sourceIds }]);
      if (sourceText(action.expectedEvidence)) card.append(el("p", "source-expected-evidence", "Expected evidence: " + action.expectedEvidence));
    }
    const controls = el("div", "source-result-controls");
    const label = el("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = entry.selected;
    check.dataset.sourceSelect = entry.id;
    label.append(check, document.createTextNode("Use this summary in chat"));
    const remove = el("button", "", "Remove summary");
    remove.type = "button";
    remove.dataset.sourceRemove = entry.id;
    controls.append(label, remove);
    card.append(controls);

    const evidence = el("details", "source-evidence");
    evidence.append(el("summary", "", "View cited evidence · " + entry.sources.length + (entry.sources.length === 1 ? " source" : " sources")));
    const evidenceBody = el("div", "source-evidence-body");
    const sources = el("ul", "source-result-sources");
    for (const source of entry.sources) {
      const name = sourceText(source.name);
      const sourceLabel = (source.id || "Source") + " · " + name + (source.sample ? " · fictional sample" : "") + (source.digest ? " · " + source.digest.slice(0, 8) : "");
      sources.append(el("li", "", sourceLabel));
    }
    evidenceBody.append(sources);
    renderCitedSection(evidenceBody, "Claims cited by Lia · verify in source", entry.analysis.facts);
    renderCitedSection(evidenceBody, "Assumptions to test", entry.analysis.assumptions);
    renderCitedSection(evidenceBody, "Open questions", entry.analysis.openQuestions);
    evidence.append(evidenceBody);
    card.append(evidence);
    return card;
  });
  $("source-results-list").replaceChildren(...cards);
  renderActiveSources();
  scheduleConversationAutosave();
  updateSourceControls();
}

function setSourceBusy(busy, message = "") {
  sourceBusy = busy;
  setSourceStatus(message);
  updateSourceControls();
  renderChat();
  if (!busy && $("chat-status").textContent === SOURCE_WAIT_MESSAGE) setChatStatus("");
}

function validAnalysisResponse(data) {
  return Array.isArray(data?.sources) && data.sources.length > 0 &&
    typeof data.analysis?.summary === "string" &&
    data.chatContext?.kind === "analysis" &&
    typeof data.chatContext.name === "string" &&
    typeof data.chatContext.digest === "string" &&
    typeof data.chatContext.summary === "string";
}

async function analyzeSources(path, payload, label, origin, autoSelect = false) {
  if (sourceBusy || chatBusy) return false;
  setSourceBusy(true, "Lia is analyzing the selected source context…");
  try {
    const data = await postJson(path, payload);
    if (!validAnalysisResponse(data)) throw new Error("AdaL returned an incomplete source analysis.");
    const selected = autoSelect && selectedSourceEntries().length < SOURCE_CONTEXT_LIMIT;
    sourceEntries.unshift({
      id: crypto.randomUUID(), label, origin, sources: data.sources,
      analysis: data.analysis, chatContext: data.chatContext, selected
    });
    sourceEntries = sourceEntries.slice(0, 8);
    renderSourceResults();
    setSourceStatus(selected ? "Analysis ready and selected for chat. Review its cited summary below." : "Analysis ready. Review the cited summary, then select it for chat.");
    if ($("source-drawer").hidden) setChatStatus(selected ? "File analyzed and added to this chat. You can now send your question." : "Analysis ready. Open Sources to select its summary.");
    else $("source-results").scrollIntoView({ block: "start", behavior: "smooth" });
    return true;
  } catch (error) {
    setSourceStatus(error.message || "AdaL could not analyze this source. Try again.", true);
    if ($("source-drawer").hidden) setChatStatus(error.message || "Source analysis failed. Open Sources to retry.", true);
    return false;
  } finally {
    sourceBusy = false;
    updateSourceControls();
    renderChat();
  }
}

function renderConnectorItems() {
  $("connector-items-section").hidden = !activeConnectorId;
  if (!activeConnectorId) return;
  const registry = SOURCE_REGISTRY.find((entry) => entry.id === activeConnectorId);
  $("connector-items-title").textContent = (registry?.name || "Connected account") + " · choose items";
  $("connector-items-intro").textContent = "Select up to four items from your " + (registry?.name || "account") + ". Only selected text will go to AdaL after you click Analyze.";
  const rows = connectorItems.map((item) => {
    const label = el("label", "connector-item");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = item.id;
    const details = el("span", "");
    details.append(el("strong", "", item.name || "Untitled item"));
    if (item.description || item.modifiedAt) details.append(el("small", "", [item.description, item.modifiedAt].filter(Boolean).join(" · ")));
    label.append(input, details);
    return label;
  });
  $("connector-items-list").replaceChildren(...rows);
  if (!rows.length) $("connector-items-list").append(el("p", "", "No supported items were found in this account."));
  updateSourceControls();
}

async function browseConnector(id) {
  if (sourceBusy || chatBusy || !connectorState(id)?.connected) return;
  setSourceBusy(true, "Loading items from your connected account…");
  try {
    const response = await fetch("/api/connectors/" + encodeURIComponent(id) + "/list", { credentials: "same-origin" });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || "Could not load account items.");
    if (!Array.isArray(data?.items)) throw new Error("The connector returned an incomplete item list.");
    connectorItems = data.items.filter((item) => typeof item?.id === "string" && item.id && typeof item?.name === "string").slice(0, 50);
    activeConnectorId = id;
    renderConnectorItems();
    setSourceStatus("Choose up to four items, then click Analyze. Their text stays out of AdaL until then.");
    $("connector-items-section").scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    setSourceStatus(error.message || "Could not load connected items.", true);
  } finally {
    sourceBusy = false;
    updateSourceControls();
    renderChat();
  }
}

function closeConnectorItems() {
  activeConnectorId = null;
  connectorItems = [];
  $("connector-items-list").replaceChildren();
  renderConnectorItems();
}

async function analyzeConnectorItems() {
  if (sourceBusy || chatBusy || !activeConnectorId) return;
  const ids = [...$("connector-items-list").querySelectorAll("input:checked")].map((input) => input.value);
  if (!ids.length || ids.length > 4) { setSourceStatus("Select one to four items.", true); return; }
  const id = activeConnectorId;
  const registry = SOURCE_REGISTRY.find((entry) => entry.id === id);
  setSourceBusy(true, "Fetching the selected items for analysis…");
  let sources;
  try {
    const data = await postJson("/api/connectors/" + encodeURIComponent(id) + "/import", { ids });
    if (!Array.isArray(data?.sources) || !data.sources.length) throw new Error("The selected items did not contain supported text.");
    sources = [];
    for (const source of data.sources) {
      if (typeof source?.pdfBase64 === "string") {
        let bytes;
        try { bytes = Uint8Array.from(atob(source.pdfBase64), (char) => char.charCodeAt(0)); }
        catch { throw new Error("The selected Drive PDF could not be decoded."); }
        const parsed = await extractPdfText(new Blob([bytes], { type: "application/pdf" }), 1800);
        sources.push({ name: (source.name + " · PDF text").slice(0, 120), kind: "google_drive", content: parsed.content });
      } else {
        sources.push(source);
      }
    }
  } catch (error) {
    setSourceStatus(error.message || "Could not import selected items.", true);
    sourceBusy = false;
    updateSourceControls();
    renderChat();
    return;
  }
  sourceBusy = false;
  const label = (registry?.name || "Connected account") + " · " + sources.length + (sources.length === 1 ? " item" : " items");
  const success = await analyzeSources("/api/sources/analyze", { sources }, label, "Connected account · selected by you");
  if (success) closeConnectorItems();
}

function analyzeSample() {
  if (!sourceCapabilities?.localImport?.available) return;
  analyzeSources("/api/sources/analyze", { sources: SOURCE_SAMPLE }, "Atelier Loop sample workspace", "Fictional · four sample records");
}

function localFileKind(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".json")) return "json";
  if ([".txt", ".eml", ".ics"].some((extension) => name.endsWith(extension))) return "text";
  return null;
}

async function extractPdfText(file, maxCharacters) {
  let pdfLibrary;
  try { pdfLibrary = await import("./pdf.mjs"); }
  catch { throw new Error("PDF reading is unavailable on this deployment."); }
  pdfLibrary.GlobalWorkerOptions.workerSrc = new URL("/pdf.worker.mjs", window.location.origin).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfLibrary.getDocument({ data, isEvalSupported: false });
  let document;
  try {
    document = await task.promise;
    const count = Math.min(document.numPages, 12);
    const parts = [];
    let length = 0;
    let truncated = document.numPages > count;
    for (let pageNumber = 1; pageNumber <= count && length < maxCharacters; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const text = await page.getTextContent();
      const pageText = text.items.map((item) => typeof item.str === "string" ? item.str : "").filter(Boolean).join(" ").trim();
      if (pageText) {
        parts.push("Page " + pageNumber + ": " + pageText);
        length += pageText.length + 12;
      }
      page.cleanup();
    }
    const fullText = parts.join("\n\n").trim();
    if (!fullText) throw new Error("No selectable text was found in this PDF. Scan or image PDFs need OCR first.");
    if (fullText.length > maxCharacters) truncated = true;
    return { content: fullText.slice(0, maxCharacters), kind: "text", truncated };
  } catch (error) {
    if (error?.message?.includes("No selectable text")) throw error;
    throw new Error("This PDF could not be read. Try an unencrypted PDF with selectable text.");
  } finally {
    if (document) await document.destroy();
    else await task.destroy();
  }
}

async function readLocalFile(file) {
  const parsedKind = localFileKind(file);
  if (!parsedKind) throw new Error("Choose a PDF, .txt, .md, .csv, .json, .eml, or .ics file.");
  if (file.size > (parsedKind === "pdf" ? 8_000_000 : 64_000)) {
    throw new Error(parsedKind === "pdf" ? "PDFs must be 8 MB or less." : "Text files must be 64 KB or less.");
  }
  const max = Number(sourceCapabilities?.localImport?.maxCharacters) || 8000;
  if (parsedKind === "pdf") return extractPdfText(file, max);
  let content;
  try { content = (await file.text()).trim(); }
  catch { throw new Error("This file could not be read in your browser."); }
  if (!content || content.includes("\u0000")) throw new Error("Choose a nonempty, readable text file.");
  return { content: content.slice(0, max), kind: parsedKind, truncated: content.length > max };
}

function renderAttachment() {
  $("attached-file").hidden = !pendingAttachment;
  $("attach-file").disabled = chatBusy || sourceBusy;
  $("chat-connectors").disabled = sourceBusy;
  if (!pendingAttachment) return;
  const kind = localFileKind(pendingAttachment);
  $("attached-file-name").textContent = pendingAttachment.name;
  $("attached-file").querySelector(".attached-file-icon").textContent = kind === "pdf" ? "PDF" : "FILE";
  $("attached-file-meta").textContent = kind === "pdf" ? "PDF · selectable text · up to 12 pages" : "Text · up to 8,000 characters";
  $("attached-file-analyze").disabled = chatBusy || sourceBusy;
  $("attached-file-remove").disabled = chatBusy || sourceBusy;
}

function chooseChatFile() {
  if (chatBusy || sourceBusy) return;
  $("chat-file-input").click();
}

function setChatFile() {
  const file = $("chat-file-input").files?.[0];
  if (!file) return;
  if (!localFileKind(file) || file.size > (localFileKind(file) === "pdf" ? 8_000_000 : 64_000)) {
    setChatStatus("Choose a PDF up to 8 MB or a .txt, .md, .csv, .json, .eml, or .ics file up to 64 KB.", true);
    $("chat-file-input").value = "";
    return;
  }
  pendingAttachment = file;
  setChatStatus("File attached locally. Click Analyze & use in chat to send its extracted text to AdaL.");
  renderChat();
}

function removeChatFile() {
  if (chatBusy || sourceBusy) return;
  pendingAttachment = null;
  $("chat-file-input").value = "";
  setChatStatus("Attached file removed; it was not analyzed.");
  renderChat();
}

async function analyzeChatFile() {
  if (chatBusy || sourceBusy || !pendingAttachment) return;
  if (!sourceCapabilities) await loadSourceCapabilities();
  if (sourceCapabilities?.localImport?.available !== true) {
    setChatStatus("File analysis is unavailable on this deployment.", true);
    return;
  }
  const file = pendingAttachment;
  setSourceBusy(true, "Reading the attached file locally…");
  let parsed;
  try { parsed = await readLocalFile(file); }
  catch (error) {
    sourceBusy = false;
    updateSourceControls();
    renderChat();
    setChatStatus(error.message || "The attached file could not be read.", true);
    return;
  }
  sourceBusy = false;
  const name = (file.name + (localFileKind(file) === "pdf" ? " · PDF text" : "")).slice(0, 120);
  const success = await analyzeSources("/api/sources/analyze", { name, kind: parsed.kind, content: parsed.content, sample: false }, file.name, "File · supplied by you" + (parsed.truncated ? " · excerpt" : ""), true);
  if (success) {
    pendingAttachment = null;
    $("chat-file-input").value = "";
    renderChat();
    if (parsed.truncated) setChatStatus("The first 8,000 characters were analyzed and added to chat. The rest of the file was not sent.");
    $("chat-input").focus();
  }
}

async function analyzeLocalFile(event) {
  event.preventDefault();
  if (sourceBusy || chatBusy || !sourceCapabilities?.localImport?.available) return;
  const file = $("local-source-file").files?.[0];
  if (!file) return;
  setSourceBusy(true, "Reading the selected file locally…");
  let parsed;
  try { parsed = await readLocalFile(file); }
  catch (error) {
    sourceBusy = false;
    updateSourceControls();
    renderChat();
    setSourceStatus(error.message || "This file could not be read.", true);
    return;
  }
  sourceBusy = false;
  const registry = SOURCE_REGISTRY.find((item) => item.id === manualImportKind);
  const label = registry ? registry.name + " manual export · " + file.name : file.name;
  const kind = registry ? registry.id : parsed.kind;
  const name = label.slice(0, 120);
  await analyzeSources("/api/sources/analyze", { name, kind, content: parsed.content, sample: false }, label, (registry ? "Manual export · no account link" : "Local file · supplied by you") + (parsed.truncated ? " · excerpt" : ""));
  $("local-source-file").value = "";
  manualImportKind = null;
  $("source-import-hint").hidden = true;
  updateSourceControls();
}

function analyzeGithub(event) {
  event.preventDefault();
  if (sourceBusy || chatBusy || sourceCapability("github")?.available !== true) return;
  const repository = $("github-repository").value.trim();
  if (!repository) return;
  if (!/^(?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    setSourceStatus("Enter owner/repo or a public https://github.com/owner/repo URL.", true);
    return;
  }
  analyzeSources("/api/sources/github", { repository }, repository, "Public GitHub · README and metadata");
}

async function handleSourceCardClick(event) {
  const connect = event.target.closest("button[data-connector-connect]");
  if (connect) {
    const id = connect.dataset.connectorConnect;
    if (!accountReady || !accountSession.authenticated) return;
    if (!sourceBusy && !chatBusy && connectorState(id)?.configured && !connectorState(id)?.connected) {
      pendingConnectorId = id;
      window.open("/api/connectors/" + encodeURIComponent(id) + "/start", "_blank", "noopener");
      setSourceStatus("Continue in the new tab. Your connection will appear here when you return.");
    }
    return;
  }
  const browse = event.target.closest("button[data-connector-browse]");
  if (browse) { await browseConnector(browse.dataset.connectorBrowse); return; }
  const disconnect = event.target.closest("button[data-connector-disconnect]");
  if (disconnect) {
    const id = disconnect.dataset.connectorDisconnect;
    if (sourceBusy || chatBusy || !connectorState(id)?.connected) return;
    setSourceBusy(true, "Disconnecting your account…");
    try {
      await postJson("/api/connectors/" + encodeURIComponent(id) + "/disconnect", {});
      if (activeConnectorId === id) closeConnectorItems();
      await loadConnectorStatus();
      setSourceStatus("Account disconnected. Previously analyzed summaries remain in this page session until removed or New chat.");
    } catch (error) {
      setSourceStatus(error.message || "Could not disconnect the account.", true);
    } finally {
      sourceBusy = false;
      updateSourceControls();
      renderChat();
    }
    return;
  }
  const manual = event.target.closest("button[data-manual-import]");
  if (manual) {
    manualImportKind = manual.dataset.manualImport;
    const registry = SOURCE_REGISTRY.find((item) => item.id === manualImportKind);
    $("source-import-hint").textContent = "Manual " + (registry?.name || "workspace") + " export. No account connection is made; choose a text file you exported yourself.";
    $("source-import-hint").hidden = false;
    $("local-source-file").scrollIntoView({ block: "center", behavior: "smooth" });
    $("local-source-file").focus();
    return;
  }
  if (event.target.closest("button[data-goto-github]")) {
    $("github-repository").scrollIntoView({ block: "center", behavior: "smooth" });
    $("github-repository").focus();
  }
}

function handleSourceSelection(event) {
  const input = event.target.closest("input[data-source-select]");
  if (!input || sourceBusy || chatBusy) return;
  const entry = sourceEntries.find((item) => item.id === input.dataset.sourceSelect);
  if (!entry) return;
  if (input.checked && selectedSourceEntries().length >= SOURCE_CONTEXT_LIMIT) {
    input.checked = false;
    setSourceStatus("Select at most " + SOURCE_CONTEXT_LIMIT + " summaries for chat.", true);
    return;
  }
  entry.selected = input.checked;
  setSourceStatus(entry.selected ? "Source summary selected for subsequent chat messages." : "Source summary removed from chat context.");
  renderActiveSources();
  updateSourceControls();
  scheduleConversationAutosave();
}

function handleSourceRemove(event) {
  const button = event.target.closest("button[data-source-remove]");
  if (!button || sourceBusy || chatBusy) return;
  sourceEntries = sourceEntries.filter((entry) => entry.id !== button.dataset.sourceRemove);
  renderSourceResults();
  setSourceStatus("Summary removed from this page session. Related chat replies remain until New chat.");
}

function discussSelectedSources() {
  if (sourceBusy || chatBusy || !selectedSourceEntries().length) return;
  closeSources();
  $("open-sources").focus();
  submitChatMessage("Using the project source summaries I selected, separate observed facts from assumptions, identify the riskiest gap, and propose one small next mission with expected evidence. Do not invent outcomes or claim an external action was completed.");
}

// The conversation is separate from the optional, structured decision canvas.
// Only completed exchanges are sent back to AdaL as context; the backend stores no transcript.
const CHAT_STORAGE_KEY = "bueeld-lab-chat-v2";
const MISSION_STORAGE_KEY = "bueeld-lab-pinned-mission-v1";
const CHAT_LIMIT = 1500;
const CHAT_REQUEST_BUDGET_BYTES = 28000;
const EVIDENCE_PREFIX = "Evidence for our pinned mission: ";
let chatBusy = false;

function loadChatMessages(key = currentStorageKey(CHAT_STORAGE_KEY)) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter((item) => item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" && item.content.trim() && item.content.length <= 6000 &&
      Number.isFinite(item.at)
    ).slice(-60).map((item) => ({
      id: typeof item.id === "string" ? item.id : String(item.at),
      role: item.role,
      content: item.content,
      at: item.at,
      status: item.role === "assistant" ? "complete" : item.status === "complete" ? "complete" : "failed"
    }));
  } catch {
    return [];
  }
}

let chatMessages = [];

function loadPinnedMission(key = currentStorageKey(MISSION_STORAGE_KEY)) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (!saved || typeof saved !== "object" || Array.isArray(saved) ||
        typeof saved.content !== "string" || !saved.content.trim() || saved.content.length > CHAT_LIMIT ||
        !["proposed", "approved"].includes(saved.status) ||
        typeof saved.sourceMessageId !== "string" || !saved.sourceMessageId ||
        !Number.isFinite(saved.pinnedAt)) return null;
    return {
      content: saved.content.trim(),
      status: saved.status,
      sourceMessageId: saved.sourceMessageId,
      pinnedAt: saved.pinnedAt
    };
  } catch {
    return null;
  }
}

let pinnedMission = null;
let pinCandidate = null;

function persistPinnedMission() {
  try {
    if (pinnedMission) localStorage.setItem(currentStorageKey(MISSION_STORAGE_KEY), JSON.stringify(pinnedMission));
    else localStorage.removeItem(currentStorageKey(MISSION_STORAGE_KEY));
    $("chat-storage-warning").hidden = true;
  } catch {
    $("chat-storage-warning").hidden = false;
  }
  scheduleConversationAutosave();
}


const MISSION_TRACKER_STORAGE_KEY = "bueeld-lab-mission-tracker-v1";
const MISSION_AREAS = [
  ["need", "Customer need"],
  ["demand", "Demand"],
  ["delivery", "Delivery"],
  ["economics", "Business model"]
];
const MISSION_OUTCOMES = ["met", "missed", "inconclusive"];

function loadMissionTracker() {
  try {
    const saved = JSON.parse(localStorage.getItem(currentStorageKey(MISSION_TRACKER_STORAGE_KEY)) || "null");
    const records = Array.isArray(saved?.records) ? saved.records.filter((item) =>
      item && typeof item.id === "string" && item.id &&
      typeof item.content === "string" && item.content.trim() && item.content.length <= CHAT_LIMIT &&
      ["proposed", "approved", "completed"].includes(item.status) &&
      Number.isFinite(item.createdAt)
    ).slice(-100).map((item) => ({
      id: item.id,
      content: item.content.trim(),
      status: item.status === "completed" && (!item.evidence || item.evidence.length < 30) ? "approved" : item.status,
      createdAt: item.createdAt,
      approvedAt: Number.isFinite(item.approvedAt) ? item.approvedAt : null,
      evidence: typeof item.evidence === "string" ? item.evidence.slice(0, CHAT_LIMIT) : "",
      evidenceAt: Number.isFinite(item.evidenceAt) ? item.evidenceAt : null,
      area: MISSION_AREAS.some(([id]) => id === item.area) ? item.area : "",
      outcome: MISSION_OUTCOMES.includes(item.outcome) ? item.outcome : "",
      realEvidence: item.realEvidence === true,
      completedAt: Number.isFinite(item.completedAt) ? item.completedAt : null,
      learning: typeof cleanMissionLearning === "function" ? cleanMissionLearning(item.learning) : null
    })) : [];
    return { records, seenLevel: Number.isInteger(saved?.seenLevel) && saved.seenLevel > 0 ? saved.seenLevel : 1 };
  } catch {
    return { records: [], seenLevel: 1 };
  }
}

let missionTracker = { records: [], seenLevel: 1 };
let missionOpener = null;
let missionEvidenceExpanded = false;
let missionEvidenceForId = null;
// Disclosure state is independent of the pinned context and unsaved result fields.
let expandedMissionId = null;
let recentMissionCompletionId = null;

function persistMissionTracker() {
  try {
    localStorage.setItem(currentStorageKey(MISSION_TRACKER_STORAGE_KEY), JSON.stringify(missionTracker));
  } catch {
    $("mission-feedback").textContent = "Browser storage is unavailable. Mission progress may be lost when this page closes.";
  }
  if (accountSession.authenticated && !autosaveMuted) { missionDirty = true; missionRevision += 1; scheduleMissionSync(); }
}

function ensureMissionRecord(mission) {
  if (!mission) return null;
  let record = missionTracker.records.find((item) => item.id === mission.sourceMessageId);
  if (!record) {
    record = {
      id: mission.sourceMessageId, content: mission.content, status: mission.status,
      createdAt: mission.pinnedAt, approvedAt: mission.status === "approved" ? Date.now() : null,
      evidence: "", evidenceAt: null, area: "", outcome: "", realEvidence: false, completedAt: null, learning: null
    };
    missionTracker.records.push(record);
    persistMissionTracker();
  } else if (record.status !== "completed") {
    if (record.content !== mission.content) {
      record.content = mission.content;
      record.status = mission.status;
      record.approvedAt = mission.status === "approved" ? Date.now() : null;
      record.evidence = ""; record.evidenceAt = null; record.area = ""; record.outcome = ""; record.realEvidence = false;
      record.learning = null;
      persistMissionTracker();
    }
    if (mission.status === "approved" && record.status === "proposed") {
      record.status = "approved";
      record.approvedAt = Date.now();
      persistMissionTracker();
    }
  }
  return record;
}

function missionStats() {
  const records = [...new Map(missionTracker.records.map((item) => [item.id, item])).values()];
  const qualified = records.filter((item) => item.status === "completed" && item.realEvidence && item.evidence.length >= 30 && MISSION_AREAS.some(([id]) => id === item.area) && MISSION_OUTCOMES.includes(item.outcome));
  const gateCount = Math.floor(qualified.length / 2);
  const covered = new Set(qualified.map((item) => item.area));
  return {
    xp: qualified.length * 25,
    drops: gateCount * 10,
    level: gateCount + 1,
    maturity: MISSION_AREAS.filter(([id]) => covered.has(id)).length * 25,
    covered,
    toNextLevel: 2 - (qualified.length % 2)
  };
}

function activeMissionRecord() {
  return pinnedMission && missionTracker.records.find((item) => item.id === pinnedMission.sourceMessageId && item.status !== "completed") || null;
}

function reconcilePinnedMission() {
  if (!pinnedMission) return;
  const record = missionTracker.records.find((item) => item.id === pinnedMission.sourceMessageId);
  if (record?.status === "completed") {
    pinnedMission = null;
    persistPinnedMission();
  } else if (record) {
    if (pinnedMission.content !== record.content || pinnedMission.status !== record.status) {
      pinnedMission = { ...pinnedMission, content: record.content, status: record.status };
      persistPinnedMission();
    }
  } else {
    ensureMissionRecord(pinnedMission);
  }
}

function missionReminders(stats, current) {
  const reminders = [];
  if (stats.level > missionTracker.seenLevel) reminders.push("Level " + stats.level + " reached. The gate added 10 local Lab drops.");
  if (current?.status === "proposed") reminders.push("A proposed mission needs your approval before evidence can be recorded.");
  else if (current?.status === "approved" && !current.evidence) reminders.push("Your approved mission needs observed evidence.");
  else if (current?.status === "approved" && current.evidence) reminders.push("Evidence is saved. Review it, then decide whether the test is complete.");
  return reminders;
}

function latestMissionChatEvidence() {
  const current = activeMissionRecord();
  const message = [...chatMessages].reverse().find((item) => current && item.role === "user" && item.status === "complete" && item.at >= Math.max(current.approvedAt || current.createdAt, pinnedMission.pinnedAt) && item.content.startsWith(EVIDENCE_PREFIX));
  return message ? message.content.slice(EVIDENCE_PREFIX.length).trim() : "";
}

function missionFocus(content) {
  const original = String(content).replace(/\*\*/g, "").replace(/^#{1,3}\s*/gm, "").split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s*/, "")).filter(Boolean);
  const lines = (missionCandidateFromReply(content) || content).replace(/\*\*/g, "").replace(/^#{1,3}\s*/gm, "").split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s*/, "")).filter(Boolean);
  const heading = (lines.find((line) => /^Mission\s*:/i.test(line)) || lines[0] || "Next mission").replace(/^Mission\s*:\s*/i, "").trim();
  const action = (lines.find((line) => /^Action\s*:/i.test(line)) || lines.find((line) => line !== lines[0] && !/^(?:Owner|Timebox|Expected evidence|Evidence|Human decision point)\s*:/i.test(line)) || "").replace(/^Action\s*:\s*/i, "").trim();
  return { heading: heading.slice(0, 150), action: (action || "Review the full mission details before acting.").slice(0, 500), full: original.join("\n") };
}

function renderMissionTracker() {
  const stats = missionStats();
  const current = activeMissionRecord();
  const missionChanged = (current?.id || null) !== missionEvidenceForId;
  if (missionChanged) {
    missionEvidenceForId = current?.id || null;
    missionEvidenceExpanded = false;
    $("mission-current-details").open = false;
    setMissionFeedback("");
  }
  $("mission-maturity").textContent = stats.covered.size + " / 4";
  $("mission-maturity-progress").value = stats.maturity;
  $("mission-maturity-progress").textContent = stats.maturity + "%";
  $("mission-maturity-progress").setAttribute("aria-valuetext", stats.covered.size + " of 4 areas explored");
  $("mission-level").textContent = String(stats.level);
  $("mission-level-badge").textContent = String(stats.level);
  $("mission-level-progress").value = 2 - stats.toNextLevel;
  $("mission-level-progress").textContent = (2 - stats.toNextLevel) + " / 2 real tests";
  $("mission-level-next").textContent = stats.toNextLevel + (stats.toNextLevel === 1 ? " test" : " tests") + " to level " + (stats.level + 1);
  $("mission-xp").textContent = String(stats.xp);
  $("mission-drops").textContent = String(stats.drops);
  $("mission-coverage-count").textContent = stats.covered.size + " / " + MISSION_AREAS.length;
  const coverageLabels = { need: "Need", demand: "Demand", delivery: "Delivery", economics: "Business" };
  $("mission-coverage").replaceChildren(...MISSION_AREAS.map(([id, label]) => {
    const covered = stats.covered.has(id);
    const item = el("span", "mission-coverage-item" + (covered ? " is-covered" : ""));
    item.setAttribute("role", "img");
    item.setAttribute("aria-label", label + " · " + (covered ? "documented" : "no completed evidence"));
    const marker = el("img", "mission-coverage-marker");
    marker.src = covered ? "/assets/icons/progress-check-circle.svg" : "/assets/icons/progress-circle.svg";
    marker.alt = "";
    marker.setAttribute("aria-hidden", "true");
    item.append(marker, el("span", "mission-coverage-label", coverageLabels[id]));
    return item;
  }));

  const reminders = missionReminders(stats, current);
  const levelNotice = reminders.filter((message) => message.startsWith("Level "));
  $("mission-notices").replaceChildren(...levelNotice.map((message) => el("li", "", message)));
  $("mission-notice-section").hidden = levelNotice.length === 0;
  $("mission-nav-badge").hidden = !missionTracker.records.length;
  $("mission-nav-badge").textContent = "Lv " + stats.level;
  $("open-missions").setAttribute("aria-label", "Progress, level " + stats.level + ", " + stats.xp + " Lab XP");

  if (!current || expandedMissionId !== current.id) expandedMissionId = null;
  $("mission-conversation").hidden = !current || expandedMissionId !== current.id;
  $("mission-current-empty").hidden = !!current;
  $("mission-return-chat").hidden = !current;
  $("mission-current").hidden = !current;
  $("mission-current-status").textContent = current ? (current.status === "approved" ? (current.evidence ? "Result saved" : "In progress") : "For your approval") : "";
  $("mission-chat-empty").hidden = !!current || chatMessages.length === 0;
  if (current) {
    const focus = missionFocus(current.content);
    $("mission-current-heading").textContent = focus.heading;
    $("mission-current-content").textContent = focus.action;
    $("mission-current-content").hidden = focus.action.startsWith("Review the full mission") || focus.action === focus.heading;
    $("mission-current-full").textContent = focus.full;
    $("mission-current-details").hidden = focus.full.length < 20;
    $("mission-current-approve").hidden = current.status === "approved";
    $("mission-add-evidence").hidden = current.status !== "approved";
    $("mission-add-evidence").textContent = missionEvidenceExpanded ? "Close result" : current.evidence ? "Edit result" : "Add my result";
    $("mission-current-approve").disabled = chatBusy || sourceBusy;
    $("mission-current-discuss").disabled = current.status !== "approved" || chatBusy || sourceBusy;
    $("mission-proof-form").hidden = current.status !== "approved" || !missionEvidenceExpanded;
    if (missionChanged || !missionEvidenceExpanded) {
      $("mission-evidence-entry").value = current.evidence;
      $("mission-evidence-area").value = current.area;
      $("mission-evidence-outcome").value = current.outcome;
      $("mission-real-evidence").checked = current.realEvidence;
    }
    $("mission-use-chat-evidence").disabled = !latestMissionChatEvidence();
    $("mission-completion").hidden = current.status !== "approved" || !current.evidence || missionEvidenceExpanded;
    $("mission-saved-evidence").textContent = current.evidence;
    $("mission-complete").textContent = current.realEvidence ? "Complete mission · +25 XP" : "Complete demo · no XP";
    $("mission-complete").dataset.missionId = current.id;
    $("mission-complete").disabled = missionEvidenceExpanded;
    const step = current.status !== "approved" ? 0 : current.evidence ? 2 : 1;
    for (const [index, node] of [...$("mission-steps").children].entries()) {
      node.classList.toggle("is-done", index < step);
      node.classList.toggle("is-current", index === step);
      if (index === step) node.setAttribute("aria-current", "step");
      else node.removeAttribute("aria-current");
    }
  }
  renderMissionReward(stats);

  const history = [...missionTracker.records].reverse().map((record) => {
    const row = el("li", "mission-history-item");
    const meta = el("div", "mission-history-meta");
    const label = record.status === "completed"
      ? (record.realEvidence ? "Completed · self-reported" : "Demo completed · no points")
      : (record.status === "approved" ? "Approved · awaiting evidence" : "Proposed");
    meta.append(el("strong", "", label), el("time", "", new Date(record.createdAt).toLocaleDateString()));
    row.append(meta, el("p", "", record.content.replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 180)));
    const actions = el("div", "mission-history-actions");
    const button = el("button", "mission-text-button", record.status === "completed" ? "Reopen" : "Resume");
    button.type = "button";
    button.dataset.missionAction = record.status === "completed" ? "reopen" : "resume";
    button.dataset.missionId = record.id;
    actions.append(button);
    row.append(actions);
    return row;
  });
  $("mission-history-list").replaceChildren(...(history.length ? history : [el("li", "mission-history-empty", "No missions recorded yet.")]));
  $("mission-history-count").textContent = String(history.length);
  $("mission-clear-history").disabled = missionTracker.records.length === 0;
  renderPinnedMission();
  if (typeof renderGrowthMissionFeatures === "function") renderGrowthMissionFeatures();
}

function latestConversationMissionResult() {
  const messageIds = new Set(chatMessages.map((message) => message.id));
  return missionTracker.records.filter((record) => record.status === "completed" && (messageIds.has(record.id) || record.id === recentMissionCompletionId))
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))[0] || null;
}

function renderMissionReward(stats = missionStats()) {
  const completed = latestConversationMissionResult();
  const card = $("mission-reward-card");
  card.hidden = !completed || !!activeMissionRecord();
  if (card.hidden) return;
  $("mission-chat-empty").hidden = true;
  const earned = completed.realEvidence && completed.evidence.length >= 30 && MISSION_AREAS.some(([id]) => id === completed.area) && MISSION_OUTCOMES.includes(completed.outcome);
  const qualified = [...new Map(missionTracker.records.map((record) => [record.id, record])).values()]
    .filter((record) => record.status === "completed" && record.realEvidence && record.evidence.length >= 30 && MISSION_AREAS.some(([id]) => id === record.area) && MISSION_OUTCOMES.includes(record.outcome))
    .sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
  const ordinal = qualified.findIndex((record) => record.id === completed.id) + 1;
  const levelUp = earned && ordinal > 0 && ordinal % 2 === 0;
  $("mission-reward-title").textContent = levelUp ? "Level " + (ordinal / 2 + 1) + " unlocked." : earned ? "One step further." : "Demo mission complete.";
  $("mission-reward-value").textContent = levelUp ? "+25 XP · +10 drops" : earned ? "+25 XP" : "Practice run";
  const outcome = { met: "Target met", missed: "Target missed — useful learning", inconclusive: "Inconclusive — learning recorded" }[completed.outcome] || "Result recorded";
  $("mission-reward-description").textContent = missionFocus(completed.content).heading + " · " + outcome;
  $("mission-reward-progress").value = stats.xp % 50;
  $("mission-reward-next").textContent = earned
    ? "Level " + stats.level + " · " + stats.xp + " XP total · " + (stats.toNextLevel * 25) + " XP to your next level + 10 drops"
    : "Fictional results earn no XP or drops. Real learning counts, even when a target is missed.";
}

function collapseMissionInChat() {
  if (!expandedMissionId) return;
  expandedMissionId = null;
  renderMissionTracker();
}

function toggleMissionInChat() {
  if (expandedMissionId && expandedMissionId === activeMissionRecord()?.id) {
    collapseMissionInChat();
    $("mission-open-tracker").focus();
  } else focusMissionInChat();
}

function focusMissionInChat() {
  if (!$("mission-drawer").hidden) closeMissionTracker();
  expandedMissionId = activeMissionRecord()?.id || null;
  renderMissionTracker();
  const card = activeMissionRecord() ? $("mission-conversation") : !$("mission-reward-card").hidden ? $("mission-reward-card") : $("mission-chat-empty");
  if (card.hidden) { prepareNextMission(); return; }
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.focus({ preventScroll: true });
}

function prepareNextMission() {
  closeMissionTracker();
  if (typeof cleanMissionLearning === "function" && cleanMissionLearning(latestConversationMissionResult()?.learning)) { planFromLearning(); return; }
  const input = $("chat-input");
  if (!input.value.trim()) {
    const completed = latestConversationMissionResult();
    const result = completed ? "Last mission: " + missionFocus(completed.content).heading + ".\n" +
      (completed.realEvidence ? "Self-reported result: " : "Fictional demo result: ") + completed.evidence.slice(0, 900) + "\nOutcome: " + completed.outcome + ".\n\n" : "";
    input.value = result + "Based on our conversation and results so far, help me choose one small next mission, with an owner, deadline and evidence to bring back. Ask for missing facts.";
  }
  renderChat();
  input.focus();
}

function openMissionEvidence(evidence) {
  const current = activeMissionRecord();
  if (!current || current.status !== "approved") return;
  expandedMissionId = current.id;
  if (missionEvidenceForId !== current.id) renderMissionTracker();
  missionEvidenceExpanded = true;
  renderMissionTracker();
  if (typeof evidence === "string") $("mission-evidence-entry").value = evidence.slice(0, CHAT_LIMIT);
  $("mission-proof-form").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("mission-evidence-entry").focus({ preventScroll: true });
}

function setMissionFeedback(message, isError = false) {
  $("mission-feedback").textContent = message;
  $("mission-feedback").classList.toggle("is-error", isError);
}

function openMissionTracker() {
  if (!$("account-drawer").hidden) closeAccount();
  if (!$("source-drawer").hidden) closeSources();
  if (!$("decision-drawer").hidden) closeDecisionCanvas();
  if (!$("mission-drawer").hidden) return;
  missionOpener = document.activeElement;
  $("mission-drawer").hidden = false;
  document.body.classList.add("mission-open");
  const level = missionStats().level;
  if (level > missionTracker.seenLevel) {
    missionTracker.seenLevel = level;
    persistMissionTracker();
  }
  renderMissionTracker();
  $("mission-panel").focus();
}

function closeMissionTracker() {
  $("mission-drawer").hidden = true;
  document.body.classList.remove("mission-open");
  if (missionOpener instanceof HTMLElement) missionOpener.focus();
}

function resumeMissionRecord(record) {
  if (!record || record.status === "completed") return;
  pinnedMission = {
    content: record.content, status: record.status,
    sourceMessageId: record.id, pinnedAt: Date.now()
  };
  persistPinnedMission();
  renderChat();
  renderMissionTracker();
}

function saveMissionEvidence(event) {
  event.preventDefault();
  const current = activeMissionRecord();
  if (!current || current.status !== "approved") return;
  const evidence = $("mission-evidence-entry").value.trim();
  const area = $("mission-evidence-area").value;
  const outcome = $("mission-evidence-outcome").value;
  if (evidence.length < 30 || evidence.length > CHAT_LIMIT) {
    setMissionFeedback("Describe at least 30 characters of observed evidence, up to 1,500 characters.", true);
    return;
  }
  if (!MISSION_AREAS.some(([id]) => id === area) || !MISSION_OUTCOMES.includes(outcome)) {
    setMissionFeedback("Choose an evidence area and the observed test outcome.", true);
    return;
  }
  current.evidence = evidence;
  current.evidenceAt = Date.now();
  current.area = area;
  current.outcome = outcome;
  current.realEvidence = $("mission-real-evidence").checked;
  current.learning = null;
  persistMissionTracker();
  expandedMissionId = current.id;
  missionEvidenceExpanded = false;
  renderMissionTracker();
  setMissionFeedback(current.realEvidence
    ? "Evidence saved locally. Review it before marking this test complete."
    : "Demo evidence saved. This test will not earn points or count toward areas explored.");
  $("mission-complete").focus();
}

function completeMissionRecord() {
  const current = activeMissionRecord();
  if (!current || $("mission-complete").dataset.missionId !== current.id || current.status !== "approved" || current.evidence.length < 30 || !current.area || !current.outcome) return;
  if ($("mission-evidence-entry").value.trim() !== current.evidence ||
      $("mission-evidence-area").value !== current.area ||
      $("mission-evidence-outcome").value !== current.outcome ||
      $("mission-real-evidence").checked !== current.realEvidence) {
    setMissionFeedback("Save your evidence changes before completing this test.", true);
    return;
  }
  const before = missionStats();
  current.status = "completed";
  current.completedAt = Date.now();
  recentMissionCompletionId = current.id;
  missionEvidenceExpanded = false;
  if (pinnedMission?.sourceMessageId === current.id) {
    pinnedMission = null;
    persistPinnedMission();
  }
  persistMissionTracker();
  const after = missionStats();
  renderChat();
  renderMissionTracker();
  const reward = current.realEvidence ? " +25 Lab XP." : " No Lab points were added because this was marked as demo evidence.";
  const gate = after.level > before.level ? " Level " + after.level + " reached; +10 local Lab drops." : "";
  setMissionFeedback("Test marked complete with a " + current.outcome + " outcome." + reward + gate);
  setChatStatus("Mission complete." + reward + gate);
  $("mission-reward-card").scrollIntoView({ block: "nearest", behavior: "smooth" });
  $("mission-reward-card").focus({ preventScroll: true });
}

function handleMissionHistory(event) {
  const button = event.target.closest("button[data-mission-action]");
  if (!button) return;
  const record = missionTracker.records.find((item) => item.id === button.dataset.missionId);
  if (!record) return;
  if (button.dataset.missionAction === "reopen" && record.status === "completed") {
    record.status = "approved";
    record.completedAt = null;
    persistMissionTracker();
    resumeMissionRecord(record);
    setMissionFeedback("Mission reopened. Its Lab points and evidence coverage were recalculated.");
  } else if (button.dataset.missionAction === "resume") {
    resumeMissionRecord(record);
    setMissionFeedback("Mission resumed in your chat context.");
  }
  focusMissionInChat();
}

function clearMissionHistory() {
  if (!missionTracker.records.length) return;
  if (!window.confirm("Clear local mission history, Lab points, drops, and the current pinned mission? Chat messages will remain.")) return;
  missionTracker.records = [];
  missionTracker.seenLevel = 1;
  recentMissionCompletionId = null;
  pinnedMission = null;
  persistMissionTracker();
  persistPinnedMission();
  renderChat();
  renderMissionTracker();
  setMissionFeedback("Local mission history cleared. Chat messages remain in this browser.");
}

reconcilePinnedMission();
renderMissionTracker();
$("open-missions").addEventListener("click", openMissionTracker);
$("mission-close").addEventListener("click", closeMissionTracker);
$("mission-backdrop").addEventListener("click", closeMissionTracker);
$("mission-ask-lia").addEventListener("click", prepareNextMission);
$("mission-chat-ask").addEventListener("click", prepareNextMission);
$("mission-next-chat").addEventListener("click", prepareNextMission);
$("mission-reward-history").addEventListener("click", openMissionTracker);
$("mission-return-chat").addEventListener("click", focusMissionInChat);
$("mission-open-tracker").addEventListener("click", toggleMissionInChat);
$("mission-evidence-cancel").addEventListener("click", () => {
  missionEvidenceExpanded = false;
  renderMissionTracker();
  $("mission-add-evidence").focus();
});
$("mission-current-approve").addEventListener("click", () => {
  const current = activeMissionRecord();
  if (!current) return;
  if (!pinnedMission || pinnedMission.sourceMessageId !== current.id) resumeMissionRecord(current);
  approvePinnedMission();
});
$("mission-add-evidence").addEventListener("click", () => {
  const current = activeMissionRecord();
  if (!current || current.status !== "approved") return;
  if (missionEvidenceExpanded) {
    missionEvidenceExpanded = false;
    renderMissionTracker();
  } else openMissionEvidence();
});
$("mission-current-discuss").addEventListener("click", () => {
  const current = activeMissionRecord();
  if (!current || current.status !== "approved") return;
  if (!pinnedMission || pinnedMission.sourceMessageId !== current.id) resumeMissionRecord(current);
  closeMissionTracker();
  bringMissionEvidence();
  if (current.evidence) {
    $("chat-input").value = EVIDENCE_PREFIX + current.evidence.slice(0, CHAT_LIMIT - EVIDENCE_PREFIX.length);
    renderChat();
    $("chat-input").focus();
  }
});
$("mission-use-chat-evidence").addEventListener("click", () => {
  const evidence = latestMissionChatEvidence();
  if (!evidence) return;
  $("mission-evidence-entry").value = evidence.slice(0, CHAT_LIMIT);
  $("mission-evidence-entry").focus();
  setMissionFeedback("Copied your latest chat evidence. Check it, choose an area and outcome, then save.");
});
$("mission-proof-form").addEventListener("submit", saveMissionEvidence);
for (const eventName of ["input", "change"]) $("mission-proof-form").addEventListener(eventName, () => {
  if (!$("mission-completion").hidden) {
    $("mission-complete").disabled = true;
    setMissionFeedback("Evidence changed. Save it again before marking the test complete.");
  }
});
$("mission-complete").addEventListener("click", completeMissionRecord);
$("mission-history-list").addEventListener("click", handleMissionHistory);
$("mission-clear-history").addEventListener("click", clearMissionHistory);
$("mission-drawer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeMissionTracker(); return; }
  if (event.key !== "Tab") return;
  const controls = [...$("mission-drawer").querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]")]
    .filter((node) => node.getClientRects().length > 0 && node.tabIndex >= 0 && node.id !== "mission-backdrop");
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $("mission-panel"))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $("mission-panel"))) { event.preventDefault(); first.focus(); }
});


function renderPinnedMission() {
  const bar = $("mission-bar");
  const current = activeMissionRecord();
  bar.hidden = !current;
  const expanded = !!current && expandedMissionId === current.id;
  bar.classList.toggle("is-collapsed", !expanded);
  $("mission-open-tracker").setAttribute("aria-expanded", String(expanded));
  $("mission-open-tracker").setAttribute("aria-controls", "mission-conversation");
  $("mission-open-tracker").textContent = expanded ? "Hide mission" : "Current mission";
  if (!current) return;
  $("mission-status").textContent = current.status === "proposed" ? "NEXT MISSION" : "IN PROGRESS";
  $("mission-excerpt").textContent = missionFocus(current.content).heading;
  $("mission-approve").hidden = true;
  $("mission-evidence").hidden = current.status !== "approved" || !!current.evidence;
  $("mission-evidence").textContent = "Add result";
}

function persistChat() {
  try {
    localStorage.setItem(currentStorageKey(CHAT_STORAGE_KEY), JSON.stringify(chatMessages));
    $("chat-storage-warning").hidden = true;
  } catch {
    $("chat-storage-warning").hidden = false;
  }
  scheduleConversationAutosave();
}

function setChatStatus(message, isError = false) {
  const status = $("chat-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function scrollChatToLatest() {
  requestAnimationFrame(() => {
    const transcript = $("chat-transcript");
    transcript.scrollTop = transcript.scrollHeight;
  });
}

function appendInlineMarkdown(parent, source) {
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("**", cursor);
    if (start === -1) {
      parent.append(document.createTextNode(source.slice(cursor)));
      return;
    }
    const end = source.indexOf("**", start + 2);
    if (end === -1 || end === start + 2) {
      parent.append(document.createTextNode(source.slice(cursor)));
      return;
    }
    if (start > cursor) parent.append(document.createTextNode(source.slice(cursor, start)));
    const strong = document.createElement("strong");
    strong.textContent = source.slice(start + 2, end);
    parent.append(strong);
    cursor = end + 2;
  }
}

function appendAssistantMarkdown(container, source) {
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const node = document.createElement("p");
    paragraph.forEach((line, index) => {
      if (index) node.append(document.createElement("br"));
      appendInlineMarkdown(node, line);
    });
    container.append(node);
    paragraph = [];
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      list = null;
      continue;
    }
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      list = null;
      const node = document.createElement("h3");
      appendInlineMarkdown(node, heading[1]);
      container.append(node);
      continue;
    }
    const bullet = line.match(/^\s{0,3}[-*]\s+(.+)$/);
    const numbered = line.match(/^\s{0,3}(\d+)[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const item = document.createElement("li");
      if (numbered) item.value = Number(numbered[1]);
      appendInlineMarkdown(item, bullet ? bullet[1] : numbered[2]);
      list.append(item);
      continue;
    }
    if (list && /^\s{2,}/.test(rawLine)) {
      const item = list.lastElementChild;
      item.append(document.createElement("br"));
      appendInlineMarkdown(item, line.trim());
      continue;
    }
    list = null;
    paragraph.push(line.trim());
  }
  flushParagraph();
}

function resizeChatInput() {
  const input = $("chat-input");
  input.style.height = "44px";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 44), 144)}px`;
}

const onboarding = { active: false, step: 0, answers: [], renderedStep: -1 };

function onboardingQuestion() {
  const existing = onboarding.answers[0] === "Existing project" || /\b(existing|existant|already|running|actuel)\b|déjà/i.test(onboarding.answers[0] || "");
  const questions = [
    { title: "What are you working on?", help: "Choose a starting point. You can also describe it in your own words.", options: ["A new idea", "Existing project"] },
    existing
      ? { title: "What does your project do, and who is it for?", help: "A short description is enough; you can refine it with Lia.", options: ["Helping founders", "Serving small businesses", "Building for teams"] }
      : { title: "Who do you hope to help?", help: "Name an audience only if you have one in mind.", options: ["Founders", "Small businesses", "Teams"] },
    { title: "What evidence do you have so far?", help: "Include what remains uncertain. Never count a plan as a result.", options: ["No validation yet", "Conversations or notes", "Early users or sales"] },
    { title: "What should we unblock this week?", help: "Name a blocker or the next decision you want Lia to help with.", options: ["Find users and choose a test", "Focus the product", "Challenge a decision"] }
  ];
  return questions[onboarding.step];
}

function renderOnboarding() {
  const panel = $("chat-onboarding");
  const wasHidden = panel.hidden;
  panel.hidden = !onboarding.active;
  if (!onboarding.active) return;
  const question = onboardingQuestion();
  $("onboarding-progress").textContent = `GETTING STARTED · ${onboarding.step + 1} / 4`;
  $("onboarding-question").textContent = question.title;
  $("onboarding-help").textContent = question.help;
  $("onboarding-options").replaceChildren(...question.options.map((option) => {
    const button = el("button", "", option);
    button.type = "button";
    button.dataset.onboardingAnswer = option;
    return button;
  }));
  if (wasHidden || onboarding.renderedStep !== onboarding.step) {
    $("onboarding-input").value = onboarding.answers[onboarding.step] === "Unknown" ? "" : (onboarding.answers[onboarding.step] || "");
    onboarding.renderedStep = onboarding.step;
  }
  $("onboarding-back").disabled = onboarding.step === 0;
  $("onboarding-skip").textContent = onboarding.step === 3 ? "Skip and finish" : "Skip this question";
}

function startOnboarding() {
  onboarding.active = true;
  onboarding.step = 0;
  onboarding.answers = [];
  onboarding.renderedStep = -1;
  renderChat();
  $("chat-onboarding").scrollIntoView({ block: "center" });
  $("onboarding-options").querySelector("button")?.focus();
}

function founderSentence(value) {
  const clean = String(value || "").trim().replace(/[.!?;:\s]+$/g, "");
  return clean ? `${clean}.` : "";
}

function finishOnboarding() {
  onboarding.active = false;
  if (typeof suggestOnboardingMemory === "function") suggestOnboardingMemory(onboarding.answers);
  const [stage, audience, evidence, obstacle] = onboarding.answers.map((value) => value && value !== "Unknown" ? value.slice(0, 210).trim() : "");
  renderChat();
  if (![stage, audience, evidence, obstacle].some(Boolean)) { scheduleConversationAutosave(); $("chat-input").focus(); return; }
  const parts = [];
  if (stage === "Existing project") parts.push("I have an existing project.");
  else if (stage === "A new idea") parts.push("I'm exploring a new idea.");
  else if (stage) parts.push(founderSentence(stage));
  if (["Founders", "Small businesses", "Teams"].includes(audience)) parts.push(`I'm building for ${audience.toLowerCase()}.`);
  else if (audience) parts.push(founderSentence(audience));
  if (["No validation yet", "Conversations or notes", "Early users or sales"].includes(evidence)) parts.push(`So far I have ${evidence.toLowerCase()}.`);
  else if (evidence) parts.push(founderSentence(evidence));
  if (["Find users and choose a test", "Focus the product", "Challenge a decision"].includes(obstacle)) parts.push(`This week I want to ${obstacle.toLowerCase()}.`);
  else if (obstacle) parts.push(founderSentence(obstacle));
  parts.push("Help me choose one concrete next mission for this week.");
  submitChatMessage(parts.join(" "));
}

function advanceOnboarding(value) {
  if (!onboarding.active) return;
  onboarding.answers[onboarding.step] = String(value).trim().slice(0, 350) || "Unknown";
  if (onboarding.step === 3) finishOnboarding();
  else { onboarding.step += 1; renderOnboarding(); $("onboarding-options").querySelector("button")?.focus(); }
  scheduleConversationAutosave();
}

$("onboarding-options").addEventListener("click", (event) => {
  const option = event.target.closest("[data-onboarding-answer]");
  if (option) advanceOnboarding(option.dataset.onboardingAnswer);
});
$("onboarding-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = $("onboarding-input").value.trim();
  if (value) advanceOnboarding(value);
  else $("onboarding-input").focus();
});
$("onboarding-back").addEventListener("click", () => {
  if (onboarding.step > 0) { onboarding.step -= 1; renderOnboarding(); scheduleConversationAutosave(); $("onboarding-input").focus(); }
});
$("onboarding-skip").addEventListener("click", () => advanceOnboarding("Unknown"));
$("onboarding-skip-all").addEventListener("click", () => { onboarding.active = false; renderChat(); scheduleConversationAutosave(); $("chat-input").focus(); });

function missionCandidateFromReply(reply) {
  const lines = String(reply).split(/\r?\n/).map((line) => line.trim().replace(/^#{1,4}\s*/, "").replace(/\*\*/g, "").replace(/^[-*]\s*/, "")).filter(Boolean);
  const headingIndex = lines.findIndex((line) => /^(?:first|next|proposed|recommended)?\s*mission(?:\s+this\s+week)?\b|^next action\b/i.test(line));
  if (headingIndex < 0) return "";
  const headline = lines[headingIndex].replace(/^(?:first|next|proposed|recommended)?\s*mission(?:\s+this\s+week)?\s*[:—–-]?\s*/i, "").trim();
  const chosen = [headline ? `Mission: ${headline}` : ""];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^(?:observed|assumptions?|risks?|why|rationale|next steps?)\b/i.test(line)) break;
    if (/^(?:owner|timebox|action|expected evidence|evidence|human decision point|decision point|success|failure)\s*:/i.test(line)) chosen.push(line);
    if (chosen.join("\n").length > 620 || chosen.length >= 6) break;
  }
  return chosen.filter(Boolean).join("\n").slice(0, 900);
}

function renderPinCandidate(body, message) {
  if (pinCandidate?.sourceMessageId !== message.id) return;
  const panel = el("div", "pin-candidate");
  panel.append(el("label", "", "Make this your next move"));
  const input = el("textarea", "");
  input.id = "pin-candidate-input";
  input.maxLength = CHAT_LIMIT;
  input.rows = 5;
  input.value = pinCandidate.content;
  input.placeholder = "Name one concrete action, owner, timebox, and evidence to collect.";
  panel.querySelector("label").htmlFor = input.id;
  panel.append(input);
  panel.append(el("p", "", pinCandidate.content ? "Adjust the action and expected evidence, then approve it to start." : "Write one concrete action with the evidence you will bring back, or ask Lia to Make a mission."));
  const actions = el("div", "pin-candidate-actions");
  const confirm = el("button", "pin-candidate-confirm", "Approve & start mission");
  confirm.type = "button";
  confirm.dataset.pinConfirm = message.id;
  const cancel = el("button", "", "Cancel");
  cancel.type = "button";
  cancel.dataset.pinCancel = message.id;
  actions.append(confirm, cancel);
  panel.append(actions);
  body.append(panel);
}

function handlePinCandidate(event) {
  const input = event.target.closest("#pin-candidate-input");
  if (input && pinCandidate) pinCandidate.content = input.value;
}

function activatePinCandidate(event) {
  const cancel = event.target.closest("[data-pin-cancel]");
  if (cancel && pinCandidate?.sourceMessageId === cancel.dataset.pinCancel) {
    pinCandidate = null;
    renderChat();
    return;
  }
  const confirm = event.target.closest("[data-pin-confirm]");
  if (!confirm || pinCandidate?.sourceMessageId !== confirm.dataset.pinConfirm || chatBusy || sourceBusy) return;
  const content = pinCandidate.content.trim();
  if (content.length < 12 || content.length > CHAT_LIMIT) {
    setChatStatus("Keep the proposed mission between 12 and 1,500 characters.", true);
    $("pin-candidate-input").focus();
    return;
  }
  const sourceMessageId = pinCandidate.sourceMessageId;
  const tracked = missionTracker.records.find((item) => item.id === sourceMessageId);
  if (tracked?.status === "completed") return;
  pinnedMission = { content, status: "approved", sourceMessageId, pinnedAt: Date.now() };
  pinCandidate = null;
  persistPinnedMission();
  ensureMissionRecord(pinnedMission);
  renderChat(true);
  renderMissionTracker();
  setChatStatus("Mission started. Bring back what you learn, even if the target is missed.");
  focusMissionInChat();
}

function renderChat(scroll = false) {
  const list = $("chat-messages");
  const latestAssistant = [...chatMessages].reverse().find((item) => item.role === "assistant");
  list.replaceChildren(...chatMessages.map((message) => {
    const row = el("li", `chat-message is-${message.role}${message.status === "failed" ? " is-failed" : ""}`);
    const body = el("div", "message-body");
    const line = el("div", "message-byline");
    line.append(el("strong", "", message.role === "assistant" ? "Lia" : "You"));
    const time = document.createElement("time");
    time.dateTime = new Date(message.at).toISOString();
    time.textContent = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(message.at);
    line.append(time);
    const content = el(message.role === "assistant" ? "div" : "p", "message-content");
    if (message.role === "assistant") appendAssistantMarkdown(content, message.content);
    else content.textContent = message.content;
    body.append(line, content);
    if (message.role === "assistant") {
      const copy = el("button", "message-copy", "Copy response");
      copy.type = "button";
      copy.dataset.copyMessage = message.id;
      body.append(copy);
    }
    if (message.status === "failed") {
      const retry = el("button", "message-retry", "Retry sending");
      retry.type = "button";
      retry.dataset.retryId = message.id;
      retry.disabled = chatBusy || sourceBusy || isDemoQuotaExhausted();
      body.append(el("p", "message-error", "AdaL did not answer this message."), retry);
    }
    if (message.role === "assistant" && message.id === latestAssistant?.id) {
      const actions = el("div", "response-actions");
      for (const [action, label] of [["challenge", "Challenge this"], ["mission", "Make a mission"], ["pin", "Start a mission"]]) {
        const button = el("button", "response-action", label);
        button.type = "button";
        button.dataset.responseAction = action;
        button.dataset.sourceMessageId = message.id;
        button.disabled = chatBusy || sourceBusy || (isDemoQuotaExhausted() && action !== "pin") || (action === "pin" && pinnedMission?.sourceMessageId === message.id);
        if (action === "pin" && pinnedMission?.sourceMessageId === message.id) button.textContent = "Mission in progress";
        if (action === "pin" && missionTracker.records.some((record) => record.id === message.id && record.status === "completed")) {
          button.textContent = "Mission completed";
          button.disabled = true;
        }
        actions.append(button);
      }
      body.append(actions);
      renderPinCandidate(body, message);
    }
    const current = activeMissionRecord();
    if (current?.status === "approved" && message.role === "user" && message.at >= Math.max(current.approvedAt || current.createdAt, pinnedMission.pinnedAt)) {
      const saveResult = el("button", "message-result-action", "Use as mission result");
      saveResult.type = "button";
      saveResult.dataset.evidenceMessageId = message.id;
      saveResult.dataset.missionId = current.id;
      body.append(saveResult);
    }
    row.append(body);
    return row;
  }));
  $("chat-empty").hidden = chatMessages.length > 0 || onboarding.active;
  $("create-account-welcome").hidden = accountSession.authenticated;
  $("guest-draft-choice").hidden = accountSession.authenticated || !guestHidden || !loadChatMessages(CHAT_STORAGE_KEY).length;
  renderOnboarding();
  $("chat-typing").hidden = !chatBusy;
  $("chat-shortcuts").hidden = !!activeMissionRecord() || !chatMessages.some((message) => message.role === "assistant");
  const sampleDemo = chatMessages.some((message) => message.role === "user" && message.content.startsWith("Atelier Loop is a fictional circular-delivery startup.")) || sourceEntries.some((entry) => entry.selected && entry.sources.some((source) => source.sample));
  for (const button of $("chat-shortcuts").querySelectorAll("[data-demo-only]")) button.hidden = !sampleDemo;
  $("export-chat").disabled = chatMessages.length === 0;
  $("export-chat-help").textContent = chatMessages.length ? "Download this chat as Markdown" : "Available after your first message";
  $("use-chat-context").disabled = !chatMessages.some((message) => message.role === "user" && message.status === "complete");
  $("reset-chat").disabled = chatBusy || sourceBusy || !accountReady;
  $("open-decision-canvas").disabled = sourceBusy;
  const input = $("chat-input");
  $("chat-send").disabled = !accountReady || chatBusy || sourceBusy || isDemoQuotaExhausted() || !!pendingAttachment || !input.value.trim() || input.value.trim() === EVIDENCE_PREFIX.trim();
  input.disabled = !accountReady || chatBusy || sourceBusy;
  $("chat-form").setAttribute("aria-busy", chatBusy ? "true" : "false");
  $("chat-count").textContent = `${input.value.length} / ${CHAT_LIMIT}`;
  for (const suggestion of document.querySelectorAll("button[data-prompt]")) suggestion.disabled = !accountReady || chatBusy || sourceBusy || isDemoQuotaExhausted();
  renderMissionTracker();
  renderActiveSources();
  renderAttachment();
  updateSourceControls();
  resizeChatInput();
  if (scroll) scrollChatToLatest();
}

function chatHistoryBefore(messageId) {
  const index = chatMessages.findIndex((item) => item.id === messageId);
  return chatMessages.slice(0, index).filter((item) => item.status === "complete")
    .slice(-12).map(({ role, content }) => ({ role, content: content.slice(0, CHAT_LIMIT) }));
}

async function requestChatReply(message) {
  expandedMissionId = null;
  chatBusy = true;
  message.status = "pending";
  setChatStatus("");
  persistChat();
  renderChat(true);
  try {
    const body = { message: message.content, history: chatHistoryBefore(message.id) };
    if (typeof memoryHasContent === "function" && memoryHasContent()) body.projectMemory = cleanProjectMemory(projectMemory);
    if (pinnedMission) body.pinnedMission = { content: pinnedMission.content, status: pinnedMission.status };
    const sourceContexts = selectedSourceEntries().map((entry) => entry.chatContext);
    if (sourceContexts.length) body.sourceContexts = sourceContexts;
    const encoder = new TextEncoder();
    while (body.history.length && encoder.encode(JSON.stringify(body)).length > CHAT_REQUEST_BUDGET_BYTES) body.history.shift();
    if (encoder.encode(JSON.stringify(body)).length > CHAT_REQUEST_BUDGET_BYTES) {
      throw new Error("Selected context is too large for one message. Remove a source summary or unpin the mission, then retry.");
    }
    const data = await postJson("/api/chat", body);
    if (data.source !== "adal" || typeof data.message !== "string" || !data.message.trim()) {
      throw new Error("AdaL returned an empty reply. Please retry.");
    }
    message.status = "complete";
    chatMessages.push({
      id: crypto.randomUUID(), role: "assistant", content: data.message.trim(),
      at: Date.now(), status: "complete"
    });
    chatMessages = chatMessages.slice(-60);
    persistChat();
  } catch (error) {
    message.status = "failed";
    persistChat();
    setChatStatus(error.message || "AdaL could not answer. Try again.", true);
  } finally {
    chatBusy = false;
    renderChat(true);
    scheduleConversationAutosave();
    $("chat-input").focus();
  }
}

function submitChatMessage(rawContent, clearComposer = false) {
  if (!accountReady || chatBusy || sourceBusy) return false;
  if (isDemoQuotaExhausted()) { setChatStatus("The shared demo AI limit is reached. This message was not sent.", true); return false; }
  if (!accountSession.authenticated && guestHidden) {
    if (loadChatMessages(CHAT_STORAGE_KEY).length) {
      setChatStatus("Choose Restore draft or Start fresh above before sending.", true);
      $("guest-start-fresh").focus();
      return false;
    }
    guestHidden = false;
    try { localStorage.removeItem(GUEST_HIDDEN_KEY); } catch {}
  }
  if (pendingAttachment) {
    setChatStatus("Analyze the attached file or remove it before sending, so Lia knows which context to use.", true);
    return false;
  }
  if (onboarding.active) { onboarding.active = false; renderOnboarding(); }
  const content = String(rawContent).trim();
  if (!content) {
    $("chat-input").focus();
    return false;
  }
  if (content.length > CHAT_LIMIT) {
    setChatStatus(`Keep your message under ${CHAT_LIMIT} characters.`, true);
    $("chat-input").focus();
    return false;
  }
  if (content === EVIDENCE_PREFIX.trim()) {
    setChatStatus("Add the evidence you actually observed before sending.", true);
    $("chat-input").focus();
    return false;
  }
  const message = { id: crypto.randomUUID(), role: "user", content, at: Date.now(), status: "pending" };
  chatMessages.push(message);
  if (clearComposer) $("chat-input").value = "";
  requestChatReply(message);
  return true;
}

function sendChat(event) {
  event.preventDefault();
  submitChatMessage($("chat-input").value, true);
}

function retryChat(event) {
  const retry = event.target.closest("button[data-retry-id]");
  if (!retry || chatBusy || sourceBusy) return;
  const message = chatMessages.find((item) => item.id === retry.dataset.retryId && item.status === "failed");
  if (message) requestChatReply(message);
}

function sendSuggestion(event) {
  const prompt = event.target.closest("button[data-prompt]");
  if (!prompt || chatBusy || sourceBusy) return;
  submitChatMessage(prompt.dataset.prompt);
}

function handleResponseAction(event) {
  const button = event.target.closest("button[data-response-action]");
  if (!button || chatBusy || sourceBusy) return;
  const latest = [...chatMessages].reverse().find((item) => item.role === "assistant");
  if (!latest || latest.id !== button.dataset.sourceMessageId) return;
  if (button.dataset.responseAction === "challenge") {
    submitChatMessage("Challenge your last recommendation as my AI co-founder. What is the weakest assumption, what alternative could be better, and what evidence would change your mind this week? Use our conversation and do not invent results.");
  } else if (button.dataset.responseAction === "mission") {
    submitChatMessage("Turn your last recommendation into one proposed next mission for me. Specify the action, responsible person, deadline, expected evidence, and how to judge success or failure. Do not invent a numeric threshold or claim anything was completed; identify what I need to choose or measure. Keep the complete mission under 1,200 characters so I can pin it.");
  } else if (button.dataset.responseAction === "pin") {
    const tracked = missionTracker.records.find((item) => item.id === latest.id);
    if (tracked?.status === "completed") {
      setChatStatus("This mission was already completed. Ask Lia for a new one before pinning again.", true);
      return;
    }
    pinCandidate = { sourceMessageId: latest.id, content: missionCandidateFromReply(latest.content) };
    renderChat(true);
    $("pin-candidate-input")?.focus();
  }
}

function approvePinnedMission() {
  if (!pinnedMission || chatBusy) return;
  pinnedMission.status = "approved";
  persistPinnedMission();
  ensureMissionRecord(pinnedMission);
  expandedMissionId = pinnedMission.sourceMessageId;
  renderChat();
  setChatStatus("Mission started. Bring back what you learn.");
  $("mission-add-evidence").focus();
}

function bringMissionEvidence() {
  if (!pinnedMission || chatBusy) return;
  const input = $("chat-input");
  if (!input.value.trim()) input.value = EVIDENCE_PREFIX;
  renderChat();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  setChatStatus("Add what actually happened, then send it to Lia.");
}

function unpinMission() {
  if (!pinnedMission || chatBusy) return;
  pinnedMission = null;
  persistPinnedMission();
  renderChat(true);
  renderMissionTracker();
  setChatStatus("Mission unpinned from this browser.");
}

function exportChat() {
  if (!chatMessages.length) return;
  const lines = [
    "# Bueeld Lab conversation", "",
    "_AI Co-Founder Hackathon prototype. Conversation processed by AdaL when messages were sent. Any Atelier Loop example is fictional._", ""
  ];
  for (const message of chatMessages) {
    lines.push(`## ${message.role === "assistant" ? "Lia" : "Founder"} · ${new Date(message.at).toLocaleString()}`, "", message.content, "");
    if (message.status === "failed") lines.push("_This message did not receive an AdaL reply._", "");
  }
  if (pinnedMission) lines.push("## Pinned next mission", "", `Status: ${pinnedMission.status} (local human decision only)`, "", pinnedMission.content, "");
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = `bueeld-lab-chat-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function resetChat() {
  if (!accountReady || chatBusy || sourceBusy || accountBusy) return;
  if (!accountSession.authenticated && guestHidden && loadChatMessages(CHAT_STORAGE_KEY).length) {
    setChatStatus("Choose Restore draft or Start fresh above before starting another chat.", true);
    $("guest-start-fresh").focus();
    return;
  }
  const hadWork = !!(chatMessages.length || pinnedMission || sourceEntries.length);
  if (hadWork && (!accountSession.authenticated || guestMigrationNeedsSave) && !window.confirm(guestMigrationNeedsSave
    ? "This copied guest chat has not been saved to your account. Discard it and start a new chat?"
    : "Discard this local guest chat and start a new one?")) return;
  if (accountSession.authenticated && !guestMigrationNeedsSave) {
    try { await writeConversation(false); }
    catch (error) { setChatStatus(`Could not save the current chat: ${error.message}`, true); return; }
  }
  chatMessages = [];
  pinnedMission = null;
  expandedMissionId = null;
  recentMissionCompletionId = null;
  pinCandidate = null;
  sourceEntries = [];
  pendingAttachment = null;
  onboarding.active = false;
  $("chat-file-input").value = "";
  $("chat-input").value = "";
  activeConversationId = null;
  lastSavedSnapshot = null;
  guestMigrationNeedsSave = false;
  persistActiveConversationId();
  renderSourceResults();
  setChatStatus("");
  persistChat();
  persistPinnedMission();
  $("account-chat-title").value = "";
  renderChat();
  renderMissionTracker();
  renderAccount();
  if (accountSession.authenticated && hadWork) setChatStatus("Previous chat saved. New conversation ready.");
  $("chat-input").focus();
}

let decisionOpener = null;

function openDecisionCanvas() {
  if (sourceBusy || !$("decision-drawer").hidden) return;
  if (!$("account-drawer").hidden) closeAccount();
  if (!$("mission-drawer").hidden) closeMissionTracker();
  if (!$("source-drawer").hidden) closeSources();
  decisionOpener = $("header-more").contains(document.activeElement) ? $("header-more-trigger") : document.activeElement;
  $("decision-drawer").hidden = false;
  document.body.classList.add("canvas-open");
  $("decision-panel").focus();
}

function closeDecisionCanvas() {
  $("decision-drawer").hidden = true;
  document.body.classList.remove("canvas-open");
  if (decisionOpener instanceof HTMLElement) decisionOpener.focus();
}

function useChatContext() {
  const founderMessages = chatMessages.filter((item) => item.role === "user" && item.status === "complete")
    .slice(-8).map((item) => item.content);
  if (!founderMessages.length) return;
  if (state.plan && !window.confirm("Replace the current decision context with this conversation?")) return;
  $("brief-input").value = founderMessages.join("\n\n").slice(0, 3000);
  $("evidence-input").value = "";
  updateContext();
  setStatus("plan-status", "Your own messages were copied here. Add observed evidence before asking AdaL for a decision plan.");
  openDecisionCanvas();
  $("evidence-input").focus({ preventScroll: true });
}

// Lab account: signed-in work autosaves; guest drafts migrate only after an explicit Save click.
const ACTIVE_CONVERSATION_KEY = "bueeld-lab-active-conversation-v1";
let activeConversationId = null;
let accountMode = "login";
let accountBusy = false;
let accountConversations = [];
let accountOpener = null;
let guestContextSnapshot = [];
let missionDirty = false;
let guestMigrationNeedsSave = false;
let autosaveMuted = false;
let conversationAutosaveTimer = null;
let conversationSavePromise = null;
let lastSavedSnapshot = null;
let conversationListRequestId = 0;
let accountSaveFailed = false;
let missionSyncTimer = null;
let missionSyncPromise = null;
let missionRevision = 0;

function conversationPayload() {
  const enteredTitle = $("account-chat-title").value.trim();
  const title = (enteredTitle && enteredTitle !== "New Bueeld conversation" ? enteredTitle : conversationTitle()).slice(0, 120);
  if (enteredTitle === "New Bueeld conversation" && chatMessages.some((item) => item.role === "user")) $("account-chat-title").value = title;
  const messages = chatMessages.filter((item) => item.status === "complete" || item.status === "failed")
    .slice(-60).map(({ id, role, content, at, status }) => ({ id, role, content, at, status }));
  const sourceContexts = selectedSourceEntries().map((entry) => entry.chatContext);
  const onboardingDraft = onboarding.active ? { step: onboarding.step, answers: onboarding.answers.slice(0, 4) } : null;
  return { title, messages, pinnedMission, sourceContexts, onboardingDraft };
}

function updateSaveIndicator() {
  const visible = accountReady && accountSession.authenticated;
  $("account-save-row").hidden = !visible;
  if (!visible) return;
  const pending = !!(conversationAutosaveTimer || conversationSavePromise || missionSyncTimer || missionSyncPromise || missionDirty);
  const label = guestMigrationNeedsSave ? "Copied guest chat is still local" : accountSaveFailed ? "Lab save failed" : pending ? "Saving to Lab…" : "Saved to Lab";
  $("account-save-label").textContent = label;
  $("account-save-row").classList.toggle("is-saving", pending && !accountSaveFailed);
  $("account-save-row").classList.toggle("is-failed", accountSaveFailed);
  $("account-save-retry").hidden = !accountSaveFailed;
  $("account-save-retry").disabled = accountBusy || chatBusy || sourceBusy;
}

function scheduleConversationAutosave() {
  if (!accountReady || !accountSession.authenticated || autosaveMuted || guestMigrationNeedsSave) return;
  clearTimeout(conversationAutosaveTimer);
  accountSaveFailed = false;
  conversationAutosaveTimer = setTimeout(() => {
    writeConversation(false).catch((error) => accountMessage("Autosave failed: " + error.message, true));
  }, 950);
  updateSaveIndicator();
}

async function writeConversation(manual) {
  if (!accountSession.authenticated || (!manual && guestMigrationNeedsSave)) return false;
  clearTimeout(conversationAutosaveTimer);
  conversationAutosaveTimer = null;
  if (chatBusy || sourceBusy) {
    if (!manual) scheduleConversationAutosave();
    return false;
  }
  if (conversationSavePromise) {
    await conversationSavePromise;
    return writeConversation(manual);
  }
  const body = conversationPayload();
  if (!body.messages.length && !body.sourceContexts.length && !body.pinnedMission && !body.onboardingDraft && !activeConversationId) {
    updateSaveIndicator();
    return false;
  }
  const snapshot = JSON.stringify(body);
  if (!manual && snapshot === lastSavedSnapshot) {
    updateSaveIndicator();
    return true;
  }
  const userId = accountSession.user?.id;
  const path = activeConversationId ? `/api/conversations/${encodeURIComponent(activeConversationId)}` : "/api/conversations";
  conversationSavePromise = accountApi(activeConversationId ? "PUT" : "POST", path, body);
  updateSaveIndicator();
  try {
    const data = await conversationSavePromise;
    if (accountSession.user?.id !== userId) return false;
    activeConversationId = data.conversation.id;
    lastSavedSnapshot = snapshot;
    guestMigrationNeedsSave = false;
    persistActiveConversationId();
    const saved = data.conversation;
    const summary = { id: saved.id, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, messageCount: saved.messages?.length || 0 };
    accountConversations = [summary, ...accountConversations.filter((entry) => entry.id !== saved.id)].slice(0, 12);
    renderAccount();
    refreshConversations();
    return true;
  } catch (error) {
    accountSaveFailed = true;
    throw error;
  } finally {
    conversationSavePromise = null;
    updateSaveIndicator();
  }
}

function scheduleMissionSync() {
  if (!accountReady || !accountSession.authenticated || autosaveMuted || guestMigrationNeedsSave) return;
  clearTimeout(missionSyncTimer);
  accountSaveFailed = false;
  missionSyncTimer = setTimeout(() => {
    flushMissionSync().catch((error) => accountMessage("Mission sync failed: " + error.message, true));
  }, 950);
  updateSaveIndicator();
}

async function flushMissionSync() {
  if (!accountSession.authenticated) return true;
  clearTimeout(missionSyncTimer);
  missionSyncTimer = null;
  if (missionSyncPromise) {
    await missionSyncPromise;
    return flushMissionSync();
  }
  const userId = accountSession.user?.id;
  const revision = missionRevision;
  const body = { missionTracker: { records: missionTracker.records.slice(-40), seenLevel: missionTracker.seenLevel } };
  missionSyncPromise = accountApi("PUT", "/api/mission-tracker", body);
  updateSaveIndicator();
  try {
    await missionSyncPromise;
    if (accountSession.user?.id === userId) {
      missionDirty = missionRevision !== revision;
      if (missionDirty) scheduleMissionSync();
    }
    return true;
  } catch (error) {
    accountSaveFailed = true;
    throw error;
  } finally {
    missionSyncPromise = null;
    updateSaveIndicator();
  }
}

function persistActiveConversationId() {
  if (!accountSession.authenticated) return;
  try {
    const key = currentStorageKey(ACTIVE_CONVERSATION_KEY);
    if (activeConversationId) localStorage.setItem(key, activeConversationId);
    else localStorage.removeItem(key);
  } catch { /* The chat still works in memory. */ }
}

function accountMessage(message, isError = false) {
  $("account-status").textContent = message;
  $("account-status").classList.toggle("is-error", isError);
}

function conversationTitle() {
  const first = chatMessages.find((item) => item.role === "user");
  const text = first?.content.replace(/\s+/g, " ").trim() || "New Bueeld conversation";
  return text.length > 72 ? text.slice(0, 69).trimEnd() + "…" : text;
}

function renderAccount() {
  $("open-account").textContent = accountSession.authenticated ? "Account" : "Sign in";
  $("account-signed-out").hidden = accountSession.authenticated;
  $("account-signed-in").hidden = !accountSession.authenticated;
  $("account-email-display").textContent = accountSession.user?.email || "";
  $("account-login-tab").setAttribute("aria-pressed", accountMode === "login" ? "true" : "false");
  $("account-signup-tab").setAttribute("aria-pressed", accountMode === "signup" ? "true" : "false");
  $("account-submit").textContent = accountMode === "signup" ? "Create account" : "Sign in";
  $("account-password").autocomplete = accountMode === "signup" ? "new-password" : "current-password";
  $("account-current-summary").textContent = guestMigrationNeedsSave ? "Copied guest chat stays local until you save it." : "Chats and mission progress save automatically.";
  $("account-save-chat").disabled = accountBusy || (!chatMessages.length && !missionTracker.records.length && !selectedSourceEntries().length && !onboarding.active);
  $("account-save-chat").textContent = guestMigrationNeedsSave ? "Save guest chat" : "Sync now";
  $("account-save-chat").classList.toggle("account-primary", guestMigrationNeedsSave);
  const guestAvailable = accountSession.authenticated && !guestHidden && loadChatMessages(CHAT_STORAGE_KEY).length > 0;
  $("account-guest-restore").hidden = accountSession.authenticated || !guestHidden || !loadChatMessages(CHAT_STORAGE_KEY).length;
  $("account-copy-guest").hidden = !guestAvailable;
  $("account-copy-guest").disabled = accountBusy || !!conversationSavePromise;
  for (const button of [$("account-submit"), $("account-logout"), $("account-refresh")]) button.disabled = accountBusy;
  const rows = accountConversations.map((conversation) => {
    const row = el("article", "account-conversation");
    const details = el("div");
    details.append(el("strong", "", conversation.title));
    const updated = new Date(conversation.updatedAt);
    details.append(el("small", "", `${conversation.messageCount} messages · ${Number.isNaN(updated.getTime()) ? "Saved" : updated.toLocaleDateString()}`));
    const actions = el("div", "account-conversation-actions");
    const open = el("button", "", conversation.id === activeConversationId ? "Reload" : "Open");
    open.type = "button";
    open.dataset.conversationOpen = conversation.id;
    open.disabled = accountBusy;
    const remove = el("button", "account-delete", "Delete");
    remove.type = "button";
    remove.dataset.conversationDelete = conversation.id;
    remove.disabled = accountBusy;
    actions.append(open, remove);
    row.append(details, actions);
    return row;
  });
  $("account-conversations").replaceChildren(...(rows.length ? rows : [el("p", "account-small", "No saved conversations yet.")]));
  updateSaveIndicator();
}

async function accountApi(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-Lab-CSRF"] = accountSession.csrfToken;
  const response = await fetch(path, {
    method, headers, credentials: "same-origin",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Account request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function clearAccountBoundMemory() {
  workspaceGeneration += 1;
  sourceEntries = [];
  connectorStates = null;
  connectorLoading = false;
  connectorStatusPromise = null;
  connectorItems = [];
  activeConnectorId = null;
  manualImportKind = null;
  pendingAttachment = null;
  $("chat-file-input").value = "";
  $("local-source-file").value = "";
  $("connector-items-list").replaceChildren();
  $("connector-items-section").hidden = true;
  $("source-import-hint").hidden = true;
  $("chat-input").value = "";
  renderSourceResults();
  renderConnectors();
}

function loadAccountWorkspace() {
  autosaveMuted = true;
  clearTimeout(conversationAutosaveTimer);
  clearTimeout(missionSyncTimer);
  conversationAutosaveTimer = null;
  missionSyncTimer = null;
  guestMigrationNeedsSave = false;
  lastSavedSnapshot = null;
  accountSaveFailed = false;
  onboarding.active = false;
  clearAccountBoundMemory();
  state = !accountSession.authenticated && guestHidden ? emptyState() : loadState();
  $("brief-input").value = state.brief;
  $("evidence-input").value = state.evidence;
  $("result-input").value = state.result.value;
  $("notes-input").value = state.result.notes;
  render();
  chatMessages = !accountSession.authenticated && guestHidden ? [] : loadChatMessages();
  pinnedMission = !accountSession.authenticated && guestHidden ? null : loadPinnedMission();
  pinCandidate = null;
  missionTracker = !accountSession.authenticated && guestHidden ? { records: [], seenLevel: 1 } : loadMissionTracker();
  missionEvidenceForId = null;
  missionEvidenceExpanded = false;
  expandedMissionId = null;
  recentMissionCompletionId = null;
  missionDirty = false;
  try { activeConversationId = accountSession.authenticated ? localStorage.getItem(currentStorageKey(ACTIVE_CONVERSATION_KEY)) : null; }
  catch { activeConversationId = null; }
  $("account-chat-title").value = conversationTitle();
  reconcilePinnedMission();
  renderMissionTracker();
  renderChat(true);
  renderAccount();
  autosaveMuted = false;
  updateSaveIndicator();
  if (typeof loadProjectMemory === "function") void loadProjectMemory();
}

async function loadServerMissionTracker() {
  if (!accountSession.authenticated) return;
  const userId = accountSession.user?.id;
  const generation = workspaceGeneration;
  const revision = missionRevision;
  try {
    const data = await accountApi("GET", "/api/mission-tracker");
    if (accountSession.user?.id !== userId || workspaceGeneration !== generation || missionRevision !== revision || missionDirty) return;
    if (Array.isArray(data.missionTracker?.records)) {
      // A restored chat can already have created its pin locally. Merge by id so
      // that one record cannot hide the account's completed missions and rewards.
      const records = new Map(missionTracker.records.map((record) => [record.id, record]));
      for (const record of data.missionTracker.records) records.set(record.id, record);
      const wasMuted = autosaveMuted;
      autosaveMuted = true;
      missionTracker = { records: [...records.values()], seenLevel: Math.max(missionTracker.seenLevel, data.missionTracker.seenLevel || 1) };
      reconcilePinnedMission();
      persistMissionTracker();
      autosaveMuted = wasMuted;
      renderMissionTracker();
      renderChat();
      renderAccount();
    }
  } catch (error) {
    accountMessage(error.message || "Mission history could not be loaded.", true);
  }
}

function clearAuthenticatedLocalDrafts(userId) {
  if (!userId) return;
  const suffix = `-user-${String(userId).replace(/[^A-Za-z0-9_-]/g, "")}`;
  for (const base of [STORAGE_KEY, CHAT_STORAGE_KEY, MISSION_STORAGE_KEY, MISSION_TRACKER_STORAGE_KEY, ACTIVE_CONVERSATION_KEY, ...(typeof PROJECT_MEMORY_KEY === "string" ? [PROJECT_MEMORY_KEY] : [])]) {
    try { localStorage.removeItem(base + suffix); } catch { /* Browser storage may be unavailable. */ }
  }
}

async function refreshConversations() {
  if (!accountSession.authenticated) return;
  const userId = accountSession.user?.id;
  const requestId = ++conversationListRequestId;
  try {
    const data = await accountApi("GET", "/api/conversations");
    if (!accountSession.authenticated || accountSession.user?.id !== userId || requestId !== conversationListRequestId) return;
    accountConversations = Array.isArray(data.conversations) ? data.conversations : [];
    if (activeConversationId && !accountConversations.some((item) => item.id === activeConversationId)) {
      if (conversationSavePromise) return;
      activeConversationId = null;
      persistActiveConversationId();
    }
    const active = accountConversations.find((item) => item.id === activeConversationId);
    if (active?.title && active.title !== "New Bueeld conversation" && !lastSavedSnapshot && document.activeElement !== $("account-chat-title")) {
      $("account-chat-title").value = active.title;
    } else if (active?.title === "New Bueeld conversation" && chatMessages.some((item) => item.role === "user") && !lastSavedSnapshot) {
      scheduleConversationAutosave();
    }
    renderAccount();
  } catch (error) {
    if (accountSession.authenticated && accountSession.user?.id === userId) accountMessage(error.message || "Saved conversations could not be loaded.", true);
  }
}

function selectRecentConversationIfNeeded() {
  if (!accountSession.authenticated || activeConversationId || chatMessages.length || !accountConversations.length) return;
  activeConversationId = accountConversations[0].id;
  persistActiveConversationId();
}

async function hydrateActiveConversation() {
  if (!accountSession.authenticated || !activeConversationId || guestMigrationNeedsSave) return;
  const userId = accountSession.user?.id;
  const conversationId = activeConversationId;
  const generation = workspaceGeneration;
  try {
    const data = await accountApi("GET", "/api/conversations/" + encodeURIComponent(conversationId));
    if (accountSession.user?.id !== userId || workspaceGeneration !== generation || activeConversationId !== conversationId || guestMigrationNeedsSave) return;
    const saved = data.conversation;
    if (!saved) return;
    const localNewest = chatMessages.at(-1)?.at || 0;
    const serverNewest = saved.messages?.at(-1)?.at || 0;
    if (serverNewest > localNewest && Array.isArray(saved.messages)) {
      autosaveMuted = true;
      chatMessages = saved.messages;
      pinnedMission = saved.pinnedMission || null;
      persistChat();
      persistPinnedMission();
      reconcilePinnedMission();
      autosaveMuted = false;
      renderMissionTracker();
    }
    if (!sourceEntries.length && Array.isArray(saved.sourceContexts)) {
      sourceEntries = saved.sourceContexts.slice(0, 3).map(entryFromSavedContext);
      renderSourceResults();
    }
    if (saved.onboardingDraft && !onboarding.active && !chatMessages.length) {
      onboarding.active = true;
      onboarding.step = saved.onboardingDraft.step;
      onboarding.answers = saved.onboardingDraft.answers;
      onboarding.renderedStep = -1;
    }
    if (saved.title && saved.title !== "New Bueeld conversation" && document.activeElement !== $("account-chat-title")) {
      $("account-chat-title").value = saved.title;
    }
    renderChat(true);
    renderAccount();
  } catch (error) {
    if (accountSession.user?.id === userId && workspaceGeneration === generation) {
      accountMessage("The active chat context could not be restored. Open it from Saved conversations before sending.", true);
      setChatStatus("Saved project context did not load. Reopen this chat from Account before sending source-based questions.", true);
    }
  }
}

async function fetchAccountSession() {
  const retryDelays = [250, 750];
  for (let attempt = 0; ; attempt += 1) {
    try {
      const data = await accountApi("GET", "/api/auth/session");
      if (!data || typeof data.authenticated !== "boolean" ||
          (data.authenticated && (!data.user?.id || typeof data.csrfToken !== "string" || !data.csrfToken))) {
        throw new Error("Account session response is incomplete.");
      }
      return data;
    } catch (error) {
      // A brief restart or proxy error must not turn a valid cookie into a guest
      // workspace. Only the server can confirm whether this session is signed in.
      if (attempt >= retryDelays.length || (error.status && error.status < 500)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

async function initializeAccount() {
  try {
    const data = await fetchAccountSession();
    accountSession = { authenticated: data.authenticated === true, user: data.user || null, csrfToken: data.csrfToken || "" };
    try { guestHidden = localStorage.getItem(GUEST_HIDDEN_KEY) === "1"; } catch { guestHidden = false; }
  } catch {
    accountSession = { authenticated: false, user: null, csrfToken: "" };
    try { guestHidden = localStorage.getItem(GUEST_HIDDEN_KEY) === "1"; } catch { guestHidden = false; }
    accountMessage("Account service is unavailable. Your local guest chat remains usable.", true);
  }
  accountReady = true;
  loadAccountWorkspace();
  if (accountSession.authenticated) { await loadServerMissionTracker(); await refreshConversations(); selectRecentConversationIfNeeded(); await hydrateActiveConversation(); }
}

function openAccount() {
  if (chatBusy || sourceBusy) { setChatStatus("Wait for Lia to finish before changing accounts."); return; }
  if (!$("mission-drawer").hidden) closeMissionTracker();
  if (!$("source-drawer").hidden) closeSources();
  if (!$("decision-drawer").hidden) closeDecisionCanvas();
  if (!$("account-drawer").hidden) return;
  accountOpener = document.activeElement;
  $("account-drawer").hidden = false;
  document.body.classList.add("account-open");
  renderAccount();
  $("account-panel").focus();
}

function closeAccount() {
  $("account-drawer").hidden = true;
  document.body.classList.remove("account-open");
  if (!accountSession.authenticated) returnToSourcesAfterAccount = false;
  if (accountOpener instanceof HTMLElement) accountOpener.focus();
}

function setAccountMode(mode) {
  accountMode = mode;
  accountMessage("");
  $("account-password").value = "";
  renderAccount();
}

async function submitAccount(event) {
  event.preventDefault();
  if (accountBusy || chatBusy || sourceBusy || !accountReady) return;
  const email = $("account-email").value.trim();
  const password = $("account-password").value;
  if (!email || password.length < 12 || password.length > 128) {
    accountMessage("Enter a valid email and a password of 12–128 characters.", true);
    return;
  }
  accountBusy = true;
  accountMessage(accountMode === "signup" ? "Creating account…" : "Signing in…");
  renderAccount();
  try {
    const data = await accountApi("POST", `/api/auth/${accountMode}`, { email, password });
    if (!data.authenticated || !data.user?.id || !data.csrfToken) throw new Error("Account session could not be established.");
    if (!accountSession.authenticated) guestContextSnapshot = selectedSourceEntries().map((entry) => entry.chatContext);
    accountSession = { authenticated: true, user: data.user, csrfToken: data.csrfToken };
    broadcastAccountChange();
    accountConversations = [];
    loadAccountWorkspace();
    await loadServerMissionTracker();
    accountMessage("Signed in. Your guest chat is still on this browser; copy it here only if you choose.");
    await refreshConversations();
    if (accountMode === "login") { selectRecentConversationIfNeeded(); await hydrateActiveConversation(); }
    if (accountMode === "signup") { closeAccount(); startOnboarding(); }
    else if (returnToSourcesAfterAccount) { closeAccount(); openSources(); }
    returnToSourcesAfterAccount = false;
  } catch (error) {
    accountMessage(error.message || "Could not sign in.", true);
  } finally {
    $("account-password").value = "";
    accountBusy = false;
    renderAccount();
  }
}

async function logoutAccount() {
  if (accountBusy || chatBusy || sourceBusy || !accountSession.authenticated) return;
  if (guestMigrationNeedsSave && !window.confirm("This copied guest chat has not been saved to the account. Its original guest draft will remain on this browser, hidden after sign-out. Continue?")) return;
  const previousUserId = accountSession.user?.id;
  accountBusy = true;
  accountMessage("Finishing account sync…");
  renderAccount();
  try {
    if (!guestMigrationNeedsSave) await writeConversation(false);
    if (missionDirty && !guestMigrationNeedsSave) await flushMissionSync();
    const data = await accountApi("POST", "/api/auth/logout");
    clearAuthenticatedLocalDrafts(previousUserId);
    accountSession = { authenticated: false, user: null, csrfToken: data.csrfToken || "" };
    broadcastAccountChange();
    guestHidden = true;
    try { localStorage.setItem(GUEST_HIDDEN_KEY, "1"); } catch {}
    accountConversations = [];
    guestContextSnapshot = [];
    loadAccountWorkspace();
    accountMessage("Signed out. The guest draft is hidden; restore it explicitly from Account if you need it.");
  } catch (error) {
    accountMessage(`Could not finish sync or sign out: ${error.message}`, true);
  } finally {
    accountBusy = false;
    renderAccount();
  }
}

function copyGuestChat() {
  if (!accountSession.authenticated || accountBusy || conversationSavePromise) return;
  const guestMessages = loadChatMessages(CHAT_STORAGE_KEY);
  if (!guestMessages.length) return;
  if (chatMessages.length && !window.confirm("Replace the current local account chat with your guest chat? Save your current chat first if needed.")) return;
  chatMessages = guestMessages;
  pinnedMission = loadPinnedMission(MISSION_STORAGE_KEY);
  sourceEntries = guestContextSnapshot.map((context) => entryFromSavedContext(context));
  activeConversationId = null;
  persistActiveConversationId();
  guestMigrationNeedsSave = true;
  clearTimeout(missionSyncTimer);
  missionSyncTimer = null;
  lastSavedSnapshot = null;
  persistChat();
  persistPinnedMission();
  $("account-chat-title").value = conversationTitle();
  if (pinnedMission) ensureMissionRecord(pinnedMission);
  renderSourceResults();
  renderMissionTracker();
  renderChat(true);
  renderAccount();
  accountMessage("Guest chat copied locally. Click Save current chat to store it in your Lab account.");
}

function entryFromSavedContext(context) {
  return {
    id: crypto.randomUUID(), label: context.name, origin: "Saved summary · original unavailable",
    sources: [{ id: "S1", name: context.name, kind: "analysis", digest: context.digest, sample: false }],
    analysis: { summary: context.summary, facts: [], assumptions: [], openQuestions: [] },
    chatContext: context, selected: true
  };
}

async function saveCurrentConversation() {
  if (!accountSession.authenticated || accountBusy || chatBusy || sourceBusy || (!chatMessages.length && !missionTracker.records.length && !onboarding.active)) return;
  accountBusy = true;
  accountMessage("Saving account progress…");
  renderAccount();
  try {
    if (chatMessages.length || onboarding.active || activeConversationId) await writeConversation(true);
    if (missionTracker.records.length || missionDirty) await flushMissionSync();
    accountMessage("Account progress saved.");
    await refreshConversations();
  } catch (error) {
    accountMessage(error.message || "Account data could not be saved.", true);
  } finally {
    accountBusy = false;
    renderAccount();
  }
}

async function openSavedConversation(id) {
  if (!accountSession.authenticated || accountBusy || chatBusy || sourceBusy) return;
  if (guestMigrationNeedsSave && chatMessages.length && !window.confirm("Your copied guest chat is still local. Opening another conversation will replace this copy; the original guest draft remains on this browser. Continue?")) return;
  accountBusy = true;
  accountMessage("Loading conversation…");
  renderAccount();
  try {
    if (!guestMigrationNeedsSave) await writeConversation(false);
    const data = await accountApi("GET", `/api/conversations/${encodeURIComponent(id)}`);
    const conversation = data.conversation;
    if (!conversation || !Array.isArray(conversation.messages)) throw new Error("Saved conversation is incomplete.");
    autosaveMuted = true;
    chatMessages = conversation.messages;
    pinnedMission = conversation.pinnedMission || null;
    recentMissionCompletionId = null;
    missionEvidenceForId = null;
    missionEvidenceExpanded = false;
    expandedMissionId = null;
    pinCandidate = null;
    onboarding.active = !!conversation.onboardingDraft;
    onboarding.step = conversation.onboardingDraft?.step || 0;
    onboarding.answers = conversation.onboardingDraft?.answers || [];
    onboarding.renderedStep = -1;
    sourceEntries = Array.isArray(conversation.sourceContexts) ? conversation.sourceContexts.slice(0, 3).map(entryFromSavedContext) : [];
    pendingAttachment = null;
    $("chat-file-input").value = "";
    $("chat-input").value = "";
    activeConversationId = conversation.id;
    persistActiveConversationId();
    persistChat();
    persistPinnedMission();
    $("account-chat-title").value = conversation.title;
    reconcilePinnedMission();
    renderSourceResults();
    renderMissionTracker();
    renderChat(true);
    lastSavedSnapshot = JSON.stringify(conversationPayload());
    guestMigrationNeedsSave = false;
    autosaveMuted = false;
    accountMessage("Saved conversation loaded. Replies still require you to send a message.");
  } catch (error) {
    accountMessage(error.message || "Could not open conversation.", true);
  } finally {
    autosaveMuted = false;
    accountBusy = false;
    renderAccount();
  }
}

async function deleteSavedConversation(id) {
  if (!accountSession.authenticated || accountBusy || chatBusy || sourceBusy) return;
  const isCurrent = activeConversationId === id;
  const prompt = isCurrent
    ? "Permanently delete this saved conversation? Its local chat view and selected summaries will also be cleared. Mission tracker history remains."
    : "Permanently delete this saved conversation from the Lab server?";
  if (!window.confirm(prompt)) return;
  accountBusy = true;
  renderAccount();
  try {
    clearTimeout(conversationAutosaveTimer);
    conversationAutosaveTimer = null;
    if (conversationSavePromise) await conversationSavePromise;
    await accountApi("DELETE", `/api/conversations/${encodeURIComponent(id)}`);
    if (isCurrent) {
      autosaveMuted = true;
      chatMessages = [];
      pinnedMission = null;
      sourceEntries = [];
      pendingAttachment = null;
      onboarding.active = false;
      $("chat-file-input").value = "";
      $("chat-input").value = "";
      $("account-chat-title").value = "";
      activeConversationId = null;
      lastSavedSnapshot = null;
      persistActiveConversationId();
      persistChat();
      persistPinnedMission();
      renderSourceResults();
      renderChat();
      renderMissionTracker();
      autosaveMuted = false;
    }
    accountMessage(isCurrent ? "Saved conversation deleted and local chat view cleared. Mission history remains." : "Saved conversation deleted.");
    await refreshConversations();
  } catch (error) {
    accountMessage(error.message || "Could not delete conversation.", true);
  } finally {
    autosaveMuted = false;
    accountBusy = false;
    renderAccount();
  }
}

async function deleteDemoAccount() {
  if (!accountSession.authenticated || accountBusy || chatBusy || sourceBusy) return;
  const password = $("account-delete-password").value;
  if (password.length < 12 || password.length > 128) {
    accountMessage("Enter your Lab password to delete this account.", true);
    return;
  }
  if (!window.confirm("Permanently delete this Lab account, all saved chats, mission history, and connected-source sessions? This cannot be undone.")) return;
  const userId = accountSession.user?.id;
  accountBusy = true;
  accountMessage("Deleting demo account…");
  renderAccount();
  clearTimeout(conversationAutosaveTimer);
  clearTimeout(missionSyncTimer);
  try {
    if (conversationSavePromise) await conversationSavePromise.catch(() => {});
    if (missionSyncPromise) await missionSyncPromise.catch(() => {});
    const data = await accountApi("DELETE", "/api/auth/account", { password });
    if (data.deleted !== true || !data.csrfToken) throw new Error("Account deletion was not confirmed by the server.");
    clearAuthenticatedLocalDrafts(userId);
    accountSession = { authenticated: false, user: null, csrfToken: data.csrfToken };
    broadcastAccountChange();
    guestHidden = true;
    try { localStorage.setItem(GUEST_HIDDEN_KEY, "1"); } catch {}
    accountConversations = [];
    guestContextSnapshot = [];
    loadAccountWorkspace();
    accountMessage("Demo account deleted. Saved chats and mission history have been removed from this Lab server.");
  } catch (error) {
    accountMessage(error.message || "Account could not be deleted.", true);
  } finally {
    $("account-delete-password").value = "";
    accountBusy = false;
    renderAccount();
  }
}

$("open-account").addEventListener("click", openAccount);
$("create-account-welcome").addEventListener("click", () => {
  openAccount();
  setAccountMode("signup");
  $("account-email").focus();
});
$("account-close").addEventListener("click", closeAccount);
$("account-backdrop").addEventListener("click", closeAccount);
$("account-login-tab").addEventListener("click", () => setAccountMode("login"));
$("account-signup-tab").addEventListener("click", () => setAccountMode("signup"));
$("account-form").addEventListener("submit", submitAccount);
$("account-logout").addEventListener("click", logoutAccount);
$("account-delete").addEventListener("click", deleteDemoAccount);
$("account-save-chat").addEventListener("click", saveCurrentConversation);
$("account-save-retry").addEventListener("click", async () => {
  if (!accountSession.authenticated || accountBusy || chatBusy || sourceBusy) return;
  accountSaveFailed = false;
  updateSaveIndicator();
  const results = await Promise.allSettled([writeConversation(true), flushMissionSync()]);
  if (results.some((result) => result.status === "rejected")) accountSaveFailed = true;
  updateSaveIndicator();
});
$("account-chat-title").addEventListener("input", scheduleConversationAutosave);
$("account-copy-guest").addEventListener("click", copyGuestChat);
function restoreGuestDraft() {
  if (accountSession.authenticated) return;
  guestHidden = false;
  try { localStorage.removeItem(GUEST_HIDDEN_KEY); } catch {}
  loadAccountWorkspace();
  closeAccount();
  $("chat-input").focus();
}
function startFreshGuestDraft() {
  if (accountSession.authenticated) return;
  const typedMessage = $("chat-input").value;
  for (const key of [STORAGE_KEY, CHAT_STORAGE_KEY, MISSION_STORAGE_KEY, MISSION_TRACKER_STORAGE_KEY, ...(typeof PROJECT_MEMORY_KEY === "string" ? [PROJECT_MEMORY_KEY] : [])]) {
    try { localStorage.removeItem(key); } catch {}
  }
  guestHidden = false;
  try { localStorage.removeItem(GUEST_HIDDEN_KEY); } catch {}
  loadAccountWorkspace();
  $("chat-input").value = typedMessage;
  renderChat();
  setChatStatus("Fresh guest chat ready.");
  $("chat-input").focus();
}
$("account-restore-guest").addEventListener("click", restoreGuestDraft);
$("guest-restore-draft").addEventListener("click", restoreGuestDraft);
$("guest-start-fresh").addEventListener("click", startFreshGuestDraft);
$("account-refresh").addEventListener("click", refreshConversations);
$("account-conversations").addEventListener("click", (event) => {
  const open = event.target.closest("[data-conversation-open]");
  const remove = event.target.closest("[data-conversation-delete]");
  if (open) openSavedConversation(open.dataset.conversationOpen);
  else if (remove) deleteSavedConversation(remove.dataset.conversationDelete);
});
$("account-drawer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeAccount(); return; }
  if (event.key !== "Tab") return;
  const controls = [...$("account-drawer").querySelectorAll("button:not(:disabled), input:not(:disabled)")]
    .filter((node) => node.getClientRects().length > 0 && node.id !== "account-backdrop");
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $("account-panel"))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $("account-panel"))) { event.preventDefault(); first.focus(); }
});

$("open-sources").addEventListener("click", openSources);
$("manage-sources").addEventListener("click", openSources);
$("chat-connectors").addEventListener("click", openConnectorsFromComposer);
$("attach-file").addEventListener("click", chooseChatFile);
$("chat-file-input").addEventListener("change", setChatFile);
$("attached-file-analyze").addEventListener("click", analyzeChatFile);
$("attached-file-remove").addEventListener("click", removeChatFile);
$("start-project").addEventListener("click", openSources);
$("start-idea").addEventListener("click", () => $("chat-input").focus());
$("source-close").addEventListener("click", closeSources);
$("source-backdrop").addEventListener("click", closeSources);
$("analyze-sample").addEventListener("click", analyzeSample);
$("local-source-form").addEventListener("submit", analyzeLocalFile);
$("local-source-file").addEventListener("change", updateSourceControls);
$("github-source-form").addEventListener("submit", analyzeGithub);
$("github-repository").addEventListener("input", updateSourceControls);
$("source-connectors").addEventListener("click", handleSourceCardClick);
$("connector-sign-in").addEventListener("click", () => openConnectorAccount("login"));
$("connector-create-account").addEventListener("click", () => openConnectorAccount("signup"));
$("connector-items-list").addEventListener("change", (event) => {
  if (event.target.matches("input:checked") && $("connector-items-list").querySelectorAll("input:checked").length > 4) {
    event.target.checked = false;
    setSourceStatus("Select at most four connected items for one analysis.", true);
  }
  updateSourceControls();
});
$("connector-import").addEventListener("click", analyzeConnectorItems);
$("connector-items-close").addEventListener("click", closeConnectorItems);
$("source-results-list").addEventListener("change", handleSourceSelection);
$("source-results-list").addEventListener("click", handleSourceRemove);
$("discuss-sources").addEventListener("click", discussSelectedSources);
$("source-drawer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeSources(); return; }
  if (event.key !== "Tab") return;
  const controls = [...$("source-drawer").querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")]
    .filter((node) => node.getClientRects().length > 0 && node.id !== "source-backdrop");
  if (!controls.length) return;
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $("source-panel"))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $("source-panel"))) { event.preventDefault(); first.focus(); }
});
$("chat-form").addEventListener("submit", sendChat);
$("chat-input").addEventListener("focus", collapseMissionInChat);
$("chat-input").addEventListener("input", () => renderChat());
$("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chat-form").requestSubmit();
  }
});
$("chat-messages").addEventListener("click", retryChat);
$("chat-messages").addEventListener("click", handleResponseAction);
$("chat-messages").addEventListener("click", activatePinCandidate);
$("chat-messages").addEventListener("input", handlePinCandidate);
$("chat-messages").addEventListener("click", (event) => {
  const button = event.target.closest("[data-evidence-message-id]");
  const current = activeMissionRecord();
  if (!button || !current || current.id !== button.dataset.missionId) return;
  const message = chatMessages.find((item) => item.id === button.dataset.evidenceMessageId && item.role === "user");
  if (!message) return;
  const evidence = message.content.startsWith(EVIDENCE_PREFIX) ? message.content.slice(EVIDENCE_PREFIX.length).trim() : message.content;
  openMissionEvidence(evidence);
  setMissionFeedback("Result copied from your message. Check it and choose the outcome before saving.");
});
$("mission-approve").addEventListener("click", approvePinnedMission);
$("mission-evidence").addEventListener("click", () => openMissionEvidence());
$("mission-unpin").addEventListener("click", unpinMission);
$("chat-empty").addEventListener("click", sendSuggestion);
$("chat-shortcuts").addEventListener("click", sendSuggestion);
$("export-chat").addEventListener("click", exportChat);
$("reset-chat").addEventListener("click", resetChat);
$("open-decision-canvas").addEventListener("click", openDecisionCanvas);
$("decision-close").addEventListener("click", closeDecisionCanvas);
$("decision-backdrop").addEventListener("click", closeDecisionCanvas);
$("decision-drawer").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeDecisionCanvas();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [...$("decision-drawer").querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")]
    .filter((node) => node.getClientRects().length > 0 && node.id !== "decision-backdrop");
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === $("decision-panel"))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $("decision-panel"))) { event.preventDefault(); first.focus(); }
});
$("use-chat-context").addEventListener("click", useChatContext);
window.addEventListener("focus", refreshDemoUsageWhenVisible);
document.addEventListener("visibilitychange", refreshDemoUsageWhenVisible);
connectorChannel?.addEventListener("message", (event) => {
  const { connector, status } = event.data || {};
  if (!["connected", "error"].includes(status)) return;
  if (!SOURCE_REGISTRY.some((entry) => entry.id === connector && connector !== "github")) return;
  void refreshConnectorAfterOAuth(connector, status);
});
window.addEventListener("focus", () => { if (pendingConnectorId) void refreshConnectorAfterOAuth(pendingConnectorId); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pendingConnectorId) void refreshConnectorAfterOAuth(pendingConnectorId);
});
function closeHeaderMore(restoreFocus = false) {
  $("header-more").open = false;
  if (restoreFocus) $("header-more-trigger").focus();
}
$("header-more").addEventListener("click", (event) => {
  const action = event.target.closest("button");
  if (action && !action.disabled) closeHeaderMore($("header-more").contains(document.activeElement));
});
$("header-more").addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("header-more").open) {
    event.preventDefault();
    event.stopPropagation();
    closeHeaderMore(true);
  }
});
$("header-more").addEventListener("focusout", (event) => {
  if (!$("header-more").contains(event.relatedTarget)) closeHeaderMore();
});
document.addEventListener("pointerdown", (event) => {
  if ($("header-more").open && !$("header-more").contains(event.target)) closeHeaderMore();
});
if (typeof initGrowthFeatures === "function") initGrowthFeatures();
if (typeof initDemoTour === "function") initDemoTour();
renderChat(true);
void refreshDemoUsage();
initializeAccount().then(() => {
  if (document.fonts?.ready) document.fonts.ready.then(scrollChatToLatest);
  const connectorReturn = new URLSearchParams(window.location.search);
  if (SOURCE_REGISTRY.some((entry) => entry.id === connectorReturn.get("connector")) && ["connected", "error"].includes(connectorReturn.get("status"))) {
    const connected = connectorReturn.get("status") === "connected";
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    openSources();
    setSourceStatus(connected ? "Account connection completed. Choose items to bring into Lia's analysis." : "Account connection failed or was cancelled. You can retry here.", !connected);
  }
});
