(function () {
  "use strict";

  const PLUGIN_NAME = "hermes-cost-lens";
  const SDK = window.__HERMES_PLUGIN_SDK__;

  if (!SDK || !window.__HERMES_PLUGINS__) {
    console.warn(`[${PLUGIN_NAME}] Hermes plugin SDK is not available.`);
    return;
  }

  const { React } = SDK;
  const appUrl = `/dashboard-plugins/${PLUGIN_NAME}/app/index.html`;

  function CostAnalyzerPage() {
    return React.createElement(
      "div",
      { className: "hca-shell" },
      React.createElement("iframe", {
        className: "hca-frame",
        title: "Hermes Cost Lens",
        src: appUrl,
        loading: "eager",
      }),
    );
  }

  window.__HERMES_PLUGINS__.register(PLUGIN_NAME, CostAnalyzerPage);
})();
