/**
 * Read a private key without leaving it in shell history.
 *
 * Passing a key as an inline environment assignment (KEY=0x... node script.mjs) writes it into
 * ~/.zsh_history in plaintext, where it outlives the task by years. This prompts for it instead,
 * with terminal echo disabled, and keeps it only in memory for the life of the process.
 *
 * IMPLEMENTATION NOTE: this reads stdin in raw mode and assembles the line by hand. The obvious
 * alternative — readline with `_writeToOutput` overridden to suppress echo — is a widely copied
 * hack that is also unreliable: it depends on a private API, and in practice it can swallow a
 * pasted value entirely, leaving the process to exit with no input and no error at all. Raw mode
 * is more code, but it actually works, including for multi-character pastes.
 *
 * The environment variable is still honoured for CI and other non-interactive use.
 */
import { stdin, stdout } from "node:process";

const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/** Add the 0x prefix viem requires, if the wallet exported the bare form (MetaMask does). */
function normalize(raw) {
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = new Set([String.fromCharCode(8), String.fromCharCode(127)]);
const SPACE = String.fromCharCode(32);

function readHidden(promptText) {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
      reject(new Error("no interactive terminal available for a hidden prompt"));
      return;
    }

    stdout.write(promptText);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      // A paste arrives as a single chunk, so iterate rather than assuming one keypress.
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === CTRL_D && buffer.length === 0) {
          cleanup();
          stdout.write("\n");
          reject(new Error("no input received"));
          return;
        }
        if (BACKSPACE.has(ch)) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        // Skip other control characters; arrow keys arrive as multi-byte escape sequences.
        if (ch < SPACE) continue;
        buffer += ch;
      }
    };

    stdin.on("data", onData);
  });
}

export async function resolvePrivateKey(envVarName = "BUYER_PRIVATE_KEY") {
  const fromEnv = process.env[envVarName];
  if (fromEnv) {
    const trimmed = fromEnv.trim();
    if (!KEY_RE.test(trimmed)) {
      throw new Error(
        `${envVarName} must be 64 hex characters, with or without a leading 0x.\n` +
          `If you pasted the placeholder literally, substitute your real key — or better, omit ` +
          `the variable entirely and this script will prompt for it without recording it in ` +
          `shell history.`,
      );
    }
    return normalize(trimmed);
  }

  if (!stdin.isTTY) {
    throw new Error(
      `No ${envVarName} set, and no interactive terminal to prompt from.\n` +
        `For non-interactive use: read -rs KEY && ${envVarName}=$KEY node <script>\n` +
        `(the shell's own read does not record its input in history)`,
    );
  }

  const answer = (await readHidden("Private key (input hidden, paste then press Enter): ")).trim();

  if (answer.length === 0) {
    throw new Error("No key entered. Paste the key at the prompt, then press Enter.");
  }
  if (!KEY_RE.test(answer)) {
    throw new Error(
      `Not a valid private key. Expected 64 hex characters, with or without a leading 0x ` +
        `(received ${answer.length} characters).`,
    );
  }
  return normalize(answer);
}
