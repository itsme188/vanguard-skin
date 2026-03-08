import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { CHAT_TOOLS, executeTool } from "@/lib/chat/tools";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

const MAX_TOOL_ITERATIONS = 8;

export async function POST(request: NextRequest) {
  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: "Messages array is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "ANTHROPIC_API_KEY not configured. Add it to .env.local to enable chat.",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Build rich portfolio context and system prompt
    const portfolioContext = getPortfolioSummaryForChat(db);
    const currentDate = new Date().toISOString().slice(0, 10);
    const systemPrompt = buildSystemPrompt(portfolioContext, currentDate);

    const client = new Anthropic({ apiKey });

    // Prepare conversation messages (user messages from client)
    const conversationMessages: Anthropic.MessageParam[] = messages.map(
      (m: { role: string; content: string }) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })
    );

    // Stream the response with agentic tool-use loop
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          let iteration = 0;

          while (iteration < MAX_TOOL_ITERATIONS) {
            iteration++;

            const stream = client.messages.stream({
              model: "claude-sonnet-4-20250514",
              max_tokens: 4096,
              temperature: 0.3,
              system: systemPrompt,
              tools: CHAT_TOOLS,
              messages: conversationMessages,
            });

            // Stream text deltas to client in real-time
            for await (const event of stream) {
              if (
                event.type === "content_block_start" &&
                event.content_block.type === "tool_use"
              ) {
                // Signal to client that a tool is being called
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      status: "analyzing",
                      tool: event.content_block.name,
                    })}\n\n`
                  )
                );
              }

              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ text: event.delta.text })}\n\n`
                  )
                );
              }
            }

            // Get the final message to check stop reason and extract tool calls
            const finalMessage = await stream.finalMessage();

            if (finalMessage.stop_reason !== "tool_use") {
              // Done — no more tools to call
              break;
            }

            // Extract tool_use blocks and execute them server-side
            const toolUseBlocks = finalMessage.content.filter(
              (block): block is Anthropic.ToolUseBlock =>
                block.type === "tool_use"
            );

            if (toolUseBlocks.length === 0) {
              break;
            }

            // Append the assistant's full response (including tool_use blocks)
            conversationMessages.push({
              role: "assistant",
              content: finalMessage.content,
            });

            // Execute each tool and build tool_result messages
            const toolResults: Anthropic.ToolResultBlockParam[] =
              toolUseBlocks.map((toolBlock) => {
                const result = executeTool(
                  db,
                  toolBlock.name,
                  toolBlock.input as Record<string, unknown>
                );
                return {
                  type: "tool_result" as const,
                  tool_use_id: toolBlock.id,
                  content: JSON.stringify(result),
                };
              });

            // Append the tool results as a user message
            conversationMessages.push({
              role: "user",
              content: toolResults,
            });
          }

          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          const msg =
            error instanceof Error ? error.message : "Stream error";
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: msg })}\n\n`
            )
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
