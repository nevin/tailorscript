chrome.devtools.panels.create("Tailorscript", "icons/icon16.png", "devtools/panel.html", panel => {
  let view;
  panel.onShown.addListener(window => { view = window; });
  panel.onHidden.addListener(() => view?.dispatchEvent(new Event("builder-hidden")));
});
