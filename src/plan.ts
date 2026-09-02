import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "./errors.js";
import { ensureProject, getShotlistDir } from "./project.js";
import { toolErrorResult } from "./mcp-result.js";
import type { PlanBeat, PlanJson } from "./types.js";

export function planPath(dir?: string): string {
  return path.join(dir ?? getShotlistDir(), "plan.json");
}

export function hasPlan(dir?: string): boolean {
  return fs.existsSync(planPath(dir));
}

export function readPlan(dir?: string): PlanJson | null {
  const p = planPath(dir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8")) as PlanJson;
}

function assignBeatIds(beats: PlanBeat[]): PlanBeat[] {
  let next = 1;
  const used = new Set<string>();
  return beats.map((b) => {
    let id = b.id?.trim() || "";
    if (!id) {
      while (used.has(`b${next}`)) next += 1;
      id = `b${next}`;
      next += 1;
    }
    used.add(id);
    return { ...b, id };
  });
}

export function setPlan(
  plan: PlanJson,
  dir?: string,
): { ok: true; beat_count: number; warnings: string[] } {
  ensureProject(dir);
  const warnings: string[] = [];

  if (plan.version !== 1) {
    throw new ToolError("BAD_INPUT", "plan.version must be 1", {
      version: plan.version,
    });
  }
  if (!plan.product || String(plan.product).trim() === "") {
    throw new ToolError("BAD_INPUT", "plan.product is required");
  }
  if (!plan.url || String(plan.url).trim() === "") {
    throw new ToolError("BAD_INPUT", "plan.url is required");
  }
  if (!Array.isArray(plan.beats) || plan.beats.length === 0) {
    throw new ToolError("BAD_INPUT", "plan.beats must be a non-empty array");
  }

  for (const beat of plan.beats) {
    if (!beat.name || String(beat.name).trim() === "") {
      throw new ToolError("BAD_INPUT", "each beat requires name");
    }
    if (!beat.why || String(beat.why).trim() === "") {
      throw new ToolError("BAD_INPUT", "each beat requires why");
    }
    if (!beat.camera || String(beat.camera).trim() === "") {
      throw new ToolError("BAD_INPUT", "each beat requires camera");
    }
  }

  const beats = assignBeatIds(plan.beats);
  const out: PlanJson = { ...plan, version: 1, beats };
  fs.writeFileSync(planPath(dir), JSON.stringify(out, null, 2) + "\n");
  return { ok: true, beat_count: beats.length, warnings };
}

export function getPlan(dir?: string): { ok: true; plan: PlanJson } {
  ensureProject(dir);
  const plan = readPlan(dir);
  if (!plan) throw new ToolError("NO_PLAN", "plan.json is missing");
  return { ok: true, plan };
}

export const TAGISER_PLAN: PlanJson = {
  version: 1,
  product: "tagiser",
  url: "https://www.tagiser.com",
  audience: "parents who would order name labels tonight",
  language: "nb",
  target_seconds: 25,
  story:
    "pick what the kid loves → generated unique labels → customize, stop before payment",
  pages: [
    {
      url: "https://www.tagiser.com",
      promise: "Personal name labels inspired by the child's interests",
      cta: "Lag navnelapper",
      notes: "",
    },
  ],
  magic: "generated unique designs after picking a category",
  skip: ["FAQ", "legal", "payment", "cookie banner"],
  beats: [
    {
      id: "b1",
      name: "land",
      url: "https://www.tagiser.com",
      action: "hold on homepage",
      why: "promise in one glance",
      hold: "headline + Lag navnelapper",
      camera: "wide then push to CTA",
      skip_if: null,
    },
    {
      id: "b2",
      name: "start",
      url: "https://www.tagiser.com/generation?fromLanding=true",
      action: "Click Lag navnelapper",
      why: "Enter the product",
      hold: "First create-step chrome",
      camera: "follow cursor, land on the next screen",
    },
    {
      id: "b3",
      name: "category",
      action: "Pick one kid-interest category",
      why: "Personal, not generic",
      hold: "Tile art + label",
      camera: "push-in on the chosen tile",
    },
    {
      id: "b4",
      name: "generate",
      action: "Wait for unique design proposals",
      why: "Magic moment — this is the demo",
      hold: "Generated art must be readable",
      camera: "wide then push to chosen design",
    },
    {
      id: "b5",
      name: "customize",
      action: "Change one thing (background or name)",
      why: "It's theirs",
      hold: "Before/after of the label",
      camera: "pan to control, then to live preview",
    },
    {
      id: "b6",
      name: "result",
      action: "Cart or preview with price, stop before payment",
      why: "Close on I could order this",
      hold: "Name, design, price",
      camera: "hold on label + total",
    },
  ],
};

export function registerPlanTools(server: McpServer): void {
  server.tool(
    "set_plan",
    "Write plan.json with product story and beats; returns beat_count and warnings.",
    {
      plan: z.record(z.unknown()).describe("Plan object (version 1)"),
    },
    async ({ plan }) => {
      try {
        const result = setPlan(plan as unknown as PlanJson);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );

  server.tool(
    "get_plan",
    "Return the current plan.json, or NO_PLAN if missing.",
    {},
    async () => {
      try {
        const result = getPlan();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (err) {
        return toolErrorResult(err);
      }
    },
  );
}
