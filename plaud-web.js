"use strict";

// The Plaud phone bridge only transfers a transcript. A founder still chooses
// a quote and confirms what was learned before it counts as field evidence.
(() => {
  const byId = (id) => document.getElementById(id);
  const section = byId("plaud-source");
  if (!section) return;

  const state = {
    ownerId: null,
    configured: null,
    statusFailed: false,
    statusLoading: false,
    listLoading: false,
    detailLoading: false,
    pairing: false,
    validating: false,
    transcriptions: [],
    detail: null,
    fieldValidated: false,
    generation: 0,
  };

  function session() {
    return typeof accountSession !== "undefined" ? accountSession : { authenticated: false, user: null };
  }

  function isReady() {
    return typeof accountReady !== "undefined" && accountReady === true;
  }

  function isSignedIn() {
    return isReady() && session().authenticated === true && Boolean(session().user?.id);
  }

  function setStatus(message, error = false) {
    const node = byId("plaud-status");
    node.textContent = message;
    node.classList.toggle("is-error", error);
  }

  function readableError(error) {
    return error?.message || "Plaud could not complete this request. Please retry.";
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "Time unavailable";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole % 3600 / 60);
    const remainder = whole % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
  }

  function transcriptState(transcription) {
    if (transcription?.status === "SUCCESS") return "ready";
    if (["FAILURE", "REVOKED"].includes(transcription?.status)) return "failed";
    return "processing";
  }

  function addText(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    return node;
  }

  function resetPrivateData() {
    state.generation += 1;
    state.configured = null;
    state.statusFailed = false;
    state.statusLoading = false;
    state.listLoading = false;
    state.detailLoading = false;
    state.pairing = false;
    state.validating = false;
    state.transcriptions = [];
    state.detail = null;
    state.fieldValidated = false;
    byId("plaud-pairing-code").textContent = "";
    byId("plaud-pairing-expiry").textContent = "";
    byId("plaud-pairing").hidden = true;
    byId("plaud-learning").value = "";
    byId("plaud-confirm-real").checked = false;
    byId("plaud-detail").hidden = true;
    byId("plaud-segments").replaceChildren();
    byId("plaud-transcriptions").replaceChildren();
    setStatus("");
  }

  function updateControls() {
    const signedIn = isSignedIn();
    byId("plaud-account-gate").hidden = !isReady() || signedIn;
    byId("plaud-controls").hidden = !signedIn || state.configured !== true;
    const availability = byId("plaud-availability");
    if (!isReady()) availability.textContent = "Checking account…";
    else if (!signedIn) availability.textContent = "Lab account required";
    else if (state.statusLoading) availability.textContent = "Checking connection…";
    else if (state.statusFailed) availability.textContent = "Connection unavailable";
    else if (state.configured === null) availability.textContent = "Checking connection…";
    else availability.textContent = state.configured ? "Embedded connection ready" : "Setup required";
    availability.classList.toggle("is-available", signedIn && state.configured === true);

    byId("plaud-pair").disabled = !signedIn || !state.configured || state.pairing;
    byId("plaud-refresh").disabled = !signedIn || !state.configured || state.listLoading;
    byId("plaud-validate").disabled = !signedIn || state.detail?.status !== "SUCCESS" || state.validating || state.fieldValidated ||
      !byId("plaud-segments").querySelector('input[name="plaud-quote"]:checked') ||
      byId("plaud-learning").value.trim().length < 30 || !byId("plaud-confirm-real").checked;
    byId("plaud-evidence-help").textContent = state.fieldValidated
      ? "Field observations are already validated for this project."
      : "A transcript alone does not award progress. Choose a quote and confirm the learning.";
  }

  async function loadStatus() {
    if (!isSignedIn() || state.statusLoading) return;
    const generation = state.generation;
    state.statusLoading = true;
    updateControls();
    try {
      const response = await fetch("/api/plaud/status", { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.configured !== "boolean") throw new Error(data.error || "Plaud connection status is unavailable.");
      if (generation !== state.generation) return;
      state.configured = data.configured;
      state.statusFailed = false;
      if (!data.configured) setStatus("Finish the Plaud Embedded setup before connecting the iPhone bridge.");
      else if (byId("source-drawer").hidden === false) void refreshTranscriptions();
    } catch (error) {
      if (generation === state.generation) {
        state.statusFailed = true;
        setStatus(readableError(error), true);
      }
    } finally {
      if (generation === state.generation) {
        state.statusLoading = false;
        updateControls();
      }
    }
  }

  function renderList() {
    const container = byId("plaud-transcriptions");
    container.replaceChildren();
    if (!state.transcriptions.length) {
      container.append(addText("p", "plaud-empty", "No Plaud interviews yet. Record and sync one with the iPhone bridge, then refresh this list."));
      return;
    }
    for (const transcription of state.transcriptions) {
      const card = addText("article", "plaud-interview", "");
      const processing = transcriptState(transcription);
      const details = document.createElement("div");
      details.append(
        addText("strong", "", `${transcription.title || "Plaud interview"} · ${formatDate(transcription.recordedAt || transcription.createdAt)}`),
        addText("small", "", processing === "ready"
          ? `${Number(transcription.segmentCount) || 0} timestamped segments${Number.isFinite(transcription.duration) ? " · " + formatTime(transcription.duration) : ""}`
          : processing === "failed" ? "Transcription failed · retry from the iPhone bridge" : "Plaud is processing this interview…"),
      );
      if (typeof transcription.preview === "string" && transcription.preview.trim()) {
        details.append(addText("p", "", transcription.preview));
      }
      const open = addText("button", "", processing === "ready" ? "Review transcript" : "Check status");
      open.type = "button";
      open.addEventListener("click", () => { void loadDetail(transcription.id); });
      card.append(details, open);
      container.append(card);
    }
  }

  async function refreshTranscriptions() {
    if (!isSignedIn() || !state.configured || state.listLoading) return;
    const generation = state.generation;
    state.listLoading = true;
    updateControls();
    setStatus("Loading Plaud interviews…");
    try {
      const data = await accountApi("GET", "/api/plaud/transcriptions");
      if (!Array.isArray(data?.transcriptions)) throw new Error("Plaud returned an incomplete interview list.");
      if (generation !== state.generation) return;
      state.transcriptions = data.transcriptions.filter((item) => typeof item?.id === "string" && item.id).slice(0, 30);
      renderList();
      const pending = state.transcriptions.filter((item) => transcriptState(item) === "processing").length;
      setStatus(pending
        ? `${pending} Plaud interview${pending === 1 ? " is" : "s are"} processing. Refresh to check progress.`
        : state.transcriptions.length ? "Choose an interview to review its exact transcript." : "No interviews have synced yet.");
      if (state.detail && transcriptState(state.detail) === "processing" &&
          state.transcriptions.some((item) => item.id === state.detail.id && item.status !== state.detail.status)) {
        void loadDetail(state.detail.id);
      }
    } catch (error) {
      if (generation === state.generation) setStatus(readableError(error), true);
    } finally {
      if (generation === state.generation) {
        state.listLoading = false;
        updateControls();
      }
    }
  }

  async function createPairing() {
    if (!isSignedIn() || !state.configured || state.pairing) return;
    const generation = state.generation;
    state.pairing = true;
    updateControls();
    setStatus("Creating a one-time connection code…");
    try {
      const data = await accountApi("POST", "/api/plaud/pairings", {});
      if (typeof data?.code !== "string" || !data.code) throw new Error("Plaud did not return a pairing code.");
      if (generation !== state.generation) return;
      byId("plaud-pairing-code").textContent = data.code;
      byId("plaud-pairing-expiry").textContent = data.expiresAt ? "Expires " + formatDate(data.expiresAt) : "Use this code promptly.";
      byId("plaud-pairing").hidden = false;
      setStatus("Enter this code in the temporary iPhone bridge, then record and sync an interview.");
    } catch (error) {
      if (generation === state.generation) setStatus(readableError(error), true);
    } finally {
      if (generation === state.generation) {
        state.pairing = false;
        updateControls();
      }
    }
  }

  function renderDetail() {
    const transcription = state.detail;
    byId("plaud-detail").hidden = !transcription;
    if (!transcription) return;
    byId("plaud-learning").value = "";
    byId("plaud-confirm-real").checked = false;
    byId("plaud-detail-meta").textContent = [
      formatDate(transcription.createdAt),
      Number.isFinite(transcription.duration) ? formatTime(transcription.duration) : "",
      transcription.language || "",
      "Source: Plaud Embedded",
    ].filter(Boolean).join(" · ");
    const transcriptReady = transcriptState(transcription) === "ready";
    const transcriptFailed = transcriptState(transcription) === "failed";
    byId("plaud-evidence-form").hidden = !transcriptReady;
    const help = byId("plaud-detail").querySelector(".plaud-detail-help");
    help.textContent = transcriptReady
      ? "Select one exact quote. Its timestamp and any available speaker label will stay with your evidence."
      : transcriptFailed ? "Plaud could not transcribe this recording. Retry it from the iPhone bridge."
        : "Plaud is processing this recording. Refresh interviews to check again.";
    const list = byId("plaud-segments");
    list.replaceChildren();
    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    segments.forEach((segment, index) => {
      if (typeof segment?.text !== "string" || !segment.text.trim() || !Number.isFinite(segment.start)) return;
      const item = document.createElement("li");
      const label = addText("label", "plaud-segment", "");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "plaud-quote";
      radio.value = String(index);
      radio.required = true;
      const content = document.createElement("span");
      const stamp = `${formatTime(segment.start)}${Number.isFinite(segment.end) ? "–" + formatTime(segment.end) : ""}${segment.speaker ? " · " + segment.speaker : ""}`;
      content.append(addText("strong", "", stamp), document.createTextNode(segment.text));
      label.append(radio, content);
      item.append(label);
      list.append(item);
    });
    if (!list.children.length && transcriptReady) {
      list.append(addText("li", "plaud-empty", "This transcript has no timestamped segments to cite."));
    }
    updateControls();
    byId("plaud-detail").scrollIntoView({ block: "start", behavior: "smooth" });
  }

  async function loadDetail(id) {
    if (!isSignedIn() || state.detailLoading || typeof id !== "string" || !id) return;
    const generation = state.generation;
    state.detailLoading = true;
    setStatus("Loading exact transcript…");
    try {
      const data = await accountApi("GET", "/api/plaud/transcriptions/" + encodeURIComponent(id));
      if (data?.transcription?.id !== id || !Array.isArray(data.transcription.segments)) {
        throw new Error("Plaud returned an incomplete transcript.");
      }
      if (generation !== state.generation) return;
      state.detail = data.transcription;
      renderDetail();
      setStatus(transcriptState(state.detail) === "ready"
        ? "Select an exact quote, write what you learned, then confirm it as real field evidence."
        : transcriptState(state.detail) === "failed"
          ? "Plaud could not transcribe this recording. Retry it from the iPhone bridge."
          : "Plaud is still processing this interview. Refresh interviews to check again.");
    } catch (error) {
      if (generation === state.generation) setStatus(readableError(error), true);
    } finally {
      if (generation === state.generation) state.detailLoading = false;
    }
  }

  async function validateFieldObservation(event) {
    event.preventDefault();
    if (!isSignedIn() || state.detail?.status !== "SUCCESS" || state.validating || state.fieldValidated) return;
    const selected = byId("plaud-segments").querySelector('input[name="plaud-quote"]:checked');
    const segment = state.detail.segments[Number(selected?.value)];
    const learning = byId("plaud-learning").value.trim();
    if (!selected || !segment || !Number.isFinite(segment.start) || typeof segment.text !== "string" ||
        learning.length < 30 || !byId("plaud-confirm-real").checked) {
      setStatus("Choose an exact quote, write at least 30 characters of learning, and confirm the real interview.", true);
      return;
    }
    const speaker = typeof segment.speaker === "string" && segment.speaker ? `, ${segment.speaker}` : "";
    const summary = `Founder-confirmed field interview observation: ${learning}\nPlaud transcript quote [${formatTime(segment.start)}${speaker}]: “${segment.text}”`;
    if (summary.length > 3000) {
      setStatus("This quote and learning are too long for one field observation. Choose a shorter segment.", true);
      return;
    }
    const generation = state.generation;
    state.validating = true;
    updateControls();
    setStatus("Saving the founder-confirmed field observation…");
    try {
      await accountApi("POST", "/api/projects/current/milestones/field_observations/validate", {
        source: { kind: "import", reference: "plaud:" + state.detail.id },
        evidence: { summary, reference: `Plaud transcript ${state.detail.id} at ${formatTime(segment.start)}`, real: true },
        plaudQuote: { start: segment.start, text: segment.text },
        outcome: "met",
        requestId: crypto.randomUUID(),
      });
      if (generation !== state.generation) return;
      state.fieldValidated = true;
      setStatus("Field observations validated with the selected Plaud quote. Your project path has been updated.");
      window.dispatchEvent(new Event("build:workspace-changed"));
    } catch (error) {
      if (generation === state.generation) setStatus(readableError(error), true);
    } finally {
      if (generation === state.generation) {
        state.validating = false;
        updateControls();
      }
    }
  }

  function onWorkspaceChange() {
    if (!isReady()) return;
    const ownerId = isSignedIn() ? session().user.id : null;
    if (ownerId !== state.ownerId) {
      resetPrivateData();
      state.ownerId = ownerId;
      updateControls();
      if (ownerId) void loadStatus();
      return;
    }
    updateControls();
  }

  byId("plaud-sign-in").addEventListener("click", () => byId("connector-sign-in")?.click());
  byId("plaud-pair").addEventListener("click", () => { void createPairing(); });
  byId("plaud-refresh").addEventListener("click", () => { void refreshTranscriptions(); });
  byId("plaud-detail-close").addEventListener("click", () => {
    state.detail = null;
    byId("plaud-detail").hidden = true;
    updateControls();
    byId("plaud-refresh").focus();
  });
  byId("plaud-segments").addEventListener("change", updateControls);
  byId("plaud-learning").addEventListener("input", updateControls);
  byId("plaud-confirm-real").addEventListener("change", updateControls);
  byId("plaud-evidence-form").addEventListener("submit", validateFieldObservation);
  window.addEventListener("build:workspace-changed", onWorkspaceChange);
  window.addEventListener("build:maturity-loaded", (event) => {
    state.fieldValidated = event.detail?.snapshot?.maturity?.milestones?.some((item) =>
      item.id === "field_observations" && item.validated === true) === true;
    updateControls();
  });
  new MutationObserver(() => {
    if (byId("source-drawer").hidden || !isSignedIn()) return;
    if (state.configured === true) void refreshTranscriptions();
    else void loadStatus();
  }).observe(byId("source-drawer"), { attributes: true, attributeFilter: ["hidden"] });

  updateControls();
  const readyCheck = setInterval(() => {
    if (!isReady()) return;
    clearInterval(readyCheck);
    onWorkspaceChange();
  }, 200);
})();
