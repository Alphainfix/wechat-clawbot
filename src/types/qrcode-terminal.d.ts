/**
 * Minimal type declaration for `qrcode-terminal` (CJS, no bundled types).
 */
declare module "qrcode-terminal" {
  export interface GenerateOptions {
    small?: boolean;
  }
  export function generate(
    text: string,
    options?: GenerateOptions,
    callback?: (qrcode: string) => void,
  ): void;
  export function setErrorOutput(stream: NodeJS.WritableStream): void;
  const _default: {
    generate: typeof generate;
    setErrorOutput: typeof setErrorOutput;
  };
  export default _default;
}
