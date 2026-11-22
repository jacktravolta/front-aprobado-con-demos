// front/media-results.js — "Implementar" action and multimedia result UI.
//
// This script is intentionally independent from the React bundle. It observes
// the rendered front, adds an "Implementar" button to every generated prompt,
// sends the prompt to the own API, and renders the files returned by meta-api:
// images, videos, audio, SRT, ZIP bundles and generic downloads.
//
// It never talks to meta-api directly. It only uses the own API.

(() => {
  "use strict";

  if (window.__metaMediaResultsInstalled) return;
  window.__metaMediaResultsInstalled = true;

  const API_CHAT = "/api/chat";
  const API_IMPROVE = "/api/improve";
  const API_FILES = "/api/files";
  const API_ACTIONS = "/actions";

  const PANEL_ID = "meta-media-results-panel";
  const IMPLEMENT_ATTR = "data-meta-implement";
  const IMPROVE_ATTR = "data-meta-improve";
  const FIELD_ATTR = "data-meta-improve-field";
  const PROMPT_IMPROVE_ATTR = "data-meta-improve-prompt";

  const MEDIA_KINDS = new Set(["image", "video", "audio", "subtitle"]);

  function make(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null) continue;
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
      } else if (key === "dataset" && typeof value === "object") {
        Object.assign(node.dataset, value);
      } else if (key === "className") {
        node.className = value;
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node) {
        node[key] = value;
      } else {
        node.setAttribute(key, value);
      }
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

  function isVisible(node) {
    if (!node || !(node instanceof Element)) return false;
    const style = window.getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function nativeSetValue(field, value) {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fieldLabel(field) {
    const aria = field.getAttribute("aria-label");
    if (aria) return aria;
    const id = field.id;
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent.trim()) return label.textContent.trim();
    }
    const parentLabel = field.closest("label");
    if (parentLabel && parentLabel.textContent.trim()) {
      return parentLabel.textContent.trim();
    }
    return field.getAttribute("name") || field.getAttribute("placeholder") || "campo";
  }

  const SRT_MAX_CUES = 200;

  function srtCard() {
    return [...document.querySelectorAll(".card")].find((card) =>
      [...card.querySelectorAll("h3")].some(
        (heading) => heading.textContent.trim() === "Editor SRT",
      ),
    );
  }

  function srtRows(card) {
    return [...(card?.querySelector("tbody")?.rows || [])];
  }

  function srtSourceTextarea(card) {
    const panel = card?.closest("section[aria-hidden]");
    const table = card?.querySelector("table");
    if (!panel) return null;
    const areas = [...panel.querySelectorAll("textarea")].filter(
      (area) => !table?.contains(area),
    );
    const labelText = (area) =>
      [fieldLabel(area), ...(area.labels ? [...area.labels].map((label) => label.textContent) : [])]
        .join(" ");
    return areas.find((area) => /srt|gu[ií]on/i.test(labelText(area))) || areas[0] || null;
  }

  function waitFor(check, attempts = 100) {
    return new Promise((resolve) => {
      let remaining = attempts;
      const tick = () => {
        const value = check();
        if (value) return resolve(value);
        if (remaining-- <= 0) return resolve(null);
        setTimeout(tick, 16);
      };
      tick();
    });
  }

  function setReactValue(field, value) {
    if (!field) return false;
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(field, String(value));
    else field.value = String(value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  async function setSrtField(card, index, selector, value) {
    const field = srtRows(card)[index]?.querySelector(selector);
    if (!setReactValue(field, value)) throw new Error("No se encontró la fila SRT.");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const updated = await waitFor(() => {
      const current = srtRows(card)[index]?.querySelector(selector);
      return current?.value === String(value) ? current : null;
    });
    if (!updated) throw new Error(`No se pudo actualizar la fila ${index + 1}.`);
  }

  async function growSrtRows(card, target) {
    while (srtRows(card).length < target) {
      const before = srtRows(card).length;
      const add = [...card.querySelectorAll("button")].find((button) =>
        /fila$/i.test(button.textContent.trim()),
      );
      if (!add) throw new Error("No se encontró el botón para agregar filas.");
      add.click();
      const grown = await waitFor(() => {
        const rows = srtRows(card);
        return rows.length > before ? rows : null;
      });
      if (!grown) throw new Error("El editor SRT no agregó la fila esperada.");
    }
  }

  async function fillSrtRows(card, cues) {
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      await setSrtField(card, index, "td:nth-child(1) input", cue.start);
      await setSrtField(card, index, "td:nth-child(2) input", cue.end);
      await setSrtField(card, index, "td:nth-child(3) textarea", cue.text);
    }
  }

  async function trimSrtRows(card, target) {
    while (srtRows(card).length > target) {
      const before = srtRows(card).length;
      const rows = srtRows(card);
      const remove = rows[rows.length - 1]
        ?.querySelector('button[aria-label="Eliminar fila SRT"]');
      if (!remove) throw new Error("No se encontró el botón para eliminar filas.");
      remove.click();
      const removed = await waitFor(() => {
        const rows = srtRows(card);
        return rows.length < before ? rows : null;
      });
      if (!removed) throw new Error("El editor SRT no eliminó la fila esperada.");
    }
  }

  async function importSrtCues(text, codec) {
    const card = srtCard();
    if (!card) throw new Error("No se encontró el editor SRT.");
    const parsed = codec.parseCues(text);
    if (!parsed.length) throw new Error("No se encontraron subtítulos válidos.");
    const cues = parsed.slice(0, SRT_MAX_CUES);
    await growSrtRows(card, cues.length);
    await fillSrtRows(card, cues);
    await trimSrtRows(card, cues.length);
    const suffix = parsed.length > SRT_MAX_CUES ? ` (primeros ${SRT_MAX_CUES} de ${parsed.length})` : "";
    toast(`SRT importado: ${cues.length} subtítulos${suffix}.`, "success");
  }

  function exportSrt(format) {
    const card = srtCard();
    const rows = srtRows(card);
    const codec = globalThis.MetaSrt;
    if (!card || !rows.length) {
      toast("No hay subtítulos para exportar.");
      return;
    }
    if (!codec) {
      toast("El codec de subtítulos no está disponible.");
      return;
    }
    const cues = codec.cuesFromRows(
      rows.map((row) => {
        const cells = row.querySelectorAll("td");
        return {
          inicio: cells[0]?.querySelector("input")?.value || "",
          fin: cells[1]?.querySelector("input")?.value || "",
          texto: cells[2]?.querySelector("textarea")?.value || "",
        };
      }),
    ) || [];
    if (!cues.length) {
      toast("No hay subtítulos válidos para exportar.");
      return;
    }
    const vtt = format === "vtt";
    const content = vtt ? codec.toVtt(cues) : codec.toSrt(cues);
    const type = vtt ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8";
    const url = URL.createObjectURL(new Blob([content], { type }));
    const anchor = make("a", {
      href: url,
      download: vtt ? "subtitulos.vtt" : "subtitulos.srt",
    });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function installSrtEditor() {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      const card = srtCard();
      if (!button || !card?.contains(button)) return;
      const label = button.textContent.trim();

      if (label === "Exportar SRT" || label === "Exportar VTT") {
        setTimeout(() => exportSrt(label === "Exportar VTT" ? "vtt" : "srt"), 0);
        return;
      }
      if (label !== "Importar SRT pegado") return;
      const text = srtSourceTextarea(card)?.value || "";
      const codec = globalThis.MetaSrt;
      if (!codec || typeof codec.isSubtitleText !== "function") return;
      if (!codec.isSubtitleText(text)) return;
      event.preventDefault();
      event.stopPropagation();
      importSrtCues(text, codec).catch((error) => {
        toast(`No se pudo importar el SRT: ${error.message}`);
      });
    }, true);
  }

  function installSrtEditorOnce() {
    if (document.__metaSrtEditorInstalled) return;
    document.__metaSrtEditorInstalled = true;
    installSrtEditor();
  }

  function findPromptTextarea(from) {
    let node = from;
    while (node && node !== document.body) {
      if (node.querySelector) {
        const textarea = node.querySelector("textarea[readonly]");
        if (textarea) return textarea;
      }
      node = node.parentElement;
    }
    return null;
  }

  function promptLabel(textarea) {
    return (
      textarea.getAttribute("aria-label") ||
      textarea.getAttribute("data-label") ||
      "Módulo"
    );
  }

  function kindOf(file) {
    const explicit = String(file?.kind || "").toLowerCase();
    if (["image", "video", "audio", "subtitle", "archive", "document", "other"].includes(explicit)) {
      return explicit;
    }
    const mime = String(file?.mime || "").toLowerCase();
    const name = String(file?.name || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() : "";
    if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif"].includes(ext)) {
      return "image";
    }
    if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "mkv", "avi"].includes(ext)) {
      return "video";
    }
    if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "aac", "flac"].includes(ext)) {
      return "audio";
    }
    if (["srt", "vtt", "ass", "ssa"].includes(ext) || mime.includes("vtt")) {
      return "subtitle";
    }
    if (["zip", "rar", "7z", "tar", "gz"].includes(ext) || mime.includes("zip")) {
      return "archive";
    }
    if (
      ["pdf", "doc", "docx", "txt", "md", "html", "csv", "xls", "xlsx", "ppt", "pptx"].includes(ext) ||
      mime.startsWith("text/")
    ) {
      return "document";
    }
    return "other";
  }

  function inlineUrl(file) {
    const url = String(file?.url || "");
    if (!url) return "";
    return `${url}${url.includes("?") ? "&" : "?"}inline=1`;
  }

  function downloadUrl(file) {
    const url = String(file?.url || "");
    if (!url) return "";
    return `${url}${url.includes("?") ? "&" : "?"}download=1`;
  }

  function bytesLabel(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function toast(message, tone = "error") {
    const id = "meta-media-toast";
    const previous = document.getElementById(id);
    if (previous) previous.remove();
    const node = make(
      "div",
      {
        id,
        style: {
          position: "fixed",
          left: "18px",
          bottom: "18px",
          zIndex: "2147483600",
          maxWidth: "min(520px, calc(100vw - 36px))",
          padding: "12px 16px",
          borderRadius: "12px",
          background: tone === "error" ? "#5b1f1f" : "#173b2a",
          color: "#fff",
          fontFamily: "system-ui, sans-serif",
          fontSize: "13px",
          lineHeight: "1.4",
          boxShadow: "0 12px 30px rgba(0,0,0,.35)",
          border: "1px solid rgba(255,255,255,.15)",
        },
      },
      message,
    );
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 6500);
  }

  async function callJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message =
        data?.error ||
        data?.detail ||
        text ||
        `La API propia respondió ${response.status}.`;
      throw new Error(String(message).slice(0, 1200));
    }
    return data;
  }

  function panelShell(title) {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    const close = make(
      "button",
      {
        type: "button",
        style: {
          background: "transparent",
          border: "1px solid rgba(255,255,255,.25)",
          color: "#fff",
          borderRadius: "8px",
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: () => panel.remove(),
      },
      "Cerrar",
    );

    const all = make(
      "button",
      {
        type: "button",
        style: {
          background: "transparent",
          border: "1px solid rgba(255,255,255,.25)",
          color: "#fff",
          borderRadius: "8px",
          padding: "4px 10px",
          cursor: "pointer",
          fontSize: "12px",
          marginRight: "6px",
        },
        onClick: async () => {
          try {
            const data = await callJson(API_FILES);
            renderResults({ files: data?.files || [] }, "Archivos generados");
          } catch (error) {
            toast(error.message);
          }
        },
      },
      "Ver todos",
    );

    const body = make("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        marginTop: "14px",
        maxHeight: "calc(80vh - 100px)",
        overflow: "auto",
        paddingRight: "4px",
      },
    });

    const panel = make(
      "section",
      {
        id: PANEL_ID,
        "data-meta-client-panel": "1",
        style: {
          position: "fixed",
          right: "18px",
          bottom: "18px",
          zIndex: "2147483500",
          width: "min(560px, calc(100vw - 36px))",
          background: "#151112",
          color: "#f7eded",
          border: "1px solid #3b2b2c",
          borderRadius: "16px",
          padding: "16px",
          boxShadow: "0 20px 60px rgba(0,0,0,.45)",
          fontFamily: "system-ui, sans-serif",
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
              gap: "12px",
            },
          },
          [
            make(
              "div",
              {},
              [
                make(
                  "div",
                  { style: { fontSize: "15px", fontWeight: "800" } },
                  "Resultados generados",
                ),
                make(
                  "div",
                  { style: { fontSize: "12px", opacity: "0.72", marginTop: "2px" } },
                  title,
                ),
              ],
            ),
            make("div", {}, [all, close]),
          ],
        ),
        body,
      ],
    );

    panel.__metaBody = body;
    document.body.appendChild(panel);
    return panel;
  }

  function addFileCard(body, file, title) {
    const kind = kindOf(file);
    const name = file?.name || "archivo";
    const mediaUrl = inlineUrl(file);
    const download = downloadUrl(file);

    const card = make("div", {
      style: {
        border: "1px solid rgba(255,255,255,.12)",
        borderRadius: "12px",
        padding: "12px",
        background: "rgba(255,255,255,.03)",
      },
    });

    card.appendChild(
      make(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            marginBottom: "8px",
          },
        },
        [
          make(
            "div",
            { style: { minWidth: "0" } },
            [
              make(
                "div",
                {
                  style: {
                    fontWeight: "700",
                    fontSize: "13px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  },
                },
                name,
              ),
              make(
                "div",
                { style: { fontSize: "11px", opacity: "0.65", marginTop: "2px" } },
                `${kind}${file?.bytes ? ` · ${bytesLabel(file.bytes)}` : ""}`,
              ),
            ],
          ),
          make(
            "a",
            {
              href: download,
              download: name,
              style: {
                color: "#fff",
                background: "#b3261e",
                borderRadius: "8px",
                padding: "6px 10px",
                textDecoration: "none",
                fontSize: "12px",
                fontWeight: "700",
                whiteSpace: "nowrap",
              },
            },
            "Descargar",
          ),
        ],
      ),
    );

    if (kind === "image" && mediaUrl) {
      card.appendChild(
        make("img", {
          src: mediaUrl,
          alt: name,
          loading: "lazy",
          style: {
            width: "100%",
            maxHeight: "320px",
            objectFit: "contain",
            borderRadius: "10px",
            background: "#0c0a0a",
          },
        }),
      );
    } else if (kind === "video" && mediaUrl) {
      card.appendChild(
        make("video", {
          src: mediaUrl,
          controls: true,
          preload: "metadata",
          style: { width: "100%", maxHeight: "320px", borderRadius: "10px", background: "#000" },
        }),
      );
    } else if (kind === "audio" && mediaUrl) {
      card.appendChild(
        make("audio", {
          src: mediaUrl,
          controls: true,
          preload: "metadata",
          style: { width: "100%" },
        }),
      );
    } else if (kind === "subtitle" && mediaUrl) {
      const preview = make("pre", {
        style: {
          margin: "8px 0 0",
          padding: "10px",
          borderRadius: "8px",
          background: "#0c0a0a",
          color: "#d8cfcf",
          fontSize: "11px",
          lineHeight: "1.45",
          maxHeight: "180px",
          overflow: "auto",
          whiteSpace: "pre-wrap",
        },
      });
      preview.textContent = "Cargando vista previa...";
      card.appendChild(preview);
      fetch(mediaUrl)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error("No se pudo leer el SRT"))))
        .then((text) => {
          const lines = text.split(/\r?\n/);
          preview.textContent = lines.slice(0, 40).join("\n") + (lines.length > 40 ? "\n..." : "");
        })
        .catch(() => {
          preview.textContent = "Vista previa no disponible. Usa Descargar.";
        });
    } else if (kind === "archive") {
      card.appendChild(
        make(
          "div",
          { style: { fontSize: "12px", opacity: "0.8", marginTop: "6px" } },
          "ZIP con todos los archivos generados.",
        ),
      );
    }

    const save = make(
      "button",
      {
        type: "button",
        style: {
          marginTop: "10px",
          background: "transparent",
          color: "#fff",
          border: "1px solid rgba(255,255,255,.25)",
          borderRadius: "8px",
          padding: "6px 10px",
          cursor: "pointer",
          fontSize: "12px",
        },
        onClick: async () => {
          save.disabled = true;
          save.textContent = "Guardando...";
          try {
            await callJson(API_ACTIONS, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "records.create",
                args: {
                  collection: "results",
                  idempotency_key: `result-${file?.id || name}`,
                  value: {
                    nombre: title,
                    enlace: download,
                    archivo: name,
                    kind,
                  },
                },
              }),
            });
            save.textContent = "Guardado";
          } catch (error) {
            save.disabled = false;
            save.textContent = "Guardar en Mis Resultados";
            toast(error.message);
          }
        },
      },
      "Guardar en Mis Resultados",
    );
    card.appendChild(save);
    body.appendChild(card);
  }

  function renderResults(data, title) {
    const panel = panelShell(title || "Módulo");
    const body = panel.__metaBody;
    const files = Array.isArray(data?.files) ? data.files.slice() : [];
    const bundle = data?.bundle && typeof data.bundle === "object" ? data.bundle : null;

    if (bundle && !files.some((f) => f?.id && bundle.id && f.id === bundle.id)) {
      files.unshift(bundle);
    }

    if (!files.length) {
      body.appendChild(
        make(
          "div",
          { style: { fontSize: "13px", opacity: "0.8" } },
          "La generación no devolvió archivos. Revisa la configuración y el detalle del error.",
        ),
      );
      return;
    }

    for (const file of files) addFileCard(body, file, title || "Módulo");
  }

  // Each prompt type gets its own meta-api channel, so two implementations of
  // the same module do not reuse (and dedupe) the same artifacts.
  function channelSlug(label) {
    const base = String(label || "modulo").split("·")[0];
    const slug = base
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return slug || "modulo";
  }

  // ---------------------------------------------------------------------------
  // "Mis Resultados": the section of the front must show the files that the own
  // API manages, with the same previews and download links.
  // ---------------------------------------------------------------------------

  function resultsSection() {
    const visible = Array.from(
      document.querySelectorAll('section[aria-hidden="false"]'),
    ).find((s) => /Mis Resultados/i.test(s.textContent || ""));
    if (visible) return visible;
    return Array.from(document.querySelectorAll("section[aria-hidden]")).find(
      (s) => /Mis Resultados/i.test(s.textContent || ""),
    );
  }

  function ensureResultsBlock(section) {
    if (!section) return null;
    let block = section.querySelector("[data-meta-files-block]");
    if (!block) {
      block = make("div", {
        "data-meta-files-block": "1",
        style: {
          marginTop: "18px",
          paddingTop: "14px",
          borderTop: "1px solid rgba(255,255,255,.12)",
        },
      });
      section.appendChild(block);
    }
    return block;
  }

  function renderFilesBlock(block, files) {
    try {
      block.textContent = "";
      block.appendChild(
        make(
          "h3",
          { style: { fontWeight: "800", fontSize: "15px", marginBottom: "8px" } },
          "Archivos generados por la API",
        ),
      );
      if (!files.length) {
        block.appendChild(
          make(
            "div",
            { style: { fontSize: "13px", opacity: "0.75" } },
            "Todavia no hay archivos. Pulsa Implementar en cualquier modulo.",
          ),
        );
        return;
      }
      for (const file of files) {
        const kind = kindOf(file);
        const row = make("div", {
          style: {
            display: "flex",
            gap: "12px",
            alignItems: "flex-start",
            padding: "10px",
            marginBottom: "8px",
            borderRadius: "10px",
            background: "rgba(255,255,255,.04)",
            border: "1px solid rgba(255,255,255,.1)",
          },
        });

        const info = make("div", { style: { minWidth: "150px", flex: "0 0 auto" } }, [
          make(
            "div",
            { style: { fontWeight: "700", fontSize: "13px" } },
            file.name || "archivo",
          ),
          make(
            "div",
            { style: { fontSize: "11px", opacity: "0.7", marginTop: "2px" } },
            `${kind}${file.bytes ? ` · ${bytesLabel(file.bytes)}` : ""}`,
          ),
          make(
            "a",
            {
              href: downloadUrl(file),
              download: file.name,
              style: {
                display: "inline-block",
                marginTop: "6px",
                color: "inherit",
                fontSize: "12px",
                textDecoration: "underline",
              },
            },
            "Descargar",
          ),
        ]);

        const preview = make("div", {
          style: { flex: "1 1 auto", minWidth: "0", display: "flex", gap: "8px", flexWrap: "wrap" },
        });
        if (kind === "image") {
          preview.appendChild(
            make("img", {
              src: inlineUrl(file),
              alt: file.name,
              loading: "lazy",
              style: { maxWidth: "180px", borderRadius: "8px" },
            }),
          );
        } else if (kind === "video") {
          preview.appendChild(
            make("video", {
              src: inlineUrl(file),
              controls: true,
              preload: "metadata",
              style: { maxWidth: "260px", borderRadius: "8px" },
            }),
          );
        } else if (kind === "audio") {
          preview.appendChild(
            make("audio", { src: inlineUrl(file), controls: true, style: { width: "100%" } }),
          );
        } else if (kind === "subtitle") {
          const pre = make("pre", {
            style: {
              margin: "0",
              maxHeight: "120px",
              overflow: "auto",
              fontSize: "11px",
              background: "rgba(0,0,0,.35)",
              padding: "8px",
              borderRadius: "8px",
              whiteSpace: "pre-wrap",
            },
          });
          preview.appendChild(pre);
          fetch(inlineUrl(file))
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error("sin SRT"))))
            .then((text) => {
              pre.textContent = text.split(/\r?\n/).slice(0, 24).join("\n");
            })
            .catch(() => {
              pre.textContent = "Vista previa no disponible.";
            });
        }

        row.appendChild(info);
        row.appendChild(preview);
        block.appendChild(row);
      }
    } catch (error) {
      block.textContent = "";
      block.appendChild(
        make("div", { style: { fontSize: "13px", opacity: "0.8" } }, `Error: ${error.message}`),
      );
    }
  }

  // Fetches the managed files and repaints the block when the set changed.
  async function refreshResultsBlock(force = false) {
    if (force) {
      resultsSignature = "";
      resultsFetchAt = 0;
    }
    await checkResultsVisibility();
  }

  async function implement(button) {
    const textarea = findPromptTextarea(button);
    if (!textarea) {
      toast("No encontré el prompt de este módulo.");
      return;
    }
    const prompt = String(textarea.dataset.metaImprovedPrompt || textarea.value || "").trim();
    if (!prompt) {
      toast("El prompt está vacío. Genera el prompt primero.");
      return;
    }

    const label = promptLabel(textarea);
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Generando...";
    try {
      const data = await callJson(API_CHAT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: prompt,
          module: label,
          title: label,
          project: channelSlug(label),
          fresh: true,
          mode: "media",
        }),
      });
      window.__lastMetaFile = data?.bundle || data?.files?.[0] || null;
      renderResults(data, label);
      refreshResultsBlock(true);
      button.textContent = "Implementado";
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1800);
    } catch (error) {
      button.textContent = original;
      button.disabled = false;
      toast(error.message);
    }
  }

  function addImplementButtons() {
    const buttons = document.querySelectorAll("button");
    for (const copyButton of buttons) {
      if (!/copiar prompt/i.test(copyButton.textContent || "")) continue;
      const parent = copyButton.parentElement;
      if (!parent || parent.querySelector(`[${IMPLEMENT_ATTR}]`)) continue;

      const button = make(
        "button",
        {
          type: "button",
          className: "yellow",
          [IMPLEMENT_ATTR]: "1",
          style: { marginLeft: "8px" },
          onClick: () => implement(button),
        },
        "Implementar",
      );
      copyButton.insertAdjacentElement("afterend", button);
    }
  }

  async function improvePrompt(button) {
    const textarea = findPromptTextarea(button);
    if (!textarea) {
      toast("No encontré el prompt de este módulo.");
      return;
    }
    const text = String(textarea.dataset.metaImprovedPrompt || textarea.value || "").trim();
    if (!text) {
      toast("El prompt está vacío.");
      return;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Mejorando...";
    try {
      const data = await callJson(API_IMPROVE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, mode: "prompt", field: promptLabel(textarea) }),
      });
      const improved = String(data?.text || "").trim();
      if (!improved) throw new Error("La API propia no devolvió texto mejorado.");
      textarea.dataset.metaImprovedPrompt = improved;
      nativeSetValue(textarea, improved);
      button.textContent = "Prompt mejorado";
      setTimeout(() => {
        button.textContent = original;
        button.disabled = false;
      }, 1600);
    } catch (error) {
      button.textContent = original;
      button.disabled = false;
      toast(error.message);
    }
  }

  function addPromptImproveButtons() {
    const textareas = document.querySelectorAll("textarea[readonly]");
    for (const textarea of textareas) {
      const label = promptLabel(textarea);
      if (!/prompt|módulo|modulo/i.test(label)) continue;

      let card = textarea;
      while (card && card !== document.body) {
        const copyButton = [...card.querySelectorAll("button")].find((b) =>
          /copiar prompt/i.test(b.textContent || ""),
        );
        if (copyButton) {
          const parent = copyButton.parentElement;
          if (!parent) break;
          if (parent.querySelector(`[${PROMPT_IMPROVE_ATTR}]`)) break;
          if (
            [...parent.querySelectorAll("button")].some(
              (b) => /mejorar/i.test(b.textContent || "") && !b.hasAttribute(IMPLEMENT_ATTR),
            )
          ) {
            break;
          }
          const button = make(
            "button",
            {
              type: "button",
              className: "ghost",
              [PROMPT_IMPROVE_ATTR]: "1",
              style: { marginLeft: "8px" },
              onClick: () => improvePrompt(button),
            },
            "Mejorar con IA",
          );
          copyButton.insertAdjacentElement("afterend", button);
          break;
        }
        card = card.parentElement;
      }
    }
  }

  async function improveField(button, field) {
    const text = String(field.value || "").trim();
    if (!text) {
      toast("Escribe algo primero.");
      return;
    }
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Mejorando...";
    try {
      const data = await callJson(API_IMPROVE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          mode: "text",
          field: fieldLabel(field),
        }),
      });
      const improved = String(data?.text || "").trim();
      if (!improved) throw new Error("La API propia no devolvió texto mejorado.");
      nativeSetValue(field, improved);
      button.textContent = "Mejorado";
      setTimeout(() => {
        button.textContent = original;
        button.disabled = !String(field.value || "").trim();
      }, 1400);
    } catch (error) {
      button.textContent = original;
      button.disabled = !String(field.value || "").trim();
      toast(error.message);
    }
  }

  function addFieldImproveButtons() {
    const fields = document.querySelectorAll("input, textarea");
    for (const field of fields) {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) continue;
      if (field.readOnly || field.disabled) continue;
      if (field.closest(`#${PANEL_ID}, [data-meta-client-panel]`)) continue;
      if (field.hasAttribute(FIELD_ATTR)) continue;

      const type = (field.getAttribute("type") || "text").toLowerCase();
      if (
        [
          "file", "checkbox", "radio", "range", "color", "date", "time",
          "datetime-local", "month", "week", "hidden", "submit", "button",
          "reset", "image", "password",
        ].includes(type)
      ) {
        continue;
      }

      const parent = field.parentElement;
      if (!parent) continue;

      // Only look at the field itself: two fields can share the same parent.
      const next = field.nextElementSibling;
      if (next) {
        if (next.matches?.(`[${IMPROVE_ATTR}]`)) continue;
        if (/mejorar/i.test(next.textContent || "")) continue;
      }

      const button = make(
        "button",
        {
          type: "button",
          [IMPROVE_ATTR]: "1",
          disabled: !String(field.value || "").trim(),
          style: {
            marginTop: "6px",
            padding: "4px 8px",
            fontSize: "11px",
            lineHeight: "1.2",
            borderRadius: "7px",
            border: "1px solid rgba(255,255,255,.22)",
            background: "rgba(255,255,255,.06)",
            color: "inherit",
            cursor: "pointer",
          },
          onClick: () => improveField(button, field),
        },
        "Mejorar con IA",
      );

      field.setAttribute(FIELD_ATTR, "1");
      field.addEventListener("input", () => {
        button.disabled = !String(field.value || "").trim();
      });
      field.insertAdjacentElement("afterend", button);
    }
  }

  let resultsVisible = false;
  let resultsSignature = "";
  let resultsFetchAt = 0;

  async function checkResultsVisibility() {
    const section = resultsSection();
    const visible = !!section && section.getAttribute("aria-hidden") === "false";
    resultsVisible = visible;
    if (!visible) {
      resultsSignature = "";
      return;
    }

    // React can wipe the injected block on a re-render: it is recreated here.
    const block = ensureResultsBlock(section);
    if (!block) return;

    const now = Date.now();
    const stale = now - resultsFetchAt > 4000;
    if (!stale && block.childElementCount > 0) return;
    resultsFetchAt = now;

    let files = [];
    try {
      const data = await callJson(API_FILES);
      files = Array.isArray(data?.files) ? data.files : [];
    } catch {
      return;
    }

    const signature = files.map((f) => `${f.id}:${f.bytes}`).join(",");
    if (signature === resultsSignature && block.childElementCount > 0) return;
    resultsSignature = signature;
    renderFilesBlock(block, files);
  }

  let scheduled = false;
  function scan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      // Each step is isolated: one failing feature must not block the others.
      const safe = (fn, label) => {
        try {
          fn();
        } catch (error) {
          console.error(`[media-results] ${label} failed`, error);
        }
      };
      safe(checkResultsVisibility, "checkResultsVisibility");
      safe(addImplementButtons, "addImplementButtons");
      safe(addPromptImproveButtons, "addPromptImproveButtons");
      safe(addFieldImproveButtons, "addFieldImproveButtons");
    });
  }

  function init() {
    installSrtEditorOnce();
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // React switches tabs by changing aria-hidden/class on the existing
      // sections: without attributes the observer would never notice it.
      attributes: true,
      attributeFilter: ["aria-hidden", "class", "hidden", "style"],
    });
    document.addEventListener("input", (event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
      const next = field.nextElementSibling;
      if (next && next.matches?.(`[${IMPROVE_ATTR}]`)) {
        next.disabled = !String(field.value || "").trim();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
