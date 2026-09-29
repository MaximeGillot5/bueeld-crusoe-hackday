"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const publicId = location.pathname.match(/^\/e\/([A-Za-z0-9_-]+)\/?$/)?.[1] || "";
  const status = (message, error = false) => {
    byId("survey-state").textContent = message;
    byId("survey-state").dataset.error = String(error);
  };
  let experiment = null;
  let submitting = false;
  let submissionId = "";
  const submissionKey = `build-response-${publicId}`;
  try { submissionId = sessionStorage.getItem(submissionKey) || ""; } catch {}
  if (!submissionId) {
    submissionId = crypto.randomUUID();
    try { sessionStorage.setItem(submissionKey, submissionId); } catch {}
  }

  async function readJson(response) { return response.json().catch(() => ({})); }
  async function load() {
    if (!publicId) { status("This test link is invalid.", true); byId("survey-title").textContent = "Test unavailable"; return; }
    try {
      const response = await fetch(`/api/public/experiments/${encodeURIComponent(publicId)}`, { credentials: "omit" });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "This test is unavailable.");
      experiment = data.experiment;
      if (!experiment || !Array.isArray(experiment.options) || experiment.options.length < 2) throw new Error("This test cannot be displayed right now.");
      byId("survey-title").textContent = experiment.title || "A short question about a project";
      byId("survey-audience").textContent = experiment.audience ? `Intended audience: ${experiment.audience}` : "Your answers will help this builder learn.";
      byId("survey-qualify-label").textContent = experiment.audience ? `Are you part of this audience: ${experiment.audience}?` : "Are you part of the intended audience?";
      byId("survey-question").textContent = experiment.question;
      const choiceContainer = byId("survey-choice-options");
      choiceContainer.replaceChildren(...experiment.options.map((option, index) => {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "choice";
        radio.value = option;
        radio.required = index === 0;
        const span = document.createElement("span");
        span.textContent = option;
        label.append(radio, span);
        return label;
      }));
      if (experiment.status !== "published") {
        status("This test is closed. Thank you for your interest.");
      } else if ((() => { try { return sessionStorage.getItem(`${submissionKey}-done`) === "1"; } catch { return false; } })()) {
        status("Thank you. Your response was recorded.");
      } else {
        status("Choose your answers and send your response below.");
        byId("survey-form").hidden = false;
      }
    } catch (error) {
      byId("survey-title").textContent = "Test unavailable";
      status(error.message || "This test could not be loaded.", true);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting || !experiment || experiment.status !== "published") return;
    const qualified = document.querySelector('input[name="qualified"]:checked')?.value === "yes";
    const choice = document.querySelector('input[name="choice"]:checked')?.value;
    if (!choice || !document.querySelector('input[name="qualified"]:checked')) {
      status("Please answer both questions.", true);
      return;
    }
    submitting = true;
    const button = byId("survey-submit");
    button.disabled = true;
    status("Sending your response…");
    try {
      const response = await fetch(`/api/public/experiments/${encodeURIComponent(publicId)}/responses`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "omit",
        body: JSON.stringify({ qualified, choice, comment: byId("survey-comment").value.trim(), submissionId })
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error || "Your response could not be saved.");
      try { sessionStorage.setItem(`${submissionKey}-done`, "1"); } catch {}
      byId("survey-form").hidden = true;
      status("Thank you. Your response was recorded.");
    } catch (error) {
      status(error.message || "Please try again.", true);
      button.disabled = false;
    } finally { submitting = false; }
  }
  byId("survey-form").addEventListener("submit", submit);
  void load();
})();
