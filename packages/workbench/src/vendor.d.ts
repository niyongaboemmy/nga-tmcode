/** Production React sources, served by the host's Vite plugin (see apps/desktop/build/reactVendorPlugin.ts). */
declare module "virtual:tmcode-react-vendor" {
  export const react: string;
  export const jsxRuntime: string;
  export const reactDom: string;
  export const reactDomClient: string;
  export const scheduler: string;
}
