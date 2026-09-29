"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const projectView = byId("build-project-view");
  const roadmapView = byId("build-roadmap-view");
  const liaView = document.querySelector(".chat-workspace");
  if (!projectView || !roadmapView || !liaView) return;
  const readinessCard = projectView.querySelector(".build-maturity-card");

  let snapshot = null;
  let selectedMission = null;
  let currentView = "project";
  let requestGeneration = 0;
  let pendingValidation = null;
  let evidenceSourceKind = "manual";
  let lastMissionOpener = null;
  let missionReturnView = null;
  let lastRoadmapOpener = null;
  let roadmapTab = "current";
  let roadmapAutoSelect = false;
  const metricMilestones = new Set(["problem_priority", "engagement_signal", "essential_task_success"]);

  function text(node, value) { node.textContent = value == null ? "" : String(value); }
  function getAccount() { return typeof accountSession !== "undefined" ? accountSession : { authenticated: false }; }
  function currentMission() { return selectedMission || snapshot?.nextMission || null; }
  function missionId(mission) { return String(mission?.milestoneId || mission?.id || ""); }
  function readableError(error) { return error?.message || "The request could not be completed. Please try again."; }
  function isValidated(milestone) { return milestone?.validated === true || ["validated", "earned"].includes(milestone?.status); }

  function guidedMissionsInProgress(milestones) {
    if (!getAccount().authenticated) return [];
    const activeId = typeof readinessMissionId === "string" && readinessMissionId
      ? readinessMissionId : typeof readinessResumeMissionId === "string" ? readinessResumeMissionId : "";
    const linked = typeof readinessMissionChats !== "undefined" ? readinessMissionChats : new Map();
    return milestones.filter((item) => !isValidated(item) &&
      (missionId(item) === activeId || linked.has(missionId(item)) ||
        item.draft?.answers?.some((answer) => answer?.trim()) || item.plannedCriterion))
      .sort((a, b) => Number(missionId(b) === activeId) - Number(missionId(a) === activeId) ||
        (linked.get(missionId(b))?.updatedAt || 0) - (linked.get(missionId(a))?.updatedAt || 0));
  }

  function guidedMissionInProgress(milestones) {
    return guidedMissionsInProgress(milestones)[0] || null;
  }

  function resumeGuidedMission(mission) {
    const id = missionId(mission);
    if (!id) return;
    history.replaceState(null, "", "#lia");
    selectView("lia", { focus: true });
    window.dispatchEvent(new CustomEvent("build:mission-guide", { detail: { missionId: id } }));
  }

  function selectView(name, options = {}) {
    if (!byId("build-mission-details").hidden) closeMission(false);
    const openingRoadmap = name === "roadmap" && currentView !== "roadmap";
    currentView = ["project", "roadmap", "lia"].includes(name) ? name : "project";
    if (currentView === "roadmap") lastRoadmapOpener = document.activeElement;
    if (openingRoadmap) {
      roadmapAutoSelect = true;
      roadmapTab = guidedMissionInProgress(snapshot?.maturity?.milestones || []) ? "progress" : "current";
      if (snapshot) renderRoadmap(snapshot.maturity);
    }
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
    selectedMission = null;
    const returnView = missionReturnView;
    missionReturnView = null;
    if (returnView && currentView !== returnView) {
      history.replaceState(null, "", returnView === "lia" ? "#lia" : "#project");
      selectView(returnView);
    }
    if (restoreFocus && lastMissionOpener instanceof HTMLElement) lastMissionOpener.focus();
  }

  function setMissionStage(stage) {
    const brief = byId("build-mission-brief");
    const work = byId("build-mission-work");
    const success = byId("build-mission-success");
    const interestTest = missionId(currentMission()) === "interest_test";
    brief.hidden = stage !== "brief";
    work.hidden = !["work", "evidence"].includes(stage);
    success.hidden = stage !== "success";
    work.dataset.stage = stage === "work" && interestTest ? "experiment" : "evidence";
    byId("build-experiment-card").hidden = work.dataset.stage !== "experiment";
    byId("build-evidence-form").hidden = work.dataset.stage !== "evidence";
    if (stage === "work" || stage === "evidence") byId("build-mission-work-title").focus();
    if (stage === "success") byId("build-mission-success-close").focus();
  }

  function showMission(mission) {
    lastMissionOpener = document.activeElement;
    renderMissionDetails(mission);
    setMissionStage("brief");
    byId("build-mission-details").hidden = false;
    byId("build-mission-backdrop").hidden = false;
    document.body.classList.add("build-modal-open");
    byId("build-mission-details").focus();
    window.dispatchEvent(new CustomEvent("build:mission-opened", { detail: { mission } }));
  }

  function accountState(message) {
    snapshot = null;
    byId("build-home-grid").hidden = false;
    readinessCard.dataset.state = "unstarted";
    projectView.dataset.readinessState = "unstarted";
    text(byId("build-readiness-index"), "4 STAGES");
    text(byId("build-maturity-title"), "Your pilot starts here.");
    text(byId("build-maturity-copy"), "Create your project to unlock a first mission and a clear path to your pilot.");
    text(byId("build-readiness-start").querySelector(".build-readiness-start-label"), "Create your project");
    byId("build-maturity-value").textContent = "—";
    byId("build-maturity-value").nextElementSibling.hidden = true;
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
    roadmapTab = "current";
    syncRoadmapTabs(0, 0);
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

  function syncRoadmapTabs(inProgressCount, pastCount) {
    text(byId("build-roadmap-progress-count"), inProgressCount);
    text(byId("build-roadmap-past-count"), pastCount);
    for (const tab of byId("build-roadmap-view").querySelectorAll("[data-roadmap-tab]")) {
      const active = tab.dataset.roadmapTab === roadmapTab;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    byId("build-roadmap-list").setAttribute("aria-labelledby", `build-roadmap-tab-${roadmapTab}`);
  }

  function setRoadmapTab(tab, focus = false) {
    if (!["current", "progress", "past"].includes(tab)) return;
    roadmapAutoSelect = false;
    roadmapTab = tab;
    renderRoadmap(snapshot?.maturity || {});
    if (focus) byId(`build-roadmap-tab-${tab}`).focus();
  }

  function roadmapEmpty(title, description) {
    const empty = document.createElement("div");
    empty.className = "build-roadmap-empty-view";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const copy = document.createElement("p");
    copy.textContent = description;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "build-text-link";
    action.textContent = "View current path →";
    action.addEventListener("click", () => setRoadmapTab("current", true));
    empty.append(heading, copy, action);
    return empty;
  }

  function renderRoadmapFocus(mission) {
    const draft = mission.draft || {};
    const answers = Array.isArray(draft.answers) ? draft.answers : [];
    const reviewed = Array.isArray(draft.reviewed) ? draft.reviewed : [];
    const questions = Array.isArray(mission.questions) ? mission.questions : [];
    const total = questions.length || Number(draft.totalSteps) || 0;
    const count = Math.min(total, Number(draft.answeredCount) || 0);
    const nextIndex = questions.findIndex((_, index) => !answers[index]?.trim() || reviewed[index] !== true);
    const focus = document.createElement("section");
    focus.className = "build-roadmap-focus";
    const top = document.createElement("div");
    top.className = "build-roadmap-focus-top";
    const kicker = document.createElement("span");
    kicker.className = "build-roadmap-focus-kicker";
    const linked = typeof readinessMissionChats !== "undefined" ? readinessMissionChats.get(missionId(mission)) : null;
    kicker.textContent = linked?.paused || (!linked && typeof readinessPaused !== "undefined" && readinessPaused)
      ? "PAUSED · READY TO RESUME" : "IN PROGRESS · WITH LIA";
    const score = document.createElement("span");
    score.className = "build-roadmap-state";
    score.textContent = total ? `${count} / ${total} reviewed` : "Ready to begin";
    top.append(kicker, score);
    const title = document.createElement("h2");
    title.className = "build-roadmap-focus-title";
    title.textContent = mission.title || "Your mission";
    const copy = document.createElement("p");
    copy.className = "build-roadmap-focus-copy";
    copy.textContent = mission.description || "Continue working through this mission with Lia.";
    const progressRow = document.createElement("div");
    progressRow.className = "build-roadmap-focus-progress";
    const progress = document.createElement("progress");
    progress.max = Math.max(1, total);
    progress.value = count;
    progress.setAttribute("aria-label", "Mission answers reviewed by Lia");
    const progressLabel = document.createElement("span");
    progressLabel.textContent = total ? `${count} of ${total} answers reviewed` : "Ready for the first question";
    progressRow.append(progress, progressLabel);
    const question = document.createElement("p");
    question.className = "build-roadmap-focus-question";
    question.textContent = nextIndex >= 0 ? `Next with Lia: ${questions[nextIndex]}`
      : "All answers reviewed. Confirm them in the chat when they reflect your real project.";
    const actions = document.createElement("div");
    actions.className = "build-roadmap-focus-actions";
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "build-primary-button";
    resume.textContent = "Resume mission with Lia →";
    resume.addEventListener("click", () => resumeGuidedMission(mission));
    const note = document.createElement("span");
    note.textContent = "Lia analyzes each chat reply before it becomes a mission answer.";
    actions.append(resume, note);
    focus.append(top, title, copy, progressRow, question, actions);
    return focus;
  }

  function renderRoadmap(maturity) {
    const milestones = Array.isArray(maturity?.milestones) ? maturity.milestones : [];
    const inProgressMissions = guidedMissionsInProgress(milestones);
    const pastCount = milestones.filter(isValidated).length;
    syncRoadmapTabs(inProgressMissions.length, pastCount);
    const rawDimensions = Array.isArray(maturity?.dimensions) ? maturity.dimensions
      : maturity?.dimensions && typeof maturity.dimensions === "object"
        ? Object.entries(maturity.dimensions).map(([id, dimension]) => ({ id, ...dimension })) : [];
    const labels = { need: "Customer need", demand: "Demand", solution: "Solution", viability: "Pilot viability", customer_need: "Customer need", pilot_viability: "Pilot viability" };
    const list = byId("build-roadmap-list");
    list.replaceChildren();
    if (roadmapTab === "progress") {
      list.append(...(inProgressMissions.length ? inProgressMissions.map(renderRoadmapFocus)
        : [roadmapEmpty("No mission in progress yet.", "Open your current path and start a mission with Lia. It will appear here while you work on it.")]));
      return;
    }
    if (roadmapTab === "past" && !pastCount) {
      list.append(roadmapEmpty("No past missions yet.", "Completed missions will collect here after their project evidence is confirmed."));
      return;
    }
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
      const dimensionMilestones = Array.isArray(dimension.milestones) ? dimension.milestones : milestones.filter((item) => [item.dimensionId, item.dimension, item.category].includes(id));
      const ownMilestones = roadmapTab === "past" ? dimensionMilestones.filter(isValidated) : dimensionMilestones;
      if (roadmapTab === "past" && !ownMilestones.length) continue;
      const items = document.createElement("ul");
      if (!ownMilestones.length) {
        const item = document.createElement("li");
        item.textContent = "Milestone details will appear here when the path is loaded.";
        items.append(item);
      }
      for (const milestone of ownMilestones) {
        const item = document.createElement("li");
        item.dataset.validated = String(isValidated(milestone));
        const milestoneId = missionId(milestone);
        const active = inProgressMissions.some((mission) => missionId(mission) === milestoneId);
        item.classList.toggle("is-in-progress", Boolean(active));
        const titleNode = document.createElement("span");
        titleNode.textContent = milestone.title || milestone.label || "Mission milestone";
        const points = document.createElement("b");
        points.textContent = `${Number(milestone.weight ?? milestone.points ?? 0)} pts`;
        item.append(titleNode, points);
        if (roadmapTab === "past" && milestone.validatedAt) {
          const date = new Date(milestone.validatedAt);
          if (Number.isFinite(date.getTime())) {
            const when = document.createElement("time");
            when.className = "build-roadmap-past-date";
            when.dateTime = date.toISOString();
            when.textContent = `Completed ${date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
            item.append(when);
          }
        }
        if (active) {
          const state = document.createElement("small");
          state.className = "build-roadmap-state";
          state.textContent = "In progress";
          const resume = document.createElement("button");
          resume.type = "button";
          resume.className = "build-text-link build-roadmap-open";
          resume.textContent = "Resume with Lia →";
          resume.addEventListener("click", () => resumeGuidedMission(milestone));
          item.append(state, resume);
        }
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
    text(byId("build-mission-description"), mission.description || mission.summary || "Make one useful move, then bring back what actually happened.");
    const criterion = mission.criterion || mission.successCriterion || mission.evidenceRequired;
    const steps = Array.isArray(mission.steps) && mission.steps.length ? mission.steps.slice(0, 3) : [
      "Review the evidence criterion before starting.",
      "Run the test or complete the task with your real project.",
      "Record what happened and submit the result for validation."
    ];
    const stepList = byId("build-mission-steps");
    const answers = Array.isArray(mission.draft?.answers) ? mission.draft.answers : [];
    stepList.replaceChildren(...steps.map((step, index) => {
      const item = document.createElement("li");
      item.textContent = typeof step === "string" ? step : step?.title || step?.description || "Complete this step";
      item.classList.toggle("is-answered", Boolean(answers[index]?.trim()));
      return item;
    }));
    text(byId("build-mission-proof"), criterion || "Describe the observed result and attach a source when you have one. Only validated real evidence adds maturity.");
    text(byId("build-mission-checkpoints-label"), `${steps.length} CHECKPOINT${steps.length === 1 ? "" : "S"}`);
    const id = missionId(mission);
    const documentary = id === "target_problem" || id === "value_proposition" || id === "prototype_scope" || id === "price_and_costs" || id === "pilot_ready";
    text(byId("build-mission-details").querySelector(".build-mission-proof strong"), documentary ? "What to document" : "What counts as proof");
    text(byId("build-mission-details").querySelector(".build-mission-brief-actions > span"), documentary
      ? "Lia will guide you through these details. Review and confirm your own project information before this milestone is credited."
      : "Progress is earned only after your real result is validated.");
    const isMetric = metricMilestones.has(id);
    const milestone = snapshot?.maturity?.milestones?.find((item) => item.id === id);
    const prepared = milestone?.plannedCriterion?.criterion;
    const validated = milestone?.validated === true || milestone?.status === "validated" || milestone?.status === "earned";
    const gain = Number(mission.gain ?? mission.weight ?? mission.points);
    const score = Number(snapshot?.maturity?.percent);
    const hasScore = Number.isInteger(score) && score >= 0 && score <= 100;
    const reward = Number.isInteger(gain) && gain > 0 ? gain : 0;
    text(byId("build-mission-reward-label"), validated ? "ALREADY EARNED" : documentary ? "ON CONFIRMATION" : "ON VALIDATION");
    text(byId("build-mission-reward"), reward ? `+${reward}%` : "—");
    text(byId("build-mission-current-maturity"), hasScore ? `${score}%` : "—");
    byId("build-mission-progress-bar").value = hasScore ? score : 0;
    byId("build-mission-progress-bar").setAttribute("aria-valuetext", hasScore ? `${score} percent validated` : "Project maturity unavailable");
    text(byId("build-mission-potential"), validated ? "This milestone is already validated" : hasScore && reward ? `Could reach ${Math.min(100, score + reward)}% once ${documentary ? "confirmed" : "validated"}` : "Points unlock when the mission is complete.");
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
    text(byId("build-mission-work-kicker"), id === "interest_test" ? "SHAREABLE TEST" : "REAL-WORLD RESULT");
    text(byId("build-mission-work-title"), id === "interest_test" ? "Design your public test" : "Record your evidence");
    const start = byId("build-mission-start");
    start.dataset.action = "chat";
    text(start, Number(mission.draft?.answeredCount) > 0 ? "Continue with Lia →" : "Start with Lia →");
  }

  function renderMission(mission, maturity) {
    const score = Number(maturity?.percent);
    const hasScore = Number.isInteger(score) && score >= 0 && score <= 100;
    readinessCard.dataset.state = hasScore ? "scored" : "unstarted";
    projectView.dataset.readinessState = hasScore ? "scored" : "unstarted";
    readinessCard.style.setProperty("--readiness-progress", hasScore ? `${score}%` : "0%");
    text(byId("build-readiness-index"), hasScore ? "01 / 04" : "4 STAGES");
    text(byId("build-maturity-title"), hasScore ? "Maturity for your first pilot" : "Your path starts here.");
    if (!hasScore) text(byId("build-readiness-start").querySelector(".build-readiness-start-label"), "Plan with Lia");
    text(byId("build-maturity-value"), hasScore ? score : "—");
    byId("build-maturity-value").nextElementSibling.hidden = !hasScore;
    byId("build-maturity-progress").value = hasScore ? score : 0;
    byId("build-maturity-progress").setAttribute("aria-valuetext", hasScore ? `${score} percent of first-pilot readiness` : "Project maturity unavailable");
    text(byId("build-roadmap-percent"), hasScore ? `${score}%` : "—");
    const mature = score === 100;
    text(byId("build-maturity-status"), mature ? "Ready to plan your pilot" : "In progress");
    text(byId("build-maturity-copy"), !hasScore ? "Ask Lia to shape a first mission. Your readiness will grow as you validate real evidence." : mature ? "All milestones validated. Plan your first pilot." : "Validated evidence moves you toward a first pilot.");
    if (!mission) {
      text(byId("build-next-title"), mature ? "Launch your first pilot." : "Your next mission is being prepared.");
      text(byId("build-next-description"), mature ? "Your project has reached 100% on this readiness path." : "Ask Lia to identify the next missing milestone and the evidence that would validate it.");
      byId("build-mission-gain").hidden = true;
      byId("build-next-criterion").hidden = true;
      byId("build-next-progress").hidden = true;
      text(byId("build-next-action"), mature ? "Talk through pilot launch →" : "Plan a mission with Lia →");
      byId("build-mission-details").hidden = true;
      return;
    }
    const gain = Number(mission.gain ?? mission.weight ?? mission.points);
    text(byId("build-next-title"), mission.title || "Your next mission");
    text(byId("build-next-description"), mission.description || mission.summary || "Complete the mission and collect the evidence needed for validation.");
    const gainNode = byId("build-mission-gain");
    gainNode.hidden = !Number.isInteger(gain) || gain <= 0;
    if (!gainNode.hidden) {
      text(byId("build-mission-gain-condition"), mission.guidedEvidenceType === "documentation" ? "ON CONFIRMATION" : "ON VALIDATION");
      text(byId("build-mission-gain-value"), `+${gain}%`);
    }
    const criterion = mission.criterion || mission.successCriterion || mission.evidenceRequired;
    const criterionNode = byId("build-next-criterion");
    criterionNode.hidden = !criterion;
    if (criterion) criterionNode.textContent = `${missionId(mission) === "target_problem" ? "To document" : "Evidence needed"}: ${criterion}`;
    const answered = Number(mission.draft?.answeredCount) || 0;
    const total = Number(mission.draft?.totalSteps) || (Array.isArray(mission.questions) ? mission.questions.length : 0);
    const progress = byId("build-next-progress");
    progress.hidden = !total || !answered;
    if (!progress.hidden) text(progress, `${Math.min(answered, total)} of ${total} questions answered with Lia`);
    text(byId("build-next-action"), mature ? "Discuss pilot launch with Lia →" : mission.draft?.complete ? "Review with Lia →" : answered ? "Continue mission →" : "Open mission →");
    if (!selectedMission) renderMissionDetails(mission);
  }

  function render(data) {
    snapshot = data;
    if (roadmapAutoSelect) {
      roadmapTab = guidedMissionInProgress(data?.maturity?.milestones || []) ? "progress" : "current";
      roadmapAutoSelect = false;
    }
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
    selectView("project");
    selectedMission = {
      id: "interest_test",
      milestoneId: "interest_test",
      title: milestone.title || "Test interest with your target audience",
      description: milestone.description || "Publish one focused question, collect responses, and review what you learned.",
      criterion: milestone.criterion || "Run the test, close it, and review the actual responses.",
      gain: milestone.weight ?? 5,
      steps: ["Define one hypothesis and a threshold.", "Approve and share the public form.", "Close the test, review responses, and record what you learned."]
    };
    showMission(selectedMission);
  }

  function prefillEvidence({ summary, experimentId, outcome = "learned" }) {
    if (!summary || !experimentId) return;
    const guided = new CustomEvent("build:experiment-applied", {
      cancelable: true, detail: { experimentId, summary }
    });
    window.dispatchEvent(guided);
    if (guided.defaultPrevented) {
      closeMission(false);
      history.replaceState(null, "", "#lia");
      selectView("lia", { focus: true });
      return;
    }
    evidenceSourceKind = "experiment";
    byId("build-evidence-summary").value = summary.slice(0, 1500);
    byId("build-evidence-reference").value = experimentId;
    byId("build-evidence-outcome").value = outcome;
    setMissionStage("evidence");
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
    selectedMission = mission;
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
      if (after > before) {
        text(byId("build-mission-success-summary"), `Project maturity moved from ${before}% to ${after}% after this mission's evidence was validated.`);
        setMissionStage("success");
      }
    } catch (error) {
      feedback.dataset.error = "true";
      text(feedback, readableError(error));
    } finally { button.disabled = false; }
  }

  for (const button of document.querySelectorAll(".build-nav-link")) button.addEventListener("click", () => {
    const name = button.dataset.buildView;
    if (name === "roadmap" && typeof accountReady !== "undefined" && accountReady && !getAccount().authenticated) {
      byId("open-account")?.click();
      return;
    }
    history.replaceState(null, "", name === "project" ? "#project" : name === "roadmap" ? "#missions" : "#lia");
    selectView(name, { focus: true });
  });
  byId("build-open-roadmap").addEventListener("click", () => selectView("roadmap", { focus: true }));
  byId("build-readiness-start").addEventListener("click", openNextMission);
  byId("build-roadmap-close").addEventListener("click", closeRoadmap);
  byId("build-roadmap-backdrop").addEventListener("click", closeRoadmap);
  const roadmapTabs = [...byId("build-roadmap-view").querySelectorAll("[data-roadmap-tab]")];
  for (const tab of roadmapTabs) tab.addEventListener("click", () => setRoadmapTab(tab.dataset.roadmapTab));
  byId("build-roadmap-view").querySelector(".build-roadmap-switcher").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = roadmapTabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? roadmapTabs.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + roadmapTabs.length) % roadmapTabs.length;
    setRoadmapTab(roadmapTabs[next].dataset.roadmapTab, true);
  });
  byId("build-ask-lia").addEventListener("click", () => selectView("lia", { focus: true }));
  byId("build-edit-context").addEventListener("click", openContext);
  byId("build-open-sources").addEventListener("click", () => byId("open-sources")?.click());
  byId("build-next-action").addEventListener("click", openNextMission);
  byId("build-mission-details-close").addEventListener("click", closeMission);
  byId("build-mission-backdrop").addEventListener("click", closeMission);
  byId("build-mission-success-close").addEventListener("click", closeMission);
  byId("build-mission-back").addEventListener("click", () => { setMissionStage("brief"); byId("build-mission-start").focus(); });
  byId("build-mission-start").addEventListener("click", () => {
    const id = missionId(currentMission());
    closeMission(false);
    history.replaceState(null, "", "#lia");
    selectView("lia", { focus: true });
    if (id) window.dispatchEvent(new CustomEvent("build:mission-guide", { detail: { missionId: id } }));
  });
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
  window.BUILDHome = { current: currentMission, refresh, openMission: openNextMission, openInterestTest, prefillEvidence, selectView,
    applySnapshot(data) { ++requestGeneration; render(data); },
    openMissionWork(mission) {
      if (!mission) return;
      missionReturnView = currentView;
      selectView("project");
      selectedMission = mission;
      showMission(mission);
      setMissionStage("work");
    } };
  selectView(location.hash === "#missions" ? "roadmap" : location.hash === "#lia" ? "lia" : "project", { focus: location.hash === "#missions" });
  const readyPoll = setInterval(() => {
    if (typeof accountReady !== "undefined" && accountReady) { clearInterval(readyPoll); void refresh(); }
  }, 100);
  setTimeout(() => clearInterval(readyPoll), 15000);
})();
