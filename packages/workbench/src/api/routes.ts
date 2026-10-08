/**
 * Finds the HTTP routes a project declares, for the API Tester's Routes list:
 * Express/Fastify/Koa/Hono, NestJS, Flask, FastAPI, Django, Spring, Laravel,
 * Go (net/http, gin, echo, fiber), Rails and Sinatra. Pure (unit-tested): the
 * caller reads the files.
 */

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ANY";
  path: string;
  file: string;
  line: number;
  framework: string;
}

export const ROUTE_FILE = /\.(js|mjs|cjs|ts|mts|py|java|kt|php|go|rb)$/i;

const up = (m: string) => (m.toUpperCase() === "ALL" ? "ANY" : (m.toUpperCase() as Route["method"]));
const lineAt = (text: string, idx: number) => text.slice(0, idx).split("\n").length;
const joinPath = (a: string, b: string) => {
  const p = `/${[a, b].map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
  return p === "/" ? "/" : p;
};

export function findRoutes(file: string, text: string): Route[] {
  const out: Route[] = [];
  const add = (method: string, path: string, idx: number, framework: string) => out.push({ method: up(method), path: path || "/", file, line: lineAt(text, idx), framework });
  const ext = file.split(".").pop()!.toLowerCase();
  let m: RegExpExecArray | null;

  if (["js", "mjs", "cjs", "ts", "mts"].includes(ext)) {
    // NestJS: @Controller('users') + @Get(':id')
    const ctrl = /@Controller\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/.exec(text);
    if (ctrl) {
      const re = /@(Get|Post|Put|Patch|Delete|All)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g;
      while ((m = re.exec(text))) add(m[1], joinPath(ctrl[1] ?? "", m[2] ?? ""), m.index, "NestJS");
      return out;
    }
    const re = /\b(?:app|router|server|fastify|api|routes|r)\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]/g;
    while ((m = re.exec(text))) add(m[1], m[2], m.index, "Express");
  } else if (ext === "py") {
    let re = /@\w+\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;
    while ((m = re.exec(text))) add(m[1], m[2], m.index, /FastAPI|APIRouter/.test(text) ? "FastAPI" : "Flask");
    re = /@\w+\.route\(\s*["']([^"']+)["']([^)]*)\)/g;
    while ((m = re.exec(text))) {
      const methods = /methods\s*=\s*\[([^\]]+)\]/.exec(m[2])?.[1].match(/[A-Za-z]+/g) ?? ["GET"];
      for (const meth of methods) add(meth, m[1], m.index, "Flask");
    }
    if (/urlpatterns/.test(text)) {
      re = /\b(?:re_)?path\(\s*r?["']([^"']*)["']/g;
      while ((m = re.exec(text))) add("ANY", joinPath("", m[1]), m.index, "Django");
    }
  } else if (ext === "java" || ext === "kt") {
    const base = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/.exec(text);
    const re = /@(Get|Post|Put|Patch|Delete)Mapping(?:\(\s*(?:value\s*=\s*|path\s*=\s*)?(?:["']([^"']*)["'])?[^)]*\))?/g;
    while ((m = re.exec(text))) add(m[1], joinPath(base?.[1] ?? "", m[2] ?? ""), m.index, "Spring");
  } else if (ext === "php") {
    const api = /routes\/api\.php$/.test(file) ? "api" : "";
    const re = /Route::(get|post|put|patch|delete|any)\(\s*["']([^"']+)["']/gi;
    while ((m = re.exec(text))) add(m[1], joinPath(api, m[2]), m.index, "Laravel");
  } else if (ext === "go") {
    let re = /HandleFunc\(\s*"((?:GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^"]*)"/g;
    while ((m = re.exec(text))) add(m[1]?.trim() ?? "ANY", m[2], m.index, "Go");
    re = /\.(GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/g;
    while ((m = re.exec(text))) add(m[1], m[2], m.index, "Go");
  } else if (ext === "rb") {
    const re = /^\s*(get|post|put|patch|delete)\s+["'](\/?[^"']+)["']/gm;
    while ((m = re.exec(text))) add(m[1], joinPath("", m[2]), m.index, /\bdo\b/.test(text.slice(m.index, m.index + 200)) && !/routes\.rb$/.test(file) ? "Sinatra" : "Rails");
  }
  return out;
}

/** Path parameters filled with an example value: /users/:id → /users/1. */
export function exampleUrl(path: string) {
  return path
    .replace(/:[A-Za-z_]\w*/g, "1")
    .replace(/\{[^}]+\}/g, "1")
    .replace(/<(?:\w+:)?\w+>/g, "1");
}
