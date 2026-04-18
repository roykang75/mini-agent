import { OpenAICompatClient } from "../src/lib/llm/providers/openai-compat";
import type { Message, ToolDef } from "../src/lib/llm/types";

async function main() {
  const baseURL = process.env.LLM_BASE_URL ?? "http://192.168.1.13:1234";
  const model = process.env.LLM_MODEL ?? "supergemma4-26b-abliterated-multimodal";
  const client = new OpenAICompatClient({ baseURL });

  // 1. Plain chat
  console.log("\n--- 1. plain chat ---");
  const r1 = await client.chat({
    model,
    max_tokens: 30,
    messages: [{ role: "user", content: "2+2는? 숫자 한 단어만." }],
  });
  console.log("content:", JSON.stringify(r1.content));
  console.log("stop:", r1.stop_reason, "usage:", r1.usage);

  // 2. Tool use
  console.log("\n--- 2. tool use ---");
  const weatherTool: ToolDef = {
    name: "get_weather",
    description: "Get current weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string", description: "city name" } },
      required: ["city"],
    },
  };
  const r2 = await client.chat({
    model,
    max_tokens: 200,
    tools: [weatherTool],
    messages: [{ role: "user", content: "서울 지금 날씨 알려줘" }],
  });
  console.log("content:", JSON.stringify(r2.content));
  console.log("stop:", r2.stop_reason);

  // 3. Tool result round-trip
  console.log("\n--- 3. tool result round-trip ---");
  const toolUseBlock = r2.content.find((b) => b.type === "tool_use");
  if (toolUseBlock && toolUseBlock.type === "tool_use") {
    const messages: Message[] = [
      { role: "user", content: "서울 지금 날씨 알려줘" },
      { role: "assistant", content: r2.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlock.id,
            content: "서울 5°C, 맑음, 습도 40%",
          },
        ],
      },
    ];
    const r3 = await client.chat({ model, max_tokens: 200, tools: [weatherTool], messages });
    console.log("content:", JSON.stringify(r3.content));
    console.log("stop:", r3.stop_reason);
  } else {
    console.log("(skipped: no tool_use in response)");
  }

  // 4. Streaming
  console.log("\n--- 4. streaming ---");
  let streamText = "";
  for await (const ev of client.chatStream({
    model,
    max_tokens: 80,
    messages: [{ role: "user", content: "한국어로 한 문장. '오늘 날씨는' 으로 시작." }],
  })) {
    if (ev.type === "text_delta") {
      streamText += ev.text;
      process.stdout.write(".");
    } else if (ev.type === "done") {
      console.log("\nfinal:", JSON.stringify(ev.response.content));
      console.log("stop:", ev.response.stop_reason, "usage:", ev.response.usage);
    }
  }
  console.log("streamText.length:", streamText.length);

  console.log("\n--- all smoke tests passed ---");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
