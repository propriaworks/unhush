// @vitest-environment node
//
// The IPC exchange and the probe's decisions, against a stand-in for Niri's socket: one line of
// JSON in, one line of Result-shaped JSON out (niri-ipc's socket.rs). No compositor is involved.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
// @ts-expect-error - plain CommonJS module, no type declarations
import niriWindowRule from "./niriWindowRule.cjs";
const { request, problemFor, BAR_TITLE } = niriWindowRule._internal;

type Win = { title: string; is_floating: boolean; is_focused: boolean; app_id?: string };

let dir: string;
let server: net.Server;
let windows: Win[]; // what the fake Niri reports
let requests: unknown[];
const savedSocket = process.env.NIRI_SOCKET;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "niri-test-"));
  const sock = path.join(dir, "niri.sock");
  windows = [];
  requests = [];
  server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.trim());
      requests.push(req);
      const reply = req === "Windows" ? { Ok: { Windows: windows } } : { Err: "unsupported" };
      c.end(JSON.stringify(reply) + "\n");
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  process.env.NIRI_SOCKET = sock;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedSocket === undefined) delete process.env.NIRI_SOCKET;
  else process.env.NIRI_SOCKET = savedSocket;
});

const bar = (floating: boolean, focused: boolean): Win =>
  ({ title: BAR_TITLE, is_floating: floating, is_focused: focused, app_id: "Unhush" });
const noLog = () => {};

describe("request", () => {
  it("unwraps an Ok reply", async () => {
    windows = [bar(true, false)];
    expect(await request("Windows")).toEqual({ Windows: windows });
    expect(requests).toEqual(["Windows"]);
  });

  it("rejects with Niri's message on an Err reply", async () => {
    await expect(request("Version")).rejects.toThrow("unsupported");
  });

  it("rejects when nothing is listening", async () => {
    await expect(request("Windows", path.join(dir, "missing.sock"))).rejects.toThrow();
  });
});

describe("problemFor", () => {
  it("is satisfied by a floating, unfocused bar", () => {
    expect(problemFor(bar(true, false))).toBeNull();
  });

  // The case that breaks paste, and the one the fixed-height bar still hits without the rule
  it("asks for the rule when the bar took focus, even floating", () => {
    const card = problemFor(bar(true, true));
    expect(card.code).toBe(niriWindowRule.CODE);
    expect(card.commands.join("\n")).toContain("open-focused false");
    expect(card.detail).not.toContain("column");
  });

  it("mentions tiling when the bar opened as a column", () => {
    expect(problemFor(bar(false, true)).detail).toContain("column");
  });

  it("puts the bar's own title in the rule's match", () => {
    expect(problemFor(bar(false, true)).commands.join("\n")).toContain(`title="^${BAR_TITLE}$"`);
  });
});

describe("probe", () => {
  // Stands in for main.cjs: the bar shows up in Niri's list once show() is called
  function fakeBar(state: Win) {
    const calls: string[] = [];
    let busy = false;
    return {
      calls,
      setBusy: (b: boolean) => { busy = b; },
      opts: {
        show: () => { calls.push("show"); windows = [{ title: "Other", is_floating: false, is_focused: false }, state]; },
        hide: () => { calls.push("hide"); windows = []; },
        isBusy: () => busy,
        log: noLog,
      },
    };
  }

  it("shows the bar, reads its state, and hides it again", async () => {
    const b = fakeBar(bar(true, false));
    expect(await niriWindowRule.probe(b.opts)).toBeNull();
    expect(b.calls).toEqual(["show", "hide"]);
  });

  it("returns the card when the bar opened focused", async () => {
    const b = fakeBar(bar(false, true));
    expect((await niriWindowRule.probe(b.opts)).code).toBe(niriWindowRule.CODE);
  });

  it("leaves a bar in use alone and keeps the previous answer", async () => {
    await niriWindowRule.probe(fakeBar(bar(false, true)).opts); // previous answer: a card
    const b = fakeBar(bar(true, false));
    b.setBusy(true);
    expect((await niriWindowRule.probe(b.opts)).code).toBe(niriWindowRule.CODE);
    expect(b.calls).toEqual([]);
  });

  it("doesn't hide a bar that a recording took over mid-check", async () => {
    const b = fakeBar(bar(true, false));
    const show = b.opts.show;
    b.opts.show = () => { show(); b.setBusy(true); };
    await niriWindowRule.probe(b.opts);
    expect(b.calls).toEqual(["show"]);
  });

  it("shares one check between overlapping callers", async () => {
    const b = fakeBar(bar(true, false));
    await Promise.all([niriWindowRule.probe(b.opts), niriWindowRule.probe(b.opts)]);
    expect(b.calls).toEqual(["show", "hide"]);
  });
});
