/**
 * 简单日志工具
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

let debugEnabled = false;

export function setDebug(enabled: boolean) {
  debugEnabled = enabled;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

export const logger = {
  info(msg: string) {
    console.log(`${DIM}[${timestamp()}]${RESET} ${GREEN}INFO${RESET}  ${msg}`);
  },

  warn(msg: string) {
    console.log(`${DIM}[${timestamp()}]${RESET} ${YELLOW}WARN${RESET}  ${msg}`);
  },

  error(msg: string) {
    console.error(`${DIM}[${timestamp()}]${RESET} ${RED}ERROR${RESET} ${msg}`);
  },

  debug(msg: string) {
    if (debugEnabled) {
      console.log(`${DIM}[${timestamp()}]${RESET} ${CYAN}DEBUG${RESET} ${msg}`);
    }
  },
};
