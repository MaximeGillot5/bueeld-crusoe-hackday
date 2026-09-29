"use strict";

// Compact, account-scoped project context and the mission learning loop.
const PROJECT_MEMORY_KEY = "bueeld-lab-project-memory-v1";
const MEMORY_FIELDS = ["project", "target", "goal", "blocker"];
let projectMemory = { project: "", target: "", goal: "", blocker: "" };
let memoryRevision = 0;
let memorySaving = false;
let memoryDraftDirty = false;
let memoryStatus = "";
let reviewingMissionId = null;
let learningError = null;

function cleanProjectMemory(value) {
  return Object.fromEntries(MEMORY_FIELDS.map((field) => [field, typeof value?.[field] === "string" ? value[field].trim().slice(0, 350) : ""]));
}

function memoryHasContent(value = projectMemory) {
  return MEMORY_FIELDS.some((field) => value[field]);
}

function renderProjectMemory(fill = false) {
  if (!$("project-memory-panel")) return;
  $("project-memory-summary").textContent = memoryHasContent()
    ? "What Lia knows · " + (projectMemory.project || projectMemory.target || "Your project").slice(0, 48)
    : "What Lia knows · Add project context";
  if (fill && !memoryDraftDirty) for (const field of MEMORY_FIELDS) $("memory-" + field).value = projectMemory[field];
  $("memory-save").disabled = !accountReady || memorySaving;
  $("memory-save").textContent = memorySaving ? "Saving…" : "Save context";
  $("memory-status").textContent = memoryStatus;
}

async function loadProjectMemory() {
  const revision = ++memoryRevision;
  const userId = accountSession.user?.id || null;
  const generation = workspaceGeneration;
  memoryDraftDirty = false;
  memorySaving = false;
  memoryStatus = "";
  learningError = null;
  reviewingMissionId = null;
  projectMemory = cleanProjectMemory(null);
  try {
    if (accountSession.authenticated || !guestHidden) projectMemory = cleanProjectMemory(JSON.parse(localStorage.getItem(currentStorageKey(PROJECT_MEMORY_KEY)) || "null"));
  } catch { /* Corrupt or unavailable browser storage falls back to empty context. */ }
  $("project-memory-panel").open = false;
  renderProjectMemory(true);
  if (!accountSession.authenticated) return;
  try {
    const data = await accountApi("GET", "/api/project-memory");
    if (revision !== memoryRevision || generation !== workspaceGeneration || userId !== accountSession.user?.id || memoryDraftDirty) return;
    projectMemory = cleanProjectMemory(data.projectMemory);
    try { localStorage.setItem(currentStorageKey(PROJECT_MEMORY_KEY), JSON.stringify(projectMemory)); } catch {}
    renderProjectMemory(true);
  } catch {
    if (revision === memoryRevision && generation === workspaceGeneration) {
      memoryStatus = "Saved account context could not be loaded. Check these fields before your next message.";
      renderProjectMemory();
    }
  }
}

async function saveProjectMemory(event) {
  event?.preventDefault();
  if (!accountReady || memorySaving) return;
  const revision = ++memoryRevision;
  const userId = accountSession.user?.id || null;
  const generation = workspaceGeneration;
  const next = cleanProjectMemory(Object.fromEntries(MEMORY_FIELDS.map((field) => [field, $("memory-" + field).value])));
  projectMemory = next;
  memoryDraftDirty = false;
  let localSaved = false;
  try { localStorage.setItem(currentStorageKey(PROJECT_MEMORY_KEY), JSON.stringify(next)); localSaved = true; } catch {}
  if (!accountSession.authenticated) {
    // Saving new guest context is an explicit choice, separate from restoring a hidden chat.
    memoryStatus = localSaved ? "Saved on this browser. Lia will use it in your next messages." : "Available for this visit; browser storage is unavailable.";
    renderProjectMemory(true);
    return;
  }
  memorySaving = true;
  memoryStatus = "Saving project context…";
  renderProjectMemory();
  try {
    await accountApi("PUT", "/api/project-memory", { projectMemory: next });
    if (generation !== workspaceGeneration || revision !== memoryRevision || userId !== accountSession.user?.id) return;
    memoryStatus = "Saved to your Lab account. Reused across chats; edit it whenever your project changes.";
  } catch (error) {
    if (generation === workspaceGeneration && revision === memoryRevision) memoryStatus = (localSaved ? "Saved on this browser. " : "") + "Account sync failed. Save again to retry.";
  } finally {
    if (generation === workspaceGeneration && userId === accountSession.user?.id) {
      memorySaving = false;
      renderProjectMemory(true);
    }
  }
}

function suggestOnboardingMemory(answers) {
  if (memoryHasContent() || memoryDraftDirty) return;
  const clean = answers.map((answer) => answer === "Unknown" ? "" : String(answer || ""));
  // Propose only the founder's own words; the founder reviews and saves the fields.
  $("memory-project").value = ["Existing project", "A new idea"].includes(clean[0]) ? "" : clean[0].slice(0, 350);
  $("memory-target").value = (clean[1] || "").slice(0, 350);
  $("memory-goal").value = (clean[3] || "").slice(0, 350);
  memoryDraftDirty = true;
  memoryStatus = "Your setup answers are ready to review here. Save them to reuse across chats.";
  renderProjectMemory();
}

function cleanMissionLearning(value) {
  if (!value || !["continue", "iterate", "stop"].includes(value.recommendation)) return null;
  const fields = ["assumption", "observation", "decision", "nextMission"];
  if (!fields.every((field) => typeof value[field] === "string" && value[field].trim() && value[field].length <= 600)) return null;
  return { ...Object.fromEntries(fields.map((field) => [field, value[field].trim()])), recommendation: value.recommendation };
}

function missionMilestones() {
  const real = [...new Map(missionTracker.records.map((record) => [record.id, record])).values()]
    .filter((record) => record.status === "completed" && record.realEvidence && record.evidence.length >= 30 && MISSION_AREAS.some(([id]) => id === record.area) && MISSION_OUTCOMES.includes(record.outcome));
  return [
    { title: "First test completed", detail: "Complete one test with real observations.", earned: real.length >= 1 },
    { title: "Assumption challenged", detail: "Document a missed target and review a change of direction with Lia.", earned: real.some((record) => record.outcome === "missed" && ["iterate", "stop"].includes(cleanMissionLearning(record.learning)?.recommendation)) },
    { title: "Three tests documented", detail: "Complete three tests with real observations.", earned: real.length >= 3 }
  ];
}

function renderGrowthMissionFeatures() {
  if (!$("mission-learning-card")) return;
  const current = activeMissionRecord();
  $("mission-help").hidden = !current || current.status !== "approved";
  $("mission-help").disabled = chatBusy || sourceBusy || isDemoQuotaExhausted();
  const completed = latestConversationMissionResult();
  const visible = !!completed && !current;
  $("mission-learning-card").hidden = !visible;
  const learning = visible ? cleanMissionLearning(completed.learning) : null;
  $("mission-learning-content").hidden = !learning;
  $("mission-use-learning").hidden = !learning;
  $("mission-copy-learning").hidden = !learning;
  $("mission-use-learning").disabled = chatBusy || sourceBusy;
  $("mission-review-result").disabled = !visible || chatBusy || sourceBusy || isDemoQuotaExhausted();
  $("mission-review-result").textContent = reviewingMissionId === completed?.id ? "Lia is reviewing…" : learning ? "Review again with Lia" : "Review result with Lia";
  $("mission-review-result").className = learning ? "mission-secondary-button" : "mission-primary-button";
  $("learning-status").textContent = learningError && learningError.id === completed?.id ? learningError.message
    : reviewingMissionId === completed?.id ? "Comparing your result with the mission. This uses one AI call."
      : visible ? (completed.realEvidence ? "Based on your reported evidence. Lia's assessment is a recommendation." : "Fictional demo result. This review does not establish real project progress.") : "";
  if (learning) {
    for (const [id, field] of [["assumption", "assumption"], ["observation", "observation"], ["decision", "decision"], ["next", "nextMission"]]) $("learning-" + id).textContent = learning[field];
    $("learning-recommendation").textContent = { continue: "Continue", iterate: "Adjust the plan", stop: "Stop & rethink" }[learning.recommendation];
    $("learning-recommendation").dataset.decision = learning.recommendation;
  }
  const milestones = missionMilestones();
  $("mission-milestones").replaceChildren(...milestones.map((item) => {
    const node = el("div", "mission-milestone" + (item.earned ? " is-earned" : ""));
    node.append(el("strong", "", item.title), el("small", "", item.earned ? "Reached · self-reported evidence" : item.detail));
    return node;
  }));
  $("mission-reward-milestones").replaceChildren(...milestones.filter((item) => item.earned).map((item) => el("span", "milestone-badge", item.title)));
  renderProjectMemory();
}

async function reviewMissionResult() {
  const record = latestConversationMissionResult();
  if (!record || activeMissionRecord() || chatBusy || sourceBusy || isDemoQuotaExhausted()) return;
  const generation = workspaceGeneration;
  const recordVersion = JSON.stringify([record.content, record.evidence, record.outcome, record.realEvidence]);
  reviewingMissionId = record.id;
  learningError = null;
  chatBusy = true;
  renderChat();
  try {
    const data = await postJson("/api/mission/learn", {
      mission: { id: record.id, content: record.content, evidence: record.evidence, outcome: record.outcome, realEvidence: record.realEvidence },
      projectMemory: cleanProjectMemory(projectMemory)
    });
    const learning = cleanMissionLearning(data.learning);
    if (data.source !== "adal" || !learning) throw new Error("Lia's review was incomplete. Try again; your result is still saved.");
    if (generation !== workspaceGeneration || !missionTracker.records.includes(record) || record.status !== "completed" || recordVersion !== JSON.stringify([record.content, record.evidence, record.outcome, record.realEvidence])) return;
    if (record.outcome !== "met" && learning.recommendation === "continue") throw new Error("The review did not account for your result. Please retry.");
    record.learning = learning;
    persistMissionTracker();
  } catch (error) {
    if (generation === workspaceGeneration) learningError = { id: record.id, message: error.message || "Review unavailable. Your result is still saved; retry when ready." };
  } finally {
    if (generation === workspaceGeneration) {
      reviewingMissionId = null;
      chatBusy = false;
      renderChat();
      if (!$("mission-learning-card").hidden) {
        $("mission-learning-card").scrollIntoView({ block: "nearest", behavior: "smooth" });
        $("mission-learning-card").focus({ preventScroll: true });
      }
    }
  }
}

function helpWithMission() {
  const current = activeMissionRecord();
  if (!current || current.status !== "approved") return;
  const mission = current.content.slice(0, 950);
  submitChatMessage("Help me carry out this approved mission: " + mission + "\n\nCreate one ready-to-use deliverable in this chat, choosing the best format: interview questions, an experiment protocol, a message draft, or a checklist. Include how to record evidence and judge the result. Use placeholders for missing facts. Do not claim to send or execute anything. Keep it practical and copyable.");
}

function planFromLearning() {
  const record = latestConversationMissionResult();
  const learning = cleanMissionLearning(record?.learning);
  if (!learning || chatBusy || sourceBusy) return;
  const input = $("chat-input");
  if (input.value.trim()) {
    setChatStatus("Your draft is still here. Send or clear it before preparing the next mission.");
    input.focus();
    return;
  }
  input.value = (record.realEvidence ? "Self-reported result: " : "Fictional demo result: ") + record.evidence.slice(0, 380) + "\nLia's proposed next test: " + learning.nextMission + "\nHelp me turn this into one mission with an owner, deadline, expected evidence, and a success criterion for me to approve.";
  renderChat();
  input.focus();
}

async function copyGrowthText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1600);
  } catch { setChatStatus("Clipboard is unavailable. Select the text and copy it manually.", true); }
}

function initGrowthFeatures() {
  $("project-memory-form").addEventListener("submit", saveProjectMemory);
  $("project-memory-form").addEventListener("input", () => { memoryDraftDirty = true; ++memoryRevision; memoryStatus = "Unsaved changes. Save context to use it with Lia."; renderProjectMemory(); });
  $("mission-help").addEventListener("click", helpWithMission);
  $("mission-review-result").addEventListener("click", reviewMissionResult);
  $("mission-use-learning").addEventListener("click", planFromLearning);
  $("mission-copy-learning").addEventListener("click", (event) => {
    const learning = cleanMissionLearning(latestConversationMissionResult()?.learning);
    if (learning) void copyGrowthText("Assumption: " + learning.assumption + "\nObservation: " + learning.observation + "\nDecision: " + learning.decision + "\nNext test: " + learning.nextMission, event.currentTarget);
  });
  $("chat-messages").addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-message]");
    const message = button && chatMessages.find((item) => item.id === button.dataset.copyMessage);
    if (message) void copyGrowthText(message.content, button);
  });
  renderProjectMemory(true);
  renderGrowthMissionFeatures();
}
