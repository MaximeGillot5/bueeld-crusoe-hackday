"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const projectView = byId("build-project-view");
  const roadmapView = byId("build-roadmap-view");
  const liaView = document.querySelector(".chat-workspace");
  if (!projectView || !roadmapView || !liaView) return;

  let snapshot = null;
  let selectedMission = null;
  let currentView = "project";
  let requestGeneration = 0;
  let pendingValidation = null;
  let evidenceSourceKind = "manual";
  let lastMissionOpener = null;
  let lastRoadmapOpener = null;
  const metricMilestones = new Set(["problem_priority", "engagement_signal", "essential_task_success"]);

  function text(node, value) { node.textContent = value == null ? "" : String(value); }
  function getAccount() { return typeof accountSession !== "undefined" ? accountSession : { authenticated: false }; }
  function currentMission() { return selectedMission || snapshot?.nextMission || null; }
  function missionId(mission) { return String(mission?.milestoneId || mission?.id || ""); }
  function readableError(error) { return error?.message || "The request could not be completed. Please try again."; }

  function selectView(name, options = {}) {
    if (!byId("build-mission-details").hidden) closeMission(false);
    currentView = ["project", "roadmap", "lia"].includes(name) ? name : "project";
    if (currentView === "roadmap") lastRoadmapOpener = document.activeElement;
    projectView.hidden = currentView === "lia";
    roadmapView.hidden = currentView !== "roadmap";
    liaView.hidden = currentView !== "lia";
    projectView.inert = currentView === "roadmap";
    document.body.classList.toggle("build-modal-open", currentView === "roadmap");
    document.body.dataset.buildView = currentView;
    document.querySelectorAll(".build-nav-link").forEach((button) => {
      if (button.dataset.buildView === currentView) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (currentView !== "lia") void refresh();
    if (options.focus) {
      if (currentView === "lia") byId("chat-input")?.focus();
      else if (currentView === "roadmap") byId("build-roadmap-close")?.focus();
      else byId("build-project-title")?.focus?.();
    }
  }

  function closeRoadmap() {
    selectView("project");
    history.replaceState(null, "", "#project");
    if (lastRoadmapOpener instanceof HTMLElement) lastRoadmapOpener.focus();
  }

  function closeMission(restoreFocus = true) {
    byId("build-mission-details").hidden = true;
    byId("build-mission-backdrop").hidden = true;
    document.body.classList.toggle("build-modal-open", currentView === "roadmap");
    if (restoreFocus && lastMissionOpener instanceof HTMLElement) lastMissionOpener.focus();
  }

  function showMission(mission) {
    lastMissionOpener = document.activeElement;
    renderMissionDetails(mission);
    byId("build-mission-details").hidden = false;
    byId("build-mission-backdrop").hidden = false;
    document.body.classList.add("build-modal-open");
    byId("build-mission-details").focus();
  }

  function accountState(message) {
    snapshot = null;
    byId("build-home-grid").hidden = false;
    byId("build-maturity-value").textContent = "—";
    byId("build-maturity-progress").value = 0;
    byId("build-maturity-progress").setAttribute("aria-valuetext", "Project maturity unavailable");
    text(byId("build-maturity-status"), "Sign in to begin");
    text(byId("build-next-title"), "Start with your project.");
    text(byId("build-next-description"), "Tell Lia what you are building, who it serves, and what you need to learn next.");
    byId("build-mission-gain").hidden = true;
    byId("build-next-criterion").hidden = true;
    byId("build-mission-details").hidden = true;
    text(byId("build-state-note"), message);
    text(byId("build-next-action"), "Create a project →");
    byId("build-roadmap-percent").textContent = "—";
    const roadmap = byId("build-roadmap-list");
    roadmap.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "build-roadmap-empty";
    const title = document.createElement("h2"); title.textContent = "Your mission path starts here.";
    const description = document.createElement("p"); description.textContent = "Sign in to see the four dimensions, evidence milestones and points for your project.";
    const open = document.createElement("button"); open.type = "button"; open.className = "build-primary-button"; open.textContent = "Sign in or create account →";
    open.addEventListener("click", () => { closeRoadmap(); byId("open-account")?.click(); });
    empty.append(title, description, open);
    roadmap.append(empty);
  }

  function renderRoadmap(maturity) {
    const milestones = Array.isArray(maturity?.milestones) ? maturity.milestones : [];
    const rawDimensions = Array.isArray(maturity?.dimensions) ? maturity.dimensions
      : maturity?.dimensions && typeof maturity.dimensions === "object"
        ? Object.entries(maturity.dimensions).map(([id, dimension]) => ({ id, ...dimension })) : [];
    const labels = { need: "Customer need", demand: "Demand", solution: "Solution", viability: "Pilot viability", customer_need: "Customer need", pilot_viability: "Pilot viability" };
    const list = byId("build-roadmap-list");
    list.replaceChildren();
    if (!rawDimensions.length) {
      const note = document.createElement("p");
      note.className = "build-roadmap-note";
      note.textContent = "The detailed mission path is not available yet. Your project score is still shown on the Project page.";
      list.append(note);
      return;
    }
    for (const dimension of rawDimensions) {
      const id = String(dimension.id || dimension.key || "");
      const title = dimension.title || dimension.label || dimension.name || labels[id] || "Project dimension";
      const total = Number(dimension.total ?? dimension.weight ?? dimension.maxPoints ?? 25);
      const earned = Number(dimension.earned ?? dimension.score ?? dimension.pointsEarned ?? 0);
      const group = document.createElement("section");
      group.className = "build-roadmap-group";
      const header = document.createElement("header");
      const heading = document.createElement("h2");
      heading.textContent = title;
      const score = document.createElement("strong");
      score.textContent = `${Math.max(0, earned)} / ${total}`;
      header.append(heading, score);
      group.append(header);
      const ownMilestones = Array.isArray(dimension.milestones) ? dimension.milestones : milestones.filter((item) => [item.dimensionId, item.dimension, item.category].includes(id));
      const items = document.createElement("ul");
      if (!ownMilestones.length) {
        const item = document.createElement("li");
        item.textContent = "Milestone details will appear here when the path is loaded.";
        items.append(item);
      }
      for (const milestone of ownMilestones) {
        const item = document.createElement("li");
        item.dataset.validated = String(milestone.validated === true || milestone.status === "validated" || milestone.status === "earned");
        const titleNode = document.createElement("span");
        titleNode.textContent = milestone.title || milestone.label || "Mission milestone";
        const points = document.createElement("b");
        points.textContent = `${Number(milestone.weight ?? milestone.points ?? 0)} pts`;
        item.append(titleNode, points);
        const milestoneId = String(milestone.id || milestone.milestoneId || "");
        if (metricMilestones.has(milestoneId) && !milestone.validated) {
          const prepared = milestone.plannedCriterion?.criterion;
          if (prepared) {
            const label = document.createElement("small");
            label.className = "build-roadmap-criterion";
            label.textContent = `Threshold fixed: ${prepared.comparison.replaceAll("_", " ")} ${prepared.threshold} ${prepared.unit}`;
            item.append(label);
          } else {
            const action = document.createElement("button");
            action.type = "button";
            action.className = "build-text-link build-roadmap-open";
            action.textContent = "Set threshold →";
            const form = document.createElement("form");
            form.className = "build-criterion-form";
            form.hidden = true;
            const comparison = document.createElement("select");
            comparison.setAttribute("aria-label", "How the result is compared");
            for (const [value, label] of [["at_least", "At least"], ["more_than", "More than"], ["at_most", "At most"]]) {
              const option = document.createElement("option"); option.value = value; option.textContent = label; comparison.append(option);
            }
            const threshold = document.createElement("input");
            threshold.type = "number"; threshold.step = "any"; threshold.required = true; threshold.placeholder = "Target"; threshold.setAttribute("aria-label", "Numeric target");
            const unit = document.createElement("input");
            unit.type = "text"; unit.maxLength = 60; unit.required = true; unit.placeholder = "Unit, e.g. percent"; unit.setAttribute("aria-label", "Metric unit");
            const save = document.createElement("button"); save.type = "submit"; save.textContent = "Fix criterion";
            const message = document.createElement("span"); message.setAttribute("role", "status");
            form.append(comparison, threshold, unit, save, message);
            action.addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) threshold.focus(); });
            form.addEventListener("submit", async (event) => {
              event.preventDefault();
              if (!form.reportValidity()) return;
              save.disabled = true;
              message.textContent = "Saving…";
              try {
                await accountApi("POST", `/api/projects/current/milestones/${encodeURIComponent(milestoneId)}/criterion`, {
                  criterion: { comparison: comparison.value, threshold: Number(threshold.value), unit: unit.value.trim() }
                });
                await refresh();
              } catch (error) { message.textContent = readableError(error); save.disabled = false; }
            });
            item.append(action, form);
          }
        }
        if (milestoneId === "interest_test") {
          const open = document.createElement("button");
          open.type = "button";
          open.className = "build-text-link build-roadmap-open";
          open.textContent = "Open test →";
          open.addEventListener("click", openInterestTest);
          item.append(open);
        }
        items.append(item);
      }
      group.append(items);
      list.append(group);
    }
  }

  function renderMissionDetails(mission) {
    text(byId("build-mission-details-title"), mission.title || "Your mission");
    const criterion = mission.criterion || mission.successCriterion || mission.evidenceRequired;
    const steps = Array.isArray(mission.steps) && mission.steps.length ? mission.steps.slice(0, 3) : [
      "Review the evidence criterion before starting.",
      "Run the test or complete the task with your real project.",
      "Record what happened and submit the result for validation."
    ];
    const stepList = byId("build-mission-steps");
    stepList.replaceChildren(...steps.map((step) => {
      const item = document.createElement("li");
      item.textContent = typeof step === "string" ? step : step?.title || step?.description || "Complete this step";
      return item;
    }));
    text(byId("build-mission-proof"), criterion ? `Validation criterion: ${criterion}` : "Describe the observed result and attach a source when you have one. BUEELD will only add points after the evidence is validated.");
    const id = missionId(mission);
    const isMetric = metricMilestones.has(id);
    const prepared = snapshot?.maturity?.milestones?.find((item) => item.id === id)?.plannedCriterion?.criterion;
    byId("build-evidence-metric").hidden = !isMetric;
    byId("build-evidence-observed").required = isMetric && Boolean(prepared);
    byId("build-evidence-submit").disabled = isMetric && !prepared;
    byId("build-evidence-metric-criterion").textContent = isMetric
      ? prepared ? `Predeclared threshold: ${prepared.comparison.replaceAll("_", " ")} ${prepared.threshold} ${prepared.unit}. Record the observed value below.`
        : "First set a numeric threshold on the Missions page. It must be fixed before this result is submitted."
      : "";
    const learnedOption = byId("build-evidence-outcome").querySelector('option[value="learned"]');
    learnedOption.hidden = isMetric;
    if (isMetric) byId("build-evidence-outcome").value = "met";
    window.dispatchEvent(new CustomEvent("build:mission-opened", { detail: { mission } }));
  }

  function renderMission(mission, maturity) {
    const score = Number(maturity?.percent);
    const hasScore = Number.isInteger(score) && score >= 0 && score <= 100;
    text(byId("build-maturity-value"), hasScore ? score : "—");
    byId("build-maturity-progress").value = hasScore ? score : 0;
    byId("build-maturity-progress").setAttribute("aria-valuetext", hasScore ? `${score} percent of first-pilot readiness` : "Project maturity unavailable");
    text(byId("build-roadmap-percent"), hasScore ? `${score}%` : "—");
    const mature = score === 100;
    text(byId("build-maturity-status"), mature ? "Project at maturity" : "Building toward your first pilot");
    text(byId("build-maturity-copy"), mature ? "All first-pilot milestones have been validated. Your next step is to launch the pilot." : "Each validated mission adds its announced points toward a first pilot.");
    if (!mission) {
      text(byId("build-next-title"), mature ? "Launch your first pilot." : "Your next mission is being prepared.");
      text(byId("build-next-description"), mature ? "Your project has reached 100% on this readiness path." : "Ask Lia to identify the next missing milestone and the evidence that would validate it.");
      byId("build-mission-gain").hidden = true;
      byId("build-next-criterion").hidden = true;
      text(byId("build-next-action"), mature ? "Talk through pilot launch →" : "Plan a mission with Lia →");
      byId("build-mission-details").hidden = true;
      return;
    }
    const gain = Number(mission.gain ?? mission.weight ?? mission.points);
    text(byId("build-next-title"), mission.title || "Your next mission");
    text(byId("build-next-description"), mission.description || mission.summary || "Complete the mission and collect the evidence needed for validation.");
    const gainNode = byId("build-mission-gain");
    gainNode.hidden = !Number.isInteger(gain) || gain <= 0;
    if (!gainNode.hidden) text(gainNode, `+${gain} pts`);
    const criterion = mission.criterion || mission.successCriterion || mission.evidenceRequired;
    const criterionNode = byId("build-next-criterion");
    criterionNode.hidden = !criterion;
    if (criterion) criterionNode.textContent = `Evidence needed: ${criterion}`;
    text(byId("build-next-action"), mature ? "Discuss pilot launch with Lia →" : "Open mission →");
    if (!selectedMission) renderMissionDetails(mission);
  }

  function render(data) {
    snapshot = data;
    byId("build-home-grid").hidden = false;
    const project = data?.project || {};
    text(byId("build-project-title"), project.name || project.title || (projectMemory?.project || "Your project"));
    text(byId("build-project-summary"), project.summary || project.description || projectMemory?.goal || "A clear path from your current question to a first pilot.");
    text(byId("build-state-note"), "");
    renderMission(data?.nextMission || null, data?.maturity || {});
    if (selectedMission) renderMissionDetails(selectedMission);
    renderRoadmap(data?.maturity || {});
    window.dispatchEvent(new CustomEvent("build:maturity-loaded", { detail: { mission: currentMission(), snapshot: data } }));
  }

  async function refresh() {
    if (typeof accountReady === "undefined" || !accountReady) return;
    const generation = ++requestGeneration;
    if (!getAccount().authenticated) {
      text(byId("build-project-title"), "Build your next move.");
      text(byId("build-project-summary"), "Create an account to keep your project, missions and evidence together.");
      accountState("Sign in or create a Lab account to see your project's maturity.");
      return;
    }
    try {
      const data = await accountApi("GET", "/api/projects/current/maturity");
      if (generation !== requestGeneration) return;
      render(data);
    } catch (error) {
      if (generation !== requestGeneration) return;
      if (error.status === 401) {
        accountState("Your session ended. Sign in to return to your project.");
      } else {
        text(byId("build-state-note"), `Project progress is unavailable: ${readableError(error)}`);
        if (!snapshot) accountState(`Project progress is unavailable: ${readableError(error)}`);
      }
    }
  }

  function openContext() {
    selectView("lia");
    const memory = byId("project-memory-panel");
    if (memory) { memory.open = true; memory.scrollIntoView({ block: "nearest" }); }
    byId("memory-project")?.focus();
  }

  function openNextMission() {
    if (!getAccount().authenticated) { byId("open-account")?.click(); return; }
    selectedMission = null;
    const mission = currentMission();
    if (Number(snapshot?.maturity?.percent) === 100 || mission?.id === "launch_pilot") {
      selectView("lia"); byId("chat-input")?.focus(); return;
    }
    if (!mission) { selectView("lia"); byId("chat-input")?.focus(); return; }
    showMission(mission);
  }

  function openInterestTest() {
    if (!getAccount().authenticated) { byId("open-account")?.click(); return; }
    const milestones = snapshot?.maturity?.milestones || [];
    const milestone = milestones.find((item) => String(item.id || item.milestoneId) === "interest_test") || {};
    selectedMission = {
      id: "interest_test",
      milestoneId: "interest_test",
      title: milestone.title || "Test interest with your target audience",
      description: milestone.description || "Publish one focused question, collect responses, and review what you learned.",
      criterion: milestone.criterion || "Run the test, close it, and review the actual responses.",
      gain: milestone.weight ?? 5,
      steps: ["Define one hypothesis and a threshold.", "Approve and share the public form.", "Close the test, review responses, and record what you learned."]
    };
    selectView("project");
    showMission(selectedMission);
  }

  function prefillEvidence({ summary, experimentId, outcome = "learned" }) {
    if (!summary || !experimentId) return;
    evidenceSourceKind = "experiment";
    byId("build-evidence-summary").value = summary.slice(0, 1500);
    byId("build-evidence-reference").value = experimentId;
    byId("build-evidence-outcome").value = outcome;
    byId("build-evidence-form").scrollIntoView({ behavior: "smooth", block: "start" });
    byId("build-evidence-real").focus();
    const note = byId("build-evidence-status");
    note.dataset.error = "false";
    note.textContent = "Review the result, confirm that it is real, then submit it for mission validation.";
  }

  async function submitEvidence(event) {
    event.preventDefault();
    const mission = currentMission();
    const id = missionId(mission);
    if (!getAccount().authenticated || !id) return;
    const summary = byId("build-evidence-summary").value.trim();
    const reference = byId("build-evidence-reference").value.trim();
    const outcome = byId("build-evidence-outcome").value;
    const metric = metricMilestones.has(id);
    const prepared = metric ? snapshot?.maturity?.milestones?.find((item) => item.id === id)?.plannedCriterion?.criterion : null;
    const feedback = byId("build-evidence-status");
    if (summary.length < 30 || !byId("build-evidence-real").checked) {
      feedback.dataset.error = "true";
      text(feedback, "Add at least 30 characters of real observations and confirm their origin.");
      return;
    }
    if (metric && (!prepared || byId("build-evidence-observed").value.trim() === "")) {
      feedback.dataset.error = "true";
      text(feedback, "Fix the criterion before the mission, then enter the measured result.");
      return;
    }
    const button = byId("build-evidence-submit");
    button.disabled = true;
    feedback.dataset.error = "false";
    text(feedback, "Checking this milestone…");
    if (!pendingValidation || pendingValidation.missionId !== id || pendingValidation.summary !== summary) {
      pendingValidation = { missionId: id, summary, requestId: crypto.randomUUID() };
    }
    try {
      const response = await accountApi("POST", `/api/projects/current/milestones/${encodeURIComponent(id)}/validate`, {
        evidence: { summary, ...(reference ? { reference } : {}), real: true,
          ...(metric ? { criterion: prepared, observed: Number(byId("build-evidence-observed").value) } : {}) },
        source: { kind: evidenceSourceKind, ...(reference ? { reference } : {}) },
        outcome,
        requestId: pendingValidation.requestId
      });
      pendingValidation = null;
      const before = Number(snapshot?.maturity?.percent);
      await refresh();
      const after = Number(snapshot?.maturity?.percent);
      text(feedback, Number.isInteger(before) && Number.isInteger(after) && after > before
        ? `Mission validated · ${before}% → ${after}%.`
        : response?.message || "Evidence saved. The milestone will progress when its criterion is met.");
      byId("build-evidence-form").reset();
      evidenceSourceKind = "manual";
      if (after > before) closeMission();
    } catch (error) {
      feedback.dataset.error = "true";
      text(feedback, readableError(error));
    } finally { button.disabled = false; }
  }

  for (const button of document.querySelectorAll(".build-nav-link")) button.addEventListener("click", () => {
    const name = button.dataset.buildView;
    history.replaceState(null, "", name === "project" ? "#project" : name === "roadmap" ? "#missions" : "#lia");
    selectView(name, { focus: true });
  });
  byId("build-open-roadmap").addEventListener("click", () => selectView("roadmap", { focus: true }));
  byId("build-roadmap-close").addEventListener("click", closeRoadmap);
  byId("build-roadmap-backdrop").addEventListener("click", closeRoadmap);
  byId("build-ask-lia").addEventListener("click", () => selectView("lia", { focus: true }));
  byId("build-edit-context").addEventListener("click", openContext);
  byId("build-open-sources").addEventListener("click", () => byId("open-sources")?.click());
  byId("build-next-action").addEventListener("click", openNextMission);
  byId("build-mission-details-close").addEventListener("click", closeMission);
  byId("build-mission-backdrop").addEventListener("click", closeMission);
  byId("build-evidence-form").addEventListener("submit", submitEvidence);
  window.addEventListener("hashchange", () => selectView(location.hash === "#missions" ? "roadmap" : location.hash === "#lia" ? "lia" : "project", { focus: true }));
  document.addEventListener("keydown", (event) => {
    const missionOpen = !byId("build-mission-details").hidden;
    const dialog = missionOpen ? byId("build-mission-details") : currentView === "roadmap" ? roadmapView : null;
    if (!dialog) return;
    if (event.key === "Escape") { event.preventDefault(); missionOpen ? closeMission() : closeRoadmap(); return; }
    if (event.key !== "Tab") return;
    const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]')]
      .filter((node) => !node.hidden && node.getClientRects().length > 0 && !node.classList.contains("build-roadmap-backdrop"));
    if (!controls.length) return;
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  window.addEventListener("focus", () => { if (currentView !== "lia") void refresh(); });
  window.addEventListener("build:workspace-changed", () => { void refresh(); });
  window.BUILDHome = { current: currentMission, refresh, openMission: openNextMission, openInterestTest, prefillEvidence, selectView };
  selectView(location.hash === "#missions" ? "roadmap" : location.hash === "#lia" ? "lia" : "project", { focus: location.hash === "#missions" });
  const readyPoll = setInterval(() => {
    if (typeof accountReady !== "undefined" && accountReady) { clearInterval(readyPoll); void refresh(); }
  }, 100);
  setTimeout(() => clearInterval(readyPoll), 15000);
})();
