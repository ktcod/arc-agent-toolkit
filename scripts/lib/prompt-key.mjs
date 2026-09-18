/**
 * Read a private key without leaving it in shell history.
 *
 * Passing a key as an inline environment assignment (KEY=0x... node script.mjs) writes it into
 * ~/.zsh_history in plaintext, where it outlives the task by years. This prompts for it instead,
 * with terminal echo disabled, and keeps it only in memory for the life of the process.
 *
 * The environment variable is still honoured for CI and other non-interactive use, but the
 * prompt is the default and the documented path.
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export async function resolvePrivateKey(envVarName = "BUYER_PRIVATE_KEY") {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    const trimmed = fromEnv.trim();
    if (!KEY_RE.test(trimmed)) {
      throw new Error(
        `${envVarName} must be 0x followed by 64 hex characters.\n` +
          `If you pasted the placeholder literally, substitute your real key — or better, omit ` +
          `the variable entirely and this script will prompt for it without recording it in ` +
          `shell history.`,
      );
    }
    return trimmed;
  }

  if (!stdin.isTTY) {
    throw new Error(
      `No ${envVarName} set, and no interactive terminal to prompt from.\n` +
        `Set ${envVarName}=0x... for non-interactive use.`,
    );
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  // Suppress echo so the key never reaches the screen or the scrollback buffer.
  const originalWrite = rl._writeToOutput?.bind(rl);
  let muted = false;
  rl._writeToOutput = (str) => {
    if (muted) return;
    originalWrite?.(str);
  };

  const answer = await new Promise((resolve) => {
    rl.question("Private key (input hidden): ", (value) => {
      muted = false;
      stdout.write("\n");
      rl.close();
      resolve(value);
    });
    muted = true;
  });

  const key = answer.trim();
  if (!KEY_RE.test(key)) {
    throw new Error("Not a valid private key (expected 0x followed by 64 hex characters).");
  }
  return key;
}
