import { formatRequest } from "./providers.mjs";

describe("providers.mjs formatting", () => {
  const mockProvider = {
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  };

  const mockMessages = [
    { role: "user", content: "You: I'm curious" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll show you what files are in our workspace" },
        {
          type: "tool_use",
          id: "tool_123",
          name: "list_files",
          input: { path: "." },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_123",
          content: "file1.txt\nfile2.txt",
        },
      ],
    },
  ];

  const options = {
    model: "anthropic/claude-3.5-sonnet",
    maxTokens: 8096,
    system: "You are rover, a personal AI assistant.",
  };

  const tools = [
    {
      name: "list_files",
      description: "List files",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  ];

  it("should correctly format an OpenAI-style request", () => {
    const result = formatRequest(mockProvider, mockMessages, tools, options);

    expect(result.messages).toBeDefined();
    const systemMsg = result.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toBe(options.system);

    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg.tool_calls).toBeDefined();
    expect(assistantMsg.tool_calls[0].function.name).toBe("list_files");

    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("tool_123");
  });
});
