import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The tabs mod and the agents mod each carry a copy of the title cleaner (mods cannot import each
// other). Pull both out of their sources and keep them in agreement.
const root = new URL("../defaults/mods/", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");
const lines = (source: string, names: string[]) => names.map(name => {
  const line = source.split("\n").find(l => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`const ${name} not found`);
  return line;
}).join("\n");
const tabsClean: (s: string) => string = new Function(`${lines(await read("tabs/main.js"), ["glyphs", "clean"])}; return clean;`)();
const agentsClean: (s: string) => string = new Function(`${lines(await read("agents/main.js"), ["clean"])}; return clean;`)();

// [title, expected from both when they agree]; path starts differ on purpose: the tabs mod
// keeps them so its path filter can drop the whole title, the agents mod strips the glyph-like start.
const shared: [string, string][] = [
  ["✦ Working", "Working"],
  ["[ ! ] x", "x"],
  ["[ . ] x", "x"],
  ["● [ ! ] x", "x"],
  ["🔴 login", "🔴 login"],
  ["[web] login", "[web] login"],
  ["plain", "plain"],
];
const paths: [string, string, string][] = [
  ["~/code", "~/code", "code"],
  ["./build", "./build", "build"],
];

test("tabs and agents clean titles the same way", () => {
  for (const [title, want] of shared) {
    expect([title, tabsClean(title)]).toEqual([title, want]);
    expect([title, agentsClean(title)]).toEqual([title, want]);
  }
});

test("tabs keeps path starts that agents strips (documented difference)", () => {
  for (const [title, tabs, agents] of paths) {
    expect([title, tabsClean(title)]).toEqual([title, tabs]);
    expect([title, agentsClean(title)]).toEqual([title, agents]);
  }
});
