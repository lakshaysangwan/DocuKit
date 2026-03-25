/// <reference types="astro/client" />

// Vite worker URL imports — tsc doesn't understand these without explicit declarations.
// At runtime Vite resolves them to compiled JS URLs.
declare module '*?worker&url' {
  const src: string;
  export default src;
}
