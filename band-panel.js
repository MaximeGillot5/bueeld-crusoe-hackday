"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const widget = byId("band-widget");
  const launcher = byId("band-launcher");
  const menu = byId("band-menu");
  const notice = byId("band-notice");
  const challenge = byId("band-challenge");
  const create = byId("band-create");
  const chatToggle = byId("band-chat-toggle");
  const status = byId("band-menu-status");
  const badge = byId("band-launcher-badge");
  const noticeBody = byId("band-notice-body");
  const noticeChoices = byId("band-notice-choices");
  const noticePosition = byId("band-notice-position");
  const noticeFeedback = byId("band-notice-feedback");
  const noticePublish = byId("band-notice-publish");
  const noticeRetry = byId("band-notice-retry");
  const noticeDismiss = byId("band-notice-dismiss");
  const noticeRoom = byId("band-notice-room");
  if (!widget || !launcher || !menu || !notice || !window.BUEELDBand) return;

  let configured = null;
  let statusRequest = 0;
  let menuOpen = false;
  let noticeOpen = false;
  let menuHideTimer = null;
  let noticeHideTimer = null;
  let activeNoticeId = "";
  let selectedChoice = 0;
  const node = (tag, className, content = "") => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    item.textContent = content;
    return item;
  };
  const items = () => window.BUEELDBand.notifications?.() || [];

  function syncBadge() {
    const count = items().length;
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? "9+" : String(count);
    launcher.setAttribute("aria-label", noticeOpen ? "Close BAND suggestion" : menuOpen ? "Close BAND actions" :
      count ? `Open ${count} BAND suggestion${count === 1 ? "" : "s"}` : "Open BAND actions");
    launcher.setAttribute("aria-expanded", String(menuOpen || noticeOpen));
    launcher.setAttribute("aria-controls", noticeOpen ? "band-notice" : "band-menu");
  }

  function syncControls() {
    const authenticated = window.BUEELDBand.getContext()?.authenticated === true;
    const enabled = window.BUEELDBand.getChatMode() === true;
    const busy = window.BUEELDBand.isActionBusy();
    challenge.disabled = create.disabled = busy || (authenticated && configured !== true);
    chatToggle.checked = enabled;
    chatToggle.disabled = !authenticated || (configured !== true && !enabled);
    if (!authenticated) status.textContent = "Sign in to send a short project and mission summary to BAND.";
    else if (configured === null) status.textContent = "Checking BAND connection…";
    else if (!configured) status.textContent = "BAND is unavailable here. No review was sent.";
    else if (busy) status.textContent = "BAND is working. A suggestion will appear beside this button.";
    else status.textContent = enabled
      ? "Auto mode is on: each new question, Lia answer and mission context go to BAND for one review (3 model calls). You choose what enters the chat."
      : "Choose an action to send current mission and chat context to BAND. You choose what enters the chat.";
  }

  async function refreshStatus() {
    const request = ++statusRequest;
    configured = null;
    syncControls();
    try {
      const result = await window.BUEELDBand.status();
      if (request !== statusRequest) return;
      configured = result?.configured === true;
    } catch {
      if (request !== statusRequest) return;
      configured = false;
    }
    syncControls();
    if (menuOpen && configured && document.activeElement === menu) challenge.focus();
  }

  function closeMenu(restoreFocus = true, immediately = false) {
    if (!menuOpen) return;
    menuOpen = false;
    statusRequest += 1;
    menu.classList.remove("is-open");
    clearTimeout(menuHideTimer);
    if (immediately) menu.hidden = true;
    else menuHideTimer = setTimeout(() => { if (!menuOpen) menu.hidden = true; }, 190);
    syncBadge();
    if (restoreFocus) launcher.focus();
  }

  function closeNotice(restoreFocus = true, immediately = false) {
    if (!noticeOpen) return;
    noticeOpen = false;
    notice.classList.remove("is-open");
    clearTimeout(noticeHideTimer);
    if (immediately) notice.hidden = true;
    else noticeHideTimer = setTimeout(() => { if (!noticeOpen) notice.hidden = true; }, 190);
    syncBadge();
    if (restoreFocus) launcher.focus();
  }

  function openMenu() {
    closeNotice(false, true);
    clearTimeout(menuHideTimer);
    menuOpen = true;
    menu.hidden = false;
    syncControls();
    syncBadge();
    requestAnimationFrame(() => {
      if (!menuOpen) return;
      menu.classList.add("is-open");
      menu.focus();
      setTimeout(() => { if (menuOpen) (challenge.disabled ? menu : challenge).focus(); }, 40);
    });
    void refreshStatus();
  }

  function renderNotice() {
    const queue = items();
    syncBadge();
    if (!queue.length) { closeNotice(false); return; }
    let item = queue.find((entry) => entry.id === activeNoticeId);
    if (!item) {
      item = queue[0];
      activeNoticeId = item.id;
      selectedChoice = 0;
    }
    noticePosition.textContent = queue.length > 1 ? `${queue.indexOf(item) + 1} of ${queue.length}` : "";
    noticeBody.replaceChildren();
    noticeBody.append(node("h3", "band-notice-title", item.title));
    if (item.status === "pending") {
      noticeBody.append(node("p", "band-notice-loading", "Scout and Critic are reviewing your context…"));
    } else if (item.status === "failed") {
      noticeBody.append(node("p", "band-notice-error", item.summary || "BAND could not finish this review."));
    } else {
      if (item.preview) {
        const preview = node("div", "band-notice-preview");
        if (item.preview.target) preview.append(node("span", "", item.preview.target));
        if (item.preview.solution) preview.append(node("p", "", item.preview.solution));
        if (item.preview.firstExperiment) preview.append(node("small", "", `First test: ${item.preview.firstExperiment}`));
        noticeBody.append(preview);
      }
      if (item.summary) noticeBody.append(node("p", "band-notice-summary", item.summary.slice(0, 380) + (item.summary.length > 380 ? "…" : "")));
    }
    noticeChoices.replaceChildren();
    noticeChoices.hidden = item.status !== "ready" || !item.choices.length;
    if (!noticeChoices.hidden) {
      noticeChoices.append(node("p", "band-notice-choose-label", "Choose what Lia should consider"));
      item.choices.forEach((choice, index) => {
        const row = node("div", "band-notice-choice-row");
        const select = node("button", "band-notice-choice");
        select.type = "button";
        select.dataset.bandChoice = String(index);
        select.setAttribute("aria-pressed", String(selectedChoice === index));
        select.append(node("strong", "", choice.label), node("span", "", choice.text));
        const copy = node("button", "band-notice-copy", "⧉");
        copy.type = "button";
        copy.dataset.bandCopy = String(index);
        copy.setAttribute("aria-label", `Copy ${choice.label.toLowerCase()}`);
        row.append(select, copy);
        noticeChoices.append(row);
      });
    }
    noticePublish.hidden = item.status !== "ready";
    noticePublish.textContent = window.BUEELDBand.publishNeedsMissionPause() ? "Pause mission & put in chat" : "Put in chat";
    noticeRetry.hidden = item.status !== "failed";
    noticeRoom.hidden = !item.roomUrl;
    if (item.roomUrl) noticeRoom.href = item.roomUrl;
    noticeFeedback.textContent = "";
  }

  function openNotice() {
    if (!items().length) { openMenu(); return; }
    closeMenu(false, true);
    clearTimeout(noticeHideTimer);
    noticeOpen = true;
    notice.hidden = false;
    renderNotice();
    syncBadge();
    requestAnimationFrame(() => {
      if (!noticeOpen) return;
      notice.classList.add("is-open");
      setTimeout(() => { if (noticeOpen) notice.focus(); }, 40);
    });
  }

  function refreshNotifications(autoOpen = false) {
    const queue = items();
    syncBadge();
    if (!queue.length) { closeNotice(false); return; }
    if (noticeOpen) renderNotice();
    else if (autoOpen && !menuOpen) openNotice();
  }

  function runAction(kind) {
    const authenticated = window.BUEELDBand.getContext()?.authenticated === true;
    if (!authenticated) {
      closeMenu(false);
      byId("open-account")?.click();
      return;
    }
    if (configured !== true || window.BUEELDBand.isActionBusy()) return;
    closeMenu(false, true);
    if (window.BUEELDBand.runAction(kind)) refreshNotifications(true);
  }

  launcher.addEventListener("click", () => {
    if (noticeOpen) closeNotice();
    else if (menuOpen) closeMenu();
    else if (items().length) openNotice();
    else openMenu();
  });
  challenge.addEventListener("click", () => runAction("challenge"));
  create.addEventListener("click", () => runAction("create"));
  chatToggle.addEventListener("change", () => {
    if (chatToggle.checked && (configured !== true || !window.BUEELDBand.getContext()?.authenticated)) {
      syncControls();
      return;
    }
    window.BUEELDBand.setChatMode(chatToggle.checked);
    syncControls();
  });
  byId("band-notice-close").addEventListener("click", () => closeNotice());
  byId("band-notice-menu").addEventListener("click", openMenu);
  noticeChoices.addEventListener("click", async (event) => {
    const select = event.target.closest("button[data-band-choice]");
    const copy = event.target.closest("button[data-band-copy]");
    if (select) {
      selectedChoice = Number(select.dataset.bandChoice);
      renderNotice();
      noticeChoices.querySelector(`[data-band-choice="${selectedChoice}"]`)?.focus();
    } else if (copy) {
      const current = items().find((item) => item.id === activeNoticeId);
      const choice = current?.choices[Number(copy.dataset.bandCopy)];
      if (!choice) return;
      try {
        await navigator.clipboard.writeText(choice.text);
        noticeFeedback.textContent = "Copied to clipboard.";
      } catch {
        noticeFeedback.textContent = "Copy is unavailable in this browser.";
      }
    }
  });
  noticePublish.addEventListener("click", () => {
    const result = window.BUEELDBand.publishNotification(activeNoticeId, selectedChoice);
    if (!result?.ok) { noticeFeedback.textContent = result?.message || "Could not send this suggestion."; return; }
    activeNoticeId = "";
    selectedChoice = 0;
    refreshNotifications(false);
  });
  noticeDismiss.addEventListener("click", () => {
    window.BUEELDBand.dismissNotification(activeNoticeId);
    activeNoticeId = "";
    selectedChoice = 0;
    refreshNotifications(false);
    if (!items().length) launcher.focus();
  });
  noticeRetry.addEventListener("click", () => {
    if (!window.BUEELDBand.retryNotification(activeNoticeId)) noticeFeedback.textContent = "Could not restart this BAND review.";
  });
  document.addEventListener("pointerdown", (event) => {
    if (!widget.contains(event.target)) {
      closeMenu(false);
      closeNotice(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (noticeOpen) { event.preventDefault(); closeNotice(); }
    else if (menuOpen) { event.preventDefault(); closeMenu(); }
  });
  window.addEventListener("band:action-state", syncControls);
  window.addEventListener("band:chat-mode-changed", syncControls);
  window.addEventListener("band:notifications-changed", () => refreshNotifications(true));
  window.addEventListener("build:workspace-changed", () => {
    if (menuOpen) void refreshStatus();
    refreshNotifications(false);
  });

  const logo = launcher.querySelector("img");
  if (logo) {
    const unavailable = () => launcher.classList.add("is-logo-unavailable");
    logo.addEventListener("error", unavailable);
    if (logo.complete && !logo.naturalWidth) unavailable();
  }
  syncBadge();
})();
