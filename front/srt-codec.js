(() => {
  "use strict";

  const TIMESTAMP_PATTERN = /^(\d+):([0-5]\d):([0-5]\d)(?:[.,](\d{1,3}))?$/;

  function parseTimestamp(value) {
    if (typeof value !== "string") return null;
    const match = TIMESTAMP_PATTERN.exec(value.trim());
    if (!match) return null;
    const milliseconds = (match[4] || "").padEnd(3, "0").slice(0, 3);
    const hours = String(Number(match[1])).padStart(2, "0");
    return `${hours}:${match[2]}:${match[3]}.${milliseconds || "000"}`;
  }

  function parseTimestampLine(line) {
    const match = /^\s*(\S+)\s*-->\s*(\S+)/.exec(line);
    if (!match) return null;
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    return start && end ? { start, end } : null;
  }

  function parseCues(text) {
    try {
      if (typeof text !== "string" || !text.trim()) return [];
      const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
      const cues = [];
      let current = null;
      let pendingIndex = null;
      let skippingNote = false;

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (skippingNote) {
          if (!line) skippingNote = false;
          continue;
        }
        if (!line) {
          if (current) cues.push(current);
          current = null;
          pendingIndex = null;
          continue;
        }
        if (!current && /^NOTE(?:\s|$)/i.test(line)) {
          skippingNote = true;
          pendingIndex = null;
          continue;
        }
        if (!current && /^WEBVTT(?:\s|$)/i.test(line)) {
          pendingIndex = null;
          continue;
        }

        const timing = parseTimestampLine(line);
        if (timing) {
          if (current) cues.push(current);
          current = {
            index: pendingIndex || cues.length + 1,
            start: timing.start,
            end: timing.end,
            text: "",
          };
          pendingIndex = null;
          continue;
        }

        if (!current) {
          if (/^\d+$/.test(line)) pendingIndex = Number(line);
          continue;
        }
        current.text += current.text ? `\n${rawLine}` : rawLine;
      }
      if (current) cues.push(current);
      return cues.map((cue) => ({ ...cue, text: cue.text.trim() }));
    } catch {
      return [];
    }
  }

  function isSubtitleText(text) {
    return parseCues(text).length > 0;
  }

  function serialize(cues, vtt) {
    const blocks = [];
    for (const cue of Array.isArray(cues) ? cues : []) {
      const start = parseTimestamp(cue?.start);
      const end = parseTimestamp(cue?.end);
      if (!start || !end) continue;
      const timing = `${start} --> ${end}`;
      const text = String(cue?.text ?? "");
      blocks.push(
        vtt
          ? `${timing}\n${text}`
          : `${blocks.length + 1}\n${timing.replace(/\./g, ",")}\n${text}`,
      );
    }
    if (vtt) return `WEBVTT\n\n${blocks.join("\n\n")}${blocks.length ? "\n" : ""}`;
    return blocks.length ? `${blocks.join("\n\n")}\n` : "";
  }

  function toSrt(cues) {
    return serialize(cues, false);
  }

  function toVtt(cues) {
    return serialize(cues, true);
  }

  function cuesFromRows(rows) {
    const cues = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const start = parseTimestamp(row?.inicio);
      const end = parseTimestamp(row?.fin);
      if (!start || !end) continue;
      cues.push({
        index: cues.length + 1,
        start,
        end,
        text: String(row?.texto ?? ""),
      });
    }
    return cues;
  }

  const api = {
    parseCues,
    isSubtitleText,
    parseTimestamp,
    toSrt,
    toVtt,
    cuesFromRows,
  };

  globalThis.MetaSrt = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
