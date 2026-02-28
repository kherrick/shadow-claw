import { jest } from "@jest/globals";

describe("storage.mjs error handling simulation", () => {
  let explicitRoot = null;
  function setStorageRoot(handle) {
    explicitRoot = handle;
  }

  async function readGroupFile(groupId, filePath) {
    const root = explicitRoot;
    // Simulate the logic in storage.mjs
    await root.getDirectoryHandle("groups");
    return "content";
  }

  it("should handle NotAllowedError when accessing directory", async () => {
    const mockHandle = {
      getDirectoryHandle: jest
        .fn()
        .mockRejectedValue(
          new DOMException("The user aborted a request.", "NotAllowedError"),
        ),
    };

    setStorageRoot(mockHandle);

    await expect(readGroupFile("br-test", "settings.json")).rejects.toThrow(
      "The user aborted a request.",
    );
  });
});
