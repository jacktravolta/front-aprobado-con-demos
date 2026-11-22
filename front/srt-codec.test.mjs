import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MetaSrt = require("./srt-codec.js");

test("parses a real SRT with three cues", () => {
  const cues = MetaSrt.parseCues(`1
00:00:01,000 --> 00:00:04,000
Primera línea

2
00:00:05,500 --> 00:00:08,250
Segunda línea

3
00:00:09,000 --> 00:00:12,000
Tercera línea`);

  assert.equal(cues.length, 3);
  assert.deepEqual(cues[0], {
    index: 1,
    start: "00:00:01.000",
    end: "00:00:04.000",
    text: "Primera línea",
  });
  assert.equal(cues[1].start, "00:00:05.500");
  assert.equal(cues[1].end, "00:00:08.250");
  assert.equal(cues[2].text, "Tercera línea");
});

test("parses a VTT header and dot decimals", () => {
  const cues = MetaSrt.parseCues(`WEBVTT

00:00:01.000 --> 00:00:04.000
Hello`);

  assert.deepEqual(cues, [
    { index: 1, start: "00:00:01.000", end: "00:00:04.000", text: "Hello" },
  ]);
});

test("tolerates a BOM and CRLF line endings", () => {
  const cues = MetaSrt.parseCues(
    "\uFEFF1\r\n00:00:01,000 --> 00:00:04,000\r\nCRLF cue\r\n",
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "CRLF cue");
});

test("preserves multi-line cue text", () => {
  const cues = MetaSrt.parseCues(`1
00:00:01,000 --> 00:00:04,000
First line
Second line`);

  assert.equal(cues[0].text, "First line\nSecond line");
});

test("ignores NOTE blocks and cue settings", () => {
  const cues = MetaSrt.parseCues(`WEBVTT

NOTE This is a comment
with two lines

1
00:00:01.000 --> 00:00:04.000 align:start position:10%
Visible cue`);

  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Visible cue");
});

test("rejects a plain script", () => {
  const script = "Narrator: this is a scene.\nThe character walks into the room.";
  assert.deepEqual(MetaSrt.parseCues(script), []);
  assert.equal(MetaSrt.isSubtitleText(script), false);
});

test("serializes SRT and VTT", () => {
  const cues = MetaSrt.parseCues(`1
00:00:01,000 --> 00:00:04,000
Hello`);

  assert.equal(
    MetaSrt.toSrt(cues),
    "1\n00:00:01,000 --> 00:00:04,000\nHello\n",
  );
  assert.equal(
    MetaSrt.toVtt(cues),
    "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello\n",
  );
});

test("round trips parsed cues through SRT", () => {
  const source = `1
00:00:01,000 --> 00:00:04,000
One

2
00:00:05,500 --> 00:00:08,250
Two lines
continued`;
  const cues = MetaSrt.parseCues(source);
  assert.deepEqual(MetaSrt.parseCues(MetaSrt.toSrt(cues)), cues);
});

test("normalizes app rows without milliseconds", () => {
  assert.deepEqual(
    MetaSrt.cuesFromRows([
      { inicio: "00:00:00", fin: "00:00:04", texto: "Hello" },
    ]),
    [
      {
        index: 1,
        start: "00:00:00.000",
        end: "00:00:04.000",
        text: "Hello",
      },
    ],
  );
});
