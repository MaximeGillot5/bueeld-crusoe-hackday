(() => {
  const panel = document.getElementById('mission-panel');
  const drawer = document.getElementById('mission-drawer');
  if (!panel || !drawer) return;

  const tabs = [...panel.querySelectorAll('[data-progress-tab]')];
  const views = [...panel.querySelectorAll('[data-progress-view]')];
  if (!tabs.length || !views.length) return;

  function selectView(name, focus = false) {
    const selected = tabs.find(tab => tab.dataset.progressTab === name);
    if (!selected) return;
    tabs.forEach(tab => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    views.forEach(view => { view.hidden = view.dataset.progressView !== name; });
    if (focus) selected.focus();
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectView(tab.dataset.progressTab, true));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectView(tabs[next].dataset.progressTab, true);
    });
  });

  selectView('overview');
  let wasHidden = drawer.hidden;
  new MutationObserver(() => {
    if (wasHidden && !drawer.hidden) selectView('overview');
    wasHidden = drawer.hidden;
  }).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });

  const history = document.getElementById('mission-history-list');
  const pagination = document.getElementById('progress-history-pagination');
  const counter = document.getElementById('progress-history-page');
  const previous = document.getElementById('progress-history-prev');
  const next = document.getElementById('progress-history-next');
  if (!history || !pagination || !counter || !previous || !next) return;

  let page = 0;
  function showHistoryPage() {
    const items = [...history.children].filter(item => item.classList.contains('mission-history-item'));
    page = Math.max(0, Math.min(page, items.length - 1));
    items.forEach((item, index) => { item.hidden = index !== page; });
    counter.textContent = items.length ? `${page + 1} / ${items.length}` : '0 missions';
    previous.disabled = page === 0;
    next.disabled = !items.length || page === items.length - 1;
    pagination.hidden = items.length === 0;
  }

  previous.addEventListener('click', () => {
    if (previous.disabled) return;
    page -= 1;
    showHistoryPage();
  });
  next.addEventListener('click', () => {
    if (next.disabled) return;
    page += 1;
    showHistoryPage();
  });
  // The app owns each row and its actions. Observe only replacement of rows,
  // so hiding a page never triggers another render or removes its handlers.
  new MutationObserver(() => {
    page = 0;
    showHistoryPage();
  }).observe(history, { childList: true });
  showHistoryPage();
})();
