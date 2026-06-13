(function () {
  "use strict";

  const PLUGIN_NAME = "hermes-cost-lens";
  const SDK = window.__HERMES_PLUGIN_SDK__;

  if (!SDK || !window.__HERMES_PLUGINS__) {
    console.warn(`[${PLUGIN_NAME}] Hermes plugin SDK is not available.`);
    return;
  }

  const { React } = SDK;
  const { useCallback, useEffect, useMemo, useState } = SDK.hooks;
  const appBaseUrl = `/dashboard-plugins/${PLUGIN_NAME}/app/index.html`;

  function sessionLabel(session) {
    return session.title || session.name || session.id || "Untitled session";
  }

  function sessionMeta(session) {
    return [
      session.model,
      session.message_count != null ? `${session.message_count} msgs` : null,
      session.tool_call_count != null ? `${session.tool_call_count} tools` : null,
      session.source,
    ].filter(Boolean).join(" · ");
  }

  function sessionUrl(sessionId) {
    return `/cost-lens?session=${encodeURIComponent(sessionId)}`;
  }

  function appUrl(sessionId) {
    const suffix = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
    return `${appBaseUrl}${suffix}`;
  }

  function LoadingRows() {
    return React.createElement("div", { className: "hcl-loading" },
      "Loading sessions...",
    );
  }

  function ErrorBox({ error }) {
    if (!error) return null;
    return React.createElement("div", { className: "hcl-error" }, error);
  }

  function SessionList({ sessions, selectedId, onSelect }) {
    if (!sessions.length) {
      return React.createElement("div", { className: "hcl-empty" },
        "No sessions returned by the dashboard API.",
      );
    }

    return React.createElement("div", { className: "hcl-session-list" },
      sessions.map((session) => {
        const id = session.id || session.session_id;
        const active = id === selectedId;
        return React.createElement("button", {
          key: id,
          type: "button",
          className: `hcl-session ${active ? "is-active" : ""}`,
          onClick: () => onSelect(id),
        },
          React.createElement("span", { className: "hcl-session-title" },
            sessionLabel(session),
          ),
          React.createElement("span", { className: "hcl-session-meta" },
            sessionMeta(session) || id,
          ),
        );
      }),
    );
  }

  function CostLensPage() {
    const initialSessionId = useMemo(
      () => new URLSearchParams(window.location.search).get("session") || "",
      [],
    );
    const [sessions, setSessions] = useState([]);
    const [selectedId, setSelectedId] = useState(initialSessionId);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      SDK.api.getSessions(50)
        .then((resp) => {
          if (cancelled) return;
          const list = resp.sessions || resp.items || [];
          setSessions(list);
          if (!selectedId && list.length) {
            const firstId = list[0].id || list[0].session_id;
            setSelectedId(firstId || "");
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => { cancelled = true; };
    }, []);

    const selectSession = useCallback((id) => {
      setSelectedId(id);
      const next = sessionUrl(id);
      window.history.replaceState(null, "", next);
    }, []);

    return React.createElement("div", { className: "hcl-page" },
      React.createElement("aside", { className: "hcl-sidebar" },
        React.createElement("div", { className: "hcl-sidebar-head" },
          React.createElement("h2", null, "Cost Lens"),
          React.createElement("p", null, "Open a Hermes session directly from history; no JSON upload needed."),
        ),
        loading ? React.createElement(LoadingRows) : null,
        React.createElement(ErrorBox, { error }),
        React.createElement(SessionList, {
          sessions,
          selectedId,
          onSelect: selectSession,
        }),
      ),
      React.createElement("main", { className: "hcl-main" },
        React.createElement("iframe", {
          key: selectedId || "empty",
          className: "hcl-frame",
          title: "Hermes Cost Lens",
          src: appUrl(selectedId),
          loading: "eager",
        }),
      ),
    );
  }

  function SessionsQuickLinks() {
    const [sessions, setSessions] = useState([]);
    const [error, setError] = useState("");

    useEffect(() => {
      let cancelled = false;
      SDK.api.getSessions(8)
        .then((resp) => {
          if (!cancelled) setSessions(resp.sessions || resp.items || []);
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || String(err));
        });
      return () => { cancelled = true; };
    }, []);

    if (error) {
      return React.createElement("div", { className: "hcl-slot hcl-error" },
        `Cost Lens could not load recent sessions: ${error}`,
      );
    }

    if (!sessions.length) return null;

    return React.createElement("div", { className: "hcl-slot" },
      React.createElement("div", { className: "hcl-slot-head" },
        React.createElement("strong", null, "Cost Lens"),
        React.createElement("span", null, "Direct analysis links for recent sessions"),
      ),
      React.createElement("div", { className: "hcl-slot-links" },
        sessions.map((session) => {
          const id = session.id || session.session_id;
          return React.createElement("a", {
            key: id,
            className: "hcl-slot-link",
            href: sessionUrl(id),
          },
            React.createElement("span", null, sessionLabel(session)),
            React.createElement("small", null, sessionMeta(session) || id),
          );
        }),
      ),
    );
  }

  window.__HERMES_PLUGINS__.register(PLUGIN_NAME, CostLensPage);
  window.__HERMES_PLUGINS__.registerSlot(PLUGIN_NAME, "sessions:top", SessionsQuickLinks);
})();
