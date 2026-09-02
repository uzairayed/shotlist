import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT, type ProjectJson } from "./types.js";

export function getShotlistDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SHOTLIST_DIR;
  if (raw && raw.trim().length > 0) return path.resolve(raw);
  return path.join(os.homedir(), ".shotlist", "project");
}

export function ensureProject(dir?: string): {
  dir: string;
  project: ProjectJson;
  created: boolean;
} {
  const root = dir ?? getShotlistDir();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "takes"), { recursive: true });
  fs.mkdirSync(path.join(root, "out"), { recursive: true });

  const projectPath = path.join(root, "project.json");
  let created = false;
  let project: ProjectJson;

  if (!fs.existsSync(projectPath)) {
    project = structuredClone(DEFAULT_PROJECT);
    fs.writeFileSync(projectPath, JSON.stringify(project, null, 2) + "\n");
    created = true;
  } else {
    project = JSON.parse(fs.readFileSync(projectPath, "utf8")) as ProjectJson;
  }

  return { dir: root, project, created };
}

export function readProject(dir?: string): ProjectJson {
  const { project } = ensureProject(dir);
  return project;
}

export function projectPath(dir?: string): string {
  return path.join(dir ?? getShotlistDir(), "project.json");
}

export function takesDir(dir?: string): string {
  return path.join(dir ?? getShotlistDir(), "takes");
}

export function outDir(dir?: string): string {
  return path.join(dir ?? getShotlistDir(), "out");
}

export function nextOutId(dir: string, prefix: string, ext: string): number {
  const out = outDir(dir);
  fs.mkdirSync(out, { recursive: true });
  const files = fs.readdirSync(out);
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)\\.${ext}$`);
  for (const f of files) {
    const m = f.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function nextOutPath(dir: string, prefix: string, ext: string): string {
  const id = nextOutId(dir, prefix, ext);
  return path.join(outDir(dir), `${prefix}-${id}.${ext}`);
}
