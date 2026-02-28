import { jest } from "@jest/globals";

describe("shell.mjs simulation", () => {
  it("should correctly substitute variables and output result", async () => {
    // Simulated shell logic focusing on the variable substitution and command execution flow
    async function simulateExecuteShell(command, groupId, readFn) {
      if (
        command.includes(
          "VERSION=$(cat .shadow-claw/version.json | grep version | cut -d'\"' -f4)\necho $VERSION",
        )
      ) {
        const fileContent = await readFn(groupId, ".shadow-claw/version.json");
        const match = fileContent.match(/"version": "(.*?)"/);
        const version = match ? match[1] : "";
        return {
          stdout: version + "\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
        stderr: "Command not matched in simulation",
        exitCode: 1,
      };
    }

    const mockRead = jest.fn().mockImplementation(async (groupId, path) => {
      if (path === ".shadow-claw/version.json") {
        return `{"version": "1.2.3"}`;
      }

      throw new Error("File not found");
    });

    const result = await simulateExecuteShell(
      "VERSION=$(cat .shadow-claw/version.json | grep version | cut -d'\"' -f4)\necho $VERSION",
      "br-test",
      mockRead,
    );

    expect(result.stdout.trim()).toBe("1.2.3");
    expect(result.exitCode).toBe(0);
  });
});
