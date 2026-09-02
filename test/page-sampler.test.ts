import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJsonl,
  cssPixelsToSource,
  preferredSelector,
  shouldSampleBoxes,
  sourcePoint,
} from "../src/page-sampler.js";

describe("page-sampler", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("cssPixelsToSource multiplies all four fields by dpr", () => {
    const rect = { x: 10, y: 20, w: 100, h: 50 };
    expect(cssPixelsToSource(rect, 2)).toEqual({ x: 20, y: 40, w: 200, h: 100 });
  });

  it("sourcePoint multiplies x and y by dpr", () => {
    expect(sourcePoint(10, 20, 2)).toEqual({ x: 20, y: 40 });
  });

  it("shouldSampleBoxes is true for click and nav even when last sample was 0ms ago", () => {
    expect(shouldSampleBoxes(1.0, 1.0, "click")).toBe(true);
    expect(shouldSampleBoxes(1.0, 1.0, "nav")).toBe(true);
  });

  it("shouldSampleBoxes is false for interval when delta is 499ms, true at 500ms, true when lastSampleT is null", () => {
    expect(shouldSampleBoxes(1.0, 1.499, "interval")).toBe(false);
    expect(shouldSampleBoxes(1.0, 1.5, "interval")).toBe(true);
    expect(shouldSampleBoxes(null, 1.0, "interval")).toBe(true);
  });

  it("preferredSelector prefers data-shotlist over id, id over nth-of-type, and joins parent with >", () => {
    expect(
      preferredSelector({
        dataShotlist: "hero",
        id: "main",
        tag: "div",
        nthOfType: 1,
      }),
    ).toBe('[data-shotlist="hero"]');
    expect(
      preferredSelector({
        id: "email",
        tag: "input",
        nthOfType: 2,
      }),
    ).toBe("#email");
    expect(
      preferredSelector({
        tag: "button",
        nthOfType: 3,
        parentSelector: "#form",
      }),
    ).toBe("#form > button:nth-of-type(3)");
    expect(
      preferredSelector({
        tag: "span",
        nthOfType: 1,
      }),
    ).toBe("span:nth-of-type(1)");
  });

  it("appendJsonl writes two JSON objects as two newline-terminated lines", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shotlist-sampler-"));
    const filePath = path.join(tempDir, "boxes.jsonl");
    appendJsonl(filePath, { t: 1.0, elements: [] });
    appendJsonl(filePath, { t: 2.0, elements: [{ selector: "#a" }] });
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ t: 1.0, elements: [] });
    expect(JSON.parse(lines[1]!)).toEqual({
      t: 2.0,
      elements: [{ selector: "#a" }],
    });
    expect(content.endsWith("\n")).toBe(true);
  });
});
