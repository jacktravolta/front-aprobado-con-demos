// front/meta-api-client.js — connection panel and generated-file manager.
//
// The front NEVER talks to meta-api. It only calls the own API:
//   GET/PUT /api/config, GET /api/health, GET/DELETE /api/files.
//
// The panel keeps the meta-api base URL and API key on the server side, so the
// browser never stores the key. Generated files are managed by the own API and
// persisted as plain JSON plus files on disk.

(() => {
  "use strict";

  if (window.__metaApiClientInstalled) return;
  window.__metaApiClientInstalled = true;

  const CONFIG_URL = "/api/config";
  const HEALTH_URL = "/api/health";
  const FILES_URL = "/api/files";

  const PANEL_ID = "meta-api-client-panel";

  function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
      } else if (key === "className") node.className = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === null || child === undefined) continue;
      node.appendChild(
        typeof child === "string" || typeof child === "number"
          ? document.createTextNode(String(child))
          : child,
      );
    }
    return node;
  }

  const inputStyle = {
    width: "100%",
    marginTop: "4px",
    padding: "6px 8px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,.2)",
    background: "rgba(255,255,255,.06)",
    color: "inherit",
    fontSize: "12px",
    boxSizing: "border-box",
  };

  const buttonStyle = {
    padding: "6px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,.25)",
    background: "rgba(255,255,255,.06)",
    color: "inherit",
    fontSize: "12px",
    cursor: "pointer",
  };

  async function callJson(url, options = {}) {
    const response = await fetch(url, options);
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new Error(
        String(data?.error || data?.detail || raw || `HTTP ${response.status}`).slice(
          0,
          800,
        ),
      );
    }
    return data;
  }

  function bytesLabel(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function downloadUrl(file) {
    const url = String(file?.url || "");
    if (!url) return "";
    return `${url}${url.includes("?") ? "&" : "?"}download=1`;
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);

    const status = make("div", {
      style: { fontSize: "11px", opacity: "0.8", marginTop: "8px", whiteSpace: "pre-wrap" },
    });

    const baseUrl = make("input", {
      type: "text",
      placeholder: "http://127.0.0.1:8055",
      style: inputStyle,
    });
    const apiKey = make("input", {
      type: "password",
      placeholder: "Opcional mientras meta-api este abierto",
      style: inputStyle,
    });
    const model = make("input", { type: "text", placeholder: "meta-ai", style: inputStyle });
    const forceZip = make("input", { type: "checkbox" });
    const useLocalFiles = make("input", { type: "checkbox" });
    const clearKey = make("input", { type: "checkbox" });

    const filesBody = make("div", {
      style: {
        marginTop: "8px",
        maxHeight: "210px",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      },
    });

    const saveButton = make(
      "button",
      {
        type: "button",
        style: { ...buttonStyle, background: "#b3261e", borderColor: "#b3261e" },
        onClick: async () => {
          saveButton.disabled = true;
          saveButton.textContent = "Guardando...";
          try {
            const payload = {
              baseUrl: baseUrl.value.trim(),
              model: model.value.trim(),
              forceZip: forceZip.checked,
              useLocalFiles: useLocalFiles.checked,
            };
            if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
            if (clearKey.checked) payload.clearKey = true;
            const data = await callJson(CONFIG_URL, {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            apiKey.value = "";
            clearKey.checked = false;
            status.textContent = `Guardado. Base: ${data.baseUrl} · modelo: ${data.model} · key: ${
              data.hasKey ? "configurada" : "sin key"
            }`;
          } catch (error) {
            status.textContent = `Error: ${error.message}`;
          } finally {
            saveButton.disabled = false;
            saveButton.textContent = "Guardar";
          }
        },
      },
      "Guardar",
    );

    const testButton = make(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: async () => {
          testButton.disabled = true;
          testButton.textContent = "Probando...";
          try {
            const data = await callJson(HEALTH_URL);
            status.textContent = `meta-api OK · ${data.baseUrl} · modelos: ${(
              data.models || []
            ).join(", ")}`;
          } catch (error) {
            status.textContent = `Error: ${error.message}`;
          } finally {
            testButton.disabled = false;
            testButton.textContent = "Probar";
          }
        },
      },
      "Probar",
    );

    const refreshButton = make(
      "button",
      {
        type: "button",
        style: buttonStyle,
        onClick: () => refreshFiles(filesBody),
      },
      "Actualizar",
    );

    const panel = make(
      "section",
      {
        id: PANEL_ID,
        "data-meta-client-panel": "1",
        style: {
          position: "fixed",
          left: "18px",
          bottom: "18px",
          zIndex: "2147483400",
          width: "min(340px, calc(100vw - 36px))",
          background: "#151112",
          color: "#f7eded",
          border: "1px solid #3b2b2c",
          borderRadius: "14px",
          padding: "12px",
          boxShadow: "0 16px 44px rgba(0,0,0,.42)",
          fontFamily: "system-ui, sans-serif",
          fontSize: "12px",
        },
      },
      [
        make(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            },
          },
          [
            make("div", { style: { fontWeight: "800", fontSize: "13px" } }, "Conexion API"),
            make(
              "button",
              {
                type: "button",
                style: { ...buttonStyle, padding: "3px 8px" },
                onClick: () => {
                  panel.style.display = panel.style.display === "none" ? "block" : "none";
                },
              },
              "Ocultar",
            ),
          ],
        ),
        make("div", { style: { marginTop: "8px" } }, "Base URL de meta-api"),
        baseUrl,
        make("div", { style: { marginTop: "8px" } }, "API key (queda en el servidor)"),
        apiKey,
        make(
          "label",
          { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "6px", fontSize: "11px" } },
          [clearKey, "Borrar la key guardada"],
        ),
        make("div", { style: { marginTop: "8px" } }, "Modelo"),
        model,
        make(
          "label",
          { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "8px", fontSize: "12px" } },
          [forceZip, "Pedir ZIP resultado.zip"],
        ),
        make(
          "label",
          { style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "4px", fontSize: "12px" } },
          [useLocalFiles, "Guardar archivos en la API propia"],
        ),
        make(
          "div",
          { style: { display: "flex", gap: "6px", marginTop: "10px", flexWrap: "wrap" } },
          [saveButton, testButton],
        ),
        status,
        make(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: "12px",
              paddingTop: "8px",
              borderTop: "1px solid rgba(255,255,255,.12)",
            },
          },
          [
            make("div", { style: { fontWeight: "700" } }, "Archivos generados"),
            refreshButton,
          ],
        ),
        filesBody,
      ],
    );

    document.body.appendChild(panel);
    panel.__meta = {
      baseUrl,
      apiKey,
      model,
      forceZip,
      useLocalFiles,
      clearKey,
      status,
      filesBody,
    };
    return panel;
  }

  async function refreshFiles(container) {
    if (!container) return;
    container.textContent = "Cargando...";
    try {
      const data = await callJson(FILES_URL);
      const files = Array.isArray(data?.files) ? data.files : [];
      container.textContent = "";
      if (!files.length) {
        container.appendChild(
          make("div", { style: { opacity: "0.7", fontSize: "11px" } }, "Todavia no hay archivos."),
        );
        return;
      }
      for (const file of files) {
        const row = make(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              justifyContent: "space-between",
              padding: "5px 6px",
              borderRadius: "7px",
              background: "rgba(255,255,255,.04)",
            },
          },
          [
            make(
              "a",
              {
                href: downloadUrl(file),
                download: file.name,
                style: {
                  color: "inherit",
                  fontSize: "11px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              },
              `${file.kind || "archivo"} · ${file.name}${
                file.bytes ? ` · ${bytesLabel(file.bytes)}` : ""
              }`,
            ),
            make(
              "button",
              {
                type: "button",
                title: "Eliminar",
                style: { ...buttonStyle, padding: "2px 6px", fontSize: "11px" },
                onClick: async () => {
                  try {
                    await callJson(`${FILES_URL}/${file.id}`, { method: "DELETE" });
                    refreshFiles(container);
                  } catch (error) {
                    container.appendChild(
                      make("div", { style: { color: "#ff8a80", fontSize: "11px" } }, error.message),
                    );
                  }
                },
              },
              "X",
            ),
          ],
        );
        container.appendChild(row);
      }
    } catch (error) {
      container.textContent = `Error: ${error.message}`;
    }
  }

  async function loadConfig(panel) {
    const refs = panel.__meta || {};
    try {
      const data = await callJson(CONFIG_URL);
      if (refs.baseUrl) refs.baseUrl.value = data.baseUrl || "";
      if (refs.model) refs.model.value = data.model || "";
      if (refs.forceZip) refs.forceZip.checked = data.forceZip !== false;
      if (refs.useLocalFiles) refs.useLocalFiles.checked = data.useLocalFiles !== false;
      if (refs.apiKey) {
        refs.apiKey.placeholder = data.hasKey
          ? "Key configurada en el servidor (escribe para reemplazarla)"
          : "Opcional mientras meta-api este abierto";
      }
    } catch (error) {
      console.warn("[meta-api-client] no se pudo leer la configuracion", error);
    }
  }

  // The existing front persists results through fetch("actions"). When the last
  // generation produced a file, attach its download link to the saved record.
  function installActionsBridge() {
    if (window.__metaActionsBridgeInstalled) return;
    window.__metaActionsBridgeInstalled = true;
    const originalFetch = window.fetch.bind(window);

    window.fetch = async function (input, init) {
      let nextInit = init;
      try {
        const url = typeof input === "string" ? input : input?.url || "";
        const method = String(
          init?.method || (typeof input === "string" ? "" : input?.method) || "GET",
        ).toUpperCase();
        if (method === "POST" && /(^|\/)actions(\?|$)/.test(url) && init?.body) {
          const body = JSON.parse(init.body);
          if (
            body?.action === "records.create" &&
            body?.args?.collection === "results"
          ) {
            if (!body.args.value) body.args.value = {};
            const value = body.args.value;
            const last = window.__lastMetaFile;
            if (!value.enlace && last?.url) {
              value.enlace = `${last.url}${String(last.url).includes("?") ? "&" : "?"}download=1`;
              value.archivo = last.name || "";
              value.kind = last.kind || "";
            }
            nextInit = { ...(init || {}), body: JSON.stringify(body) };
          }
        }
      } catch {
        /* never break the original request */
      }
      return originalFetch(input, nextInit);
    };
  }

  function init() {
    installActionsBridge();
    const panel = buildPanel();
    loadConfig(panel);
    refreshFiles(panel.__meta?.filesBody);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
