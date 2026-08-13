import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a local file. Optionally specify start_line and end_line range.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The path to the file to read."
          },
          start_line: {
            type: "integer",
            description: "Optional line number to start reading from (1-indexed)."
          },
          end_line: {
            type: "integer",
            description: "Optional line number to end reading at (1-indexed, inclusive)."
          }
        },
        required: ["file_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a local file. Specify the complete path including filename (e.g. './dir/file.txt'). Automatically creates missing parent directories.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "The complete relative or absolute file path including filename (e.g. './path/to/file.txt')."
          },
          content: {
            type: "string",
            description: "The text content to write into the file."
          }
        },
        required: ["file_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory (files and subfolders with sizes and indicators).",
      parameters: {
        type: "object",
        properties: {
          directory_path: {
            type: "string",
            description: "The directory path to list. Defaults to current directory ('.')."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command on the host machine and capture stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute."
          },
          cwd: {
            type: "string",
            description: "Optional working directory in which to execute the command."
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a text string or regex pattern in files within a directory.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The text or regex pattern to search for."
          },
          directory_path: {
            type: "string",
            description: "The directory to search in. Defaults to current directory ('.')."
          }
        },
        required: ["query"]
      }
    }
  }
];

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    switch (name) {
      case "read_file": {
        const filePath = path.resolve(args.file_path);
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          return `Error: File '${args.file_path}' does not exist.`;
        }
        const text = await file.text();
        const lines = text.split("\n");
        const start = args.start_line ? Math.max(1, parseInt(args.start_line, 10)) : 1;
        const end = args.end_line ? Math.min(lines.length, parseInt(args.end_line, 10)) : lines.length;

        const sliced = lines.slice(start - 1, end);
        const numbered = sliced.map((line, idx) => `${start + idx} | ${line}`).join("\n");
        return `File: ${args.file_path} (Lines ${start}-${end} of ${lines.length}):\n${numbered}`;
      }

      case "write_file": {
        const filePath = path.resolve(args.file_path);
        try {
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            return `Error: '${args.file_path}' is an existing directory, not a file. Please specify the complete file path including the filename (e.g. '${args.file_path}/filename.txt').`;
          }
        } catch {
          // File does not exist yet, which is expected
        }

        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await Bun.write(filePath, args.content);
        return `Successfully wrote ${args.content.length} characters to '${args.file_path}'.`;
      }

      case "list_directory": {
        const dirPath = path.resolve(args.directory_path || ".");
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        if (entries.length === 0) {
          return `Directory '${args.directory_path || "."}' is empty.`;
        }

        const formatted = await Promise.all(
          entries.map(async (entry) => {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              return `[DIR]  ${entry.name}/`;
            }
            try {
              const stat = await fs.stat(fullPath);
              return `[FILE] ${entry.name} (${stat.size} bytes)`;
            } catch {
              return `[FILE] ${entry.name}`;
            }
          })
        );
        return `Directory listing for '${args.directory_path || "."}':\n${formatted.join("\n")}`;
      }

      case "run_command": {
        const cmd = args.command;
        const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd,
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024
          });
          let output = "";
          if (stdout.trim()) output += `STDOUT:\n${stdout.trim()}\n`;
          if (stderr.trim()) output += `STDERR:\n${stderr.trim()}\n`;
          return output.trim() || "Command executed successfully with no output.";
        } catch (err: any) {
          return `Command failed with exit code ${err.returncode ?? 1}\n${err.stdout ? "STDOUT: " + err.stdout : ""}\n${err.stderr ? "STDERR: " + err.stderr : ""}`;
        }
      }

      case "search_files": {
        const dirPath = path.resolve(args.directory_path || ".");
        const query = args.query;
        try {
          const { stdout } = await execAsync(`grep -rnI --exclude-dir={node_modules,.git,dist,build} "${query.replace(/"/g, '\\"')}" "${dirPath}"`, {
            timeout: 10000
          });
          return stdout.trim() || `No matches found for '${query}'.`;
        } catch {
          return `No matches found for '${query}'.`;
        }
      }

      default:
        return `Error: Unknown tool '${name}'.`;
    }
  } catch (err: any) {
    return `Error executing tool '${name}': ${err.message || String(err)}`;
  }
}
