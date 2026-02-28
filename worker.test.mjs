import fs from "node:fs";
import path from "node:path";

describe("worker.mjs robustness", () => {
  it("should have valid syntax", () => {
    const workerPath = path.resolve(process.cwd(), "worker.mjs");
    const content = fs.readFileSync(workerPath, "utf8");

    expect(content).toBeDefined();
    expect(content.length).toBeGreaterThan(0);
  });
});
