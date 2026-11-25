import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AntigravityRuntime } from "./antigravity-runtime.js";
import type { LocalCatalogStore } from "@codexly/core";

it("preserves other CLI settings and rejects stale changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-settings-"));
  try {
    const file = join(home, ".gemini", "antigravity-cli", "settings.json");
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(file, JSON.stringify({ agentMode: "auto", showTips: false }));
    const service = new AntigravityRuntime(join(home, "app"), {} as LocalCatalogStore, {
      USERPROFILE: home,
    }).service();
    const initial = await service.readAntigravityConfig!();
    expect(initial.mode).toBe("auto");
    const saved = await service.writeAntigravityConfig!({ ...initial, mode: "plan" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      agentMode: "plan",
      showTips: false,
    });
    await service.writeAntigravityConfig!({ ...saved, instructions: "Use concise Chinese." });
    expect(await readFile(join(home, ".gemini", "config", "AGENTS.md"), "utf8")).toBe(
      "Use concise Chinese.",
    );
    await expect(service.writeAntigravityConfig!({ ...saved, mode: "auto" })).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("loads and saves an existing GEMINI.md without creating AGENTS.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "agy-rules-"));
  try {
    const directory = join(home, ".gemini", "config");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "GEMINI.md");
    await writeFile(file, "# Existing rules\n");
    const service = new AntigravityRuntime(join(home, "app"), {} as LocalCatalogStore, {
      USERPROFILE: home,
    }).service();
    const initial = await service.readAntigravityConfig!();
    expect(initial.instructions).toBe("# Existing rules\n");
    expect(initial.instructionsPath).toBe(file);
    await service.writeAntigravityConfig!({ ...initial, instructions: "# Updated rules\n" });
    expect(await readFile(file, "utf8")).toBe("# Updated rules\n");
    await expect(readFile(join(directory, "AGENTS.md"))).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
