import { ToolError } from "./errors.js";

export class BusyGate {
  private recording = false;
  private rendering = false;

  beginRecord(): void {
    if (this.recording) {
      throw new ToolError("BUSY", "a recording is already in progress");
    }
    this.recording = true;
  }

  endRecord(): void {
    this.recording = false;
  }

  isRecording(): boolean {
    return this.recording;
  }

  beginRender(): void {
    if (this.rendering) {
      throw new ToolError("BUSY", "a render is already in progress");
    }
    this.rendering = true;
  }

  endRender(): void {
    this.rendering = false;
  }

  isRendering(): boolean {
    return this.rendering;
  }
}

export const busy = new BusyGate();
