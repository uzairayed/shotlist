import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT,
  type ProjectJson,
} from "../src/types.js";
import {
  ensureProject,
  getShotlistDir,
  nextOutPath,
} from "../src/project.js";
import { makeTempProject, rmTempProject, readJson } from "./helpers.js";

describe("project bootstrap", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempProject();
  });

  afterEach(() => {
    rmTempProject(dir);
    delete process.env.SHOTLIST_DIR;
  });

  it("reads SHOTLIST_DIR from env", () => {
    expect(getShotlistDir()).toBe(dir);
  });

  it("writes project.json with exact §4 defaults on first call", () => {
    const result = ensureProject(dir);
    expect(result.created).toBe(true);
    expect(result.dir).toBe(dir);

    const projectPath = path.join(dir, "project.json");
    expect(fs.existsSync(projectPath)).toBe(true);
    const project = readJson<ProjectJson>(projectPath);
    expect(project).toEqual(DEFAULT_PROJECT);
  });

  it("creates takes/ and out/ directories", () => {
    ensureProject(dir);
    expect(fs.existsSync(path.join(dir, "takes"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(true);
  });

  it("does not overwrite an existing project.json", () => {
    ensureProject(dir);
    const projectPath = path.join(dir, "project.json");
    const modified = { ...DEFAULT_PROJECT, id: "custom" };
    fs.writeFileSync(projectPath, JSON.stringify(modified));
    const second = ensureProject(dir);
    expect(second.created).toBe(false);
    expect(readJson<ProjectJson>(projectPath).id).toBe("custom");
  });

  it("allocates next out file ids", () => {
    ensureProject(dir);
    const p1 = nextOutPath(dir, "preview", "png");
    expect(p1).toBe(path.join(dir, "out", "preview-1.png"));
    fs.writeFileSync(p1, "x");
    const p2 = nextOutPath(dir, "preview", "png");
    expect(p2).toBe(path.join(dir, "out", "preview-2.png"));
  });
});
