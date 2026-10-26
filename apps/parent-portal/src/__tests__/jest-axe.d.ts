// Ambient declaration for jest-axe under vitest (jest-axe 11 ships no
// bundled .d.ts). axe() returns the engine's results object, narrowed
// at call sites via VitestAxeResults (axe-helper.ts).
declare module "jest-axe" {
  export function axe(context: Element | string, options?: object): Promise<unknown>;
  export const toHaveNoViolations: object;
}
