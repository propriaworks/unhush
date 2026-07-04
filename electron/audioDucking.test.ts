// @vitest-environment node
//
// Targets the parsing and math that's easy to get subtly wrong: pactl's JSON and legacy
// text output formats (captured from a real pactl 16.1 / PipeWire 1.0.5 session — see
// audioDucking.cjs's isOwnStream comment for how that was verified), the ramp's step math,
// and own-stream exclusion via PID ancestry.

import { describe, it, expect, vi } from "vitest";
// @ts-expect-error - plain CommonJS module, no type declarations
import { _internal } from "./audioDucking.cjs";
const {
  parseJsonSinkInputs,
  parseTextSinkInputs,
  computeRampSteps,
  scaledChannelVolumes,
  isOwnStream,
} = _internal;

describe("parseJsonSinkInputs", () => {
  it("parses a mono stream (real pactl -f json output)", () => {
    const stdout = JSON.stringify([
      {
        index: 1499,
        volume: { mono: { value: 65536, value_percent: "100%", db: "0.00 dB" } },
        properties: {
          "application.name": "speech-dispatcher-dummy",
          "application.process.id": "71272",
        },
      },
    ]);
    const streams = parseJsonSinkInputs(stdout);
    expect(streams).toEqual([
      {
        id: "1499",
        channels: [65536],
        props: { "application.name": "speech-dispatcher-dummy", "application.process.id": "71272" },
      },
    ]);
  });

  it("parses a stereo stream, preserving per-channel order", () => {
    const stdout = JSON.stringify([
      {
        index: 4736,
        volume: {
          "front-left": { value: 65536, value_percent: "100%", db: "0.00 dB" },
          "front-right": { value: 32768, value_percent: "50%", db: "-6.02 dB" },
        },
        properties: { "application.name": "unhush", "application.process.id": "250797" },
      },
    ]);
    const streams = parseJsonSinkInputs(stdout);
    expect(streams[0].channels).toEqual([65536, 32768]);
  });
});

describe("parseTextSinkInputs", () => {
  it("parses a real mono pactl-16 text block", () => {
    const stdout = `Sink Input #1499
	Driver: PipeWire
	Owner Module: n/a
	Client: 1498
	Sink: 55
	Sample Specification: s16le 1ch 44100Hz
	Channel Map: mono
	Corked: yes
	Mute: no
	Volume: mono: 65536 / 100% / 0.00 dB
	        balance 0.00
	Buffer Latency: 0 usec
	Sink Latency: 0 usec
	Resample method: PipeWire
	Properties:
		application.name = "speech-dispatcher-dummy"
		application.process.id = "71272"
`;
    const streams = parseTextSinkInputs(stdout);
    expect(streams).toEqual([
      {
        id: "1499",
        channels: [65536],
        props: { "application.name": "speech-dispatcher-dummy", "application.process.id": "71272" },
      },
    ]);
  });

  it("parses a comma-separated multi-channel Volume line", () => {
    const stdout = `Sink Input #4736
	Driver: PipeWire
	Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 32768 /  50% /  -6.02 dB
	        balance 0.00
	Properties:
		application.name = "unhush"
		application.process.id = "250797"
`;
    const streams = parseTextSinkInputs(stdout);
    expect(streams[0].channels).toEqual([65536, 32768]);
  });

  it("parses multiple blocks", () => {
    const stdout = `Sink Input #1
	Volume: mono: 65536 / 100% / 0.00 dB
	Properties:
		application.name = "a"

Sink Input #2
	Volume: mono: 32768 / 50% / -6.02 dB
	Properties:
		application.name = "b"
`;
    const streams = parseTextSinkInputs(stdout);
    expect(streams.map((s) => s.id)).toEqual(["1", "2"]);
    expect(streams[1].channels).toEqual([32768]);
  });
});

describe("computeRampSteps", () => {
  it("is monotonic when ducking down", () => {
    const steps = computeRampSteps(1.0, 0.2, 6);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
  });

  it("is monotonic when restoring up", () => {
    const steps = computeRampSteps(0.2, 1.0, 6);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });

  it("the last step lands exactly on the target", () => {
    expect(computeRampSteps(1.0, 0.2, 6).at(-1)).toBeCloseTo(0.2);
    expect(computeRampSteps(0.37, 1.0, 6).at(-1)).toBeCloseTo(1.0);
  });

  it("mute (target 0) reaches exactly zero", () => {
    expect(computeRampSteps(1.0, 0, 6).at(-1)).toBe(0);
  });

  it("resuming a ramp from a partial factor doesn't overshoot", () => {
    const steps = computeRampSteps(0.6, 0.2, 6);
    expect(Math.max(...steps)).toBeLessThanOrEqual(0.6);
    expect(steps.at(-1)).toBeCloseTo(0.2);
  });
});

describe("scaledChannelVolumes", () => {
  it("scales each channel independently, rounding to an integer", () => {
    expect(scaledChannelVolumes([65536, 32768], 0.5)).toEqual([32768, 16384]);
    expect(scaledChannelVolumes([65536], 0)).toEqual([0]);
    expect(scaledChannelVolumes([65536], 1)).toEqual([65536]);
  });
});

describe("isOwnStream", () => {
  const OWN_PID = 100;

  it("matches when the stream's PID is the app's own PID", () => {
    const readParent = vi.fn(() => null);
    expect(isOwnStream({ "application.process.id": "100" }, OWN_PID, "unhush", readParent)).toBe(true);
  });

  it("matches a grandchild process (Chromium's AudioService utility process)", () => {
    // 300 (AudioService) -> 200 -> 100 (our main process), as verified live against a
    // running instance: the AudioService PID's parent is the Electron main process.
    const parents = { 300: 200, 200: 100 };
    const readParent = vi.fn((pid) => parents[pid] ?? null);
    expect(isOwnStream({ "application.process.id": "300" }, OWN_PID, "unhush", readParent)).toBe(true);
    expect(readParent).toHaveBeenCalled();
  });

  it("does not match an unrelated process, even by name coincidence in properties", () => {
    const readParent = vi.fn(() => null); // pid 999's parent is unknown/unrelated
    expect(isOwnStream({ "application.process.id": "999", "application.name": "other-app" }, OWN_PID, "unhush", readParent)).toBe(false);
  });

  it("falls back to matching application.name when PID ancestry doesn't resolve", () => {
    const readParent = vi.fn(() => null);
    expect(isOwnStream({ "application.process.id": "999", "application.name": "Unhush" }, OWN_PID, "unhush", readParent)).toBe(true);
  });

  it("does not match when properties are missing entirely", () => {
    const readParent = vi.fn(() => null);
    expect(isOwnStream({}, OWN_PID, "unhush", readParent)).toBe(false);
  });

  it("stops walking after the max hop limit rather than looping forever", () => {
    // A chain that never reaches OWN_PID within 10 hops must resolve to false, not hang.
    const parents = {};
    for (let i = 0; i < 20; i++) parents[900 + i] = 900 + i + 1;
    const readParent = vi.fn((pid) => parents[pid] ?? null);
    expect(isOwnStream({ "application.process.id": "900" }, OWN_PID, "unhush", readParent)).toBe(false);
  });
});
