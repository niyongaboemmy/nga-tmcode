/**
 * New Project templates: small, runnable starting points with tasks and a
 * launch configuration, so F5 and Run Task work straight away.
 */

export interface Template {
  id: string;
  label: string;
  description: string;
  icon: string;
  language: string;
  files: Record<string, string>;
}

const launch = (configs: object[]) => `${JSON.stringify({ version: "0.2.0", configurations: configs }, null, 2)}\n`;
const gitignore = (extra: string[] = []) => ["node_modules/", "dist/", "build/", ".venv/", "__pycache__/", "target/", ".DS_Store", ...extra].join("\n") + "\n";

export const TEMPLATES: Template[] = [
  {
    id: "react-vite",
    label: "React (Vite)",
    description: "React 19 + Vite dev server, opens in the built-in browser",
    icon: "symbol-misc",
    language: "typescript",
    files: {
      "package.json": `${JSON.stringify({ name: "react-app", private: true, type: "module", scripts: { dev: "vite", build: "vite build", preview: "vite preview" }, dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { vite: "^7.0.0", "@vitejs/plugin-react": "^5.0.0", typescript: "^5.6.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" } }, null, 2)}\n`,
      "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>React App</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
      "vite.config.ts": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`,
      "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", strict: true, skipLibCheck: true }, include: ["src"] }, null, 2)}\n`,
      "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./App";\nimport "./index.css";\n\ncreateRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
      "src/App.tsx": `import { useState } from "react";\n\nexport function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main>\n      <h1>Hello from React</h1>\n      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>\n    </main>\n  );\n}\n`,
      "src/index.css": `body {\n  font-family: system-ui, sans-serif;\n  margin: 0;\n  display: grid;\n  place-items: center;\n  min-height: 100vh;\n}\n`,
      ".gitignore": gitignore(),
      "README.md": "# React app\n\n1. Terminal › Run Task… › `npm: install`\n2. Run Task… › `npm: dev` — TMCode offers to open it in the built-in browser.\n",
    },
  },
  {
    id: "node-express",
    label: "Node.js API (Express)",
    description: "An Express server with a JSON route and a debug configuration",
    icon: "server",
    language: "javascript",
    files: {
      "package.json": `${JSON.stringify({ name: "node-api", private: true, type: "module", main: "src/index.js", scripts: { start: "node src/index.js", dev: "node --watch src/index.js" }, dependencies: { express: "^5.0.0" } }, null, 2)}\n`,
      "src/index.js": `import express from "express";\n\nconst app = express();\napp.use(express.json());\n\napp.get("/api/hello", (req, res) => {\n  res.json({ message: "Hello from Express", time: new Date().toISOString() });\n});\n\nconst port = process.env.PORT ?? 3000;\napp.listen(port, () => console.log(\`Server running on http://localhost:\${port}\`));\n`,
      ".vscode/launch.json": launch([{ type: "node", request: "launch", name: "Debug server", program: "${workspaceFolder}/src/index.js" }]),
      ".gitignore": gitignore([".env"]),
      "README.md": "# Node.js API\n\n1. Run Task… › `npm: install`\n2. F5 debugs the server; open http://localhost:3000/api/hello\n",
    },
  },
  {
    id: "python",
    label: "Python",
    description: "A Python program with a test and a debug configuration",
    icon: "symbol-method",
    language: "python",
    files: {
      "main.py": `def greet(name: str) -> str:\n    return f"Hello, {name}!"\n\n\nif __name__ == "__main__":\n    name = input("What is your name? ")\n    print(greet(name))\n`,
      "test_main.py": `from main import greet\n\n\ndef test_greet():\n    assert greet("Ada") == "Hello, Ada!"\n`,
      ".vscode/launch.json": launch([{ type: "debugpy", request: "launch", name: "Python: main.py", program: "${workspaceFolder}/main.py", console: "integratedTerminal" }]),
      ".gitignore": gitignore([".pytest_cache/"]),
      "README.md": "# Python project\n\nF5 runs `main.py`. Breakpoints work with the debugger (debugpy).\n",
    },
  },
  {
    id: "cpp-cmake",
    label: "C++ (CMake)",
    description: "main.cpp, a CMake build and a Makefile task",
    icon: "symbol-class",
    language: "cpp",
    files: {
      "main.cpp": `#include <iostream>\n#include <string>\n\nint main() {\n    std::string name;\n    std::cout << "What is your name? ";\n    std::getline(std::cin, name);\n    std::cout << "Hello, " << name << "!" << std::endl;\n    return 0;\n}\n`,
      "CMakeLists.txt": `cmake_minimum_required(VERSION 3.16)\nproject(app CXX)\nset(CMAKE_CXX_STANDARD 17)\nadd_executable(app main.cpp)\n`,
      Makefile: `app: main.cpp\n\tg++ -std=c++17 -Wall -g -o app main.cpp\n\nrun: app\n\t./app\n\nclean:\n\trm -f app\n`,
      ".gitignore": gitignore(["app", "*.o"]),
      "README.md": "# C++ project\n\nF5 compiles and runs `main.cpp`. Run Task… › `make: run` uses the Makefile.\n",
    },
  },
  {
    id: "java-maven",
    label: "Java (Maven)",
    description: "A Maven project with a Main class",
    icon: "coffee",
    language: "java",
    files: {
      "pom.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>rw.ac.nga</groupId>\n  <artifactId>app</artifactId>\n  <version>1.0.0</version>\n  <properties>\n    <maven.compiler.release>17</maven.compiler.release>\n    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n  </properties>\n</project>\n`,
      "src/main/java/Main.java": `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from Java!");\n    }\n}\n`,
      ".gitignore": gitignore(),
      "README.md": "# Java project\n\nF5 on `Main.java` runs it. Run Task… › `maven: package` builds with Maven.\n",
    },
  },
  {
    id: "web",
    label: "Website (HTML, CSS, JavaScript)",
    description: "A page with live preview (F5)",
    icon: "globe",
    language: "html",
    files: {
      "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>My site</title>\n    <link rel="stylesheet" href="style.css" />\n  </head>\n  <body>\n    <h1>Hello, web!</h1>\n    <button id="btn">Click me</button>\n    <script src="script.js"></script>\n  </body>\n</html>\n`,
      "style.css": `body {\n  font-family: system-ui, sans-serif;\n  max-width: 40rem;\n  margin: 4rem auto;\n}\n`,
      "script.js": `document.getElementById("btn").addEventListener("click", () => {\n  console.log("Clicked!");\n});\n`,
      "README.md": "# Website\n\nF5 on `index.html` opens the live preview.\n",
    },
  },
];

export function templateById(id: string) {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}
