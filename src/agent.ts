import type { Message } from "ollama";
import chalk from "chalk";
import { OllamaService } from "./ollama";
import { executeTool } from "./tools";
import { printMarkdown, printToolCall, printToolResult, createSpinner, printError } from "./ui";

export const DEFAULT_SYSTEM_PROMPT = `You are an expert AI coding assistant running locally on the user's machine.
You have access to tools to interact with the file system and run shell commands.
Use these tools to help the user with their coding tasks.
When writing code, always ensure you provide clean, well-documented, and working code.
Think step-by-step and use tools when necessary.

When you use write_file, it will create or overwrite the file.
Always read existing files first before overwriting if you need to modify them.`;

export class Agent {
  private ollama: OllamaService;
  private model: string;
  private messages: Message[] = [];
  private mode: "code" | "chat" = "code";
  private systemPrompt: string;
  private maxToolSteps: number = 10;

  constructor(model: string, ollamaUrl?: string, systemPrompt?: string) {
    this.model = model;
    this.ollama = new OllamaService(ollamaUrl);
    this.systemPrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    this.resetHistory();
  }

  public setModel(model: string) {
    this.model = model;
  }

  public getModel(): string {
    return this.model;
  }

  public setMode(mode: "code" | "chat") {
    this.mode = mode;
  }

  public getMode(): "code" | "chat" {
    return this.mode;
  }

  public setSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
    if (this.messages.length > 0 && this.messages[0].role === "system") {
      this.messages[0].content = prompt;
    }
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public resetHistory() {
    this.messages = [
      {
        role: "system",
        content: this.systemPrompt,
      },
    ];
  }

  public getHistory(): Message[] {
    return this.messages;
  }

  public async runUserPrompt(userPrompt: string): Promise<void> {
    this.messages.push({
      role: "user",
      content: userPrompt,
    });

    const isCodeMode = this.mode === "code";
    let currentStep = 0;

    while (currentStep < this.maxToolSteps) {
      currentStep++;

      const spinner = createSpinner(
        currentStep === 1
          ? isCodeMode
            ? "Agent thinking & selecting tools..."
            : "Generating chat response..."
          : `Agent executing step ${currentStep}...`
      );

      let chunkStreamed = false;
      let thinkingStreamed = false;

      try {
        spinner.start();

        const { responseMessage, toolCalls } = await this.ollama.chatStream(
          this.model,
          this.messages,
          isCodeMode,
          (chunk) => {
            if (spinner.isSpinning) {
              spinner.stop();
            }
            chunkStreamed = true;
            process.stdout.write(chunk);
          },
          (thinkingChunk) => {
            if (spinner.isSpinning) {
              spinner.stop();
            }
            if (!thinkingStreamed) {
              thinkingStreamed = true;
              process.stdout.write(chalk.gray("\n💭 Thinking: "));
            }
            process.stdout.write(chalk.gray(thinkingChunk));
          }
        );

        if (spinner.isSpinning) {
          spinner.stop();
        }

        if (thinkingStreamed) {
          process.stdout.write("\n\n");
        }

        if (chunkStreamed) {
          process.stdout.write("\n\n");
        }

        // Add assistant message to history
        this.messages.push(responseMessage);

        // If no tool calls, response is complete!
        if (!toolCalls || toolCalls.length === 0) {
          if (!chunkStreamed && responseMessage.content) {
            printMarkdown(responseMessage.content);
            console.log();
          }
          break;
        }

        // Handle Tool Calls
        for (const call of toolCalls) {
          printToolCall(call.name, call.args);

          const toolSpinner = createSpinner(`Executing ${call.name}...`);
          toolSpinner.start();
          const result = await executeTool(call.name, call.args);
          toolSpinner.stop();

          printToolResult(result);

          // Append tool result to history
          this.messages.push({
            role: "tool",
            content: result,
          });
        }
      } catch (err: any) {
        if (spinner.isSpinning) {
          spinner.stop();
        }
        printError(err.message || String(err));
        break;
      }
    }
  }
}
