# Languages and technologies in TMCode

What TMCode does for each technology. Every row has a template in **File › New Project from Template…**, unless marked "(no template)".

- **Run:** Run Project (⌘/Ctrl+Shift+F10) or ▶ on a file.
- **Debug:** F5 with breakpoints.
- **Preview:** the built-in browser, results, or tables.
- **Test:** the Testing view. ✅ means the project's own test framework runs there, with each result linked to its line.

| Technology | Run | Debug | Preview / responses | Tests |
|---|---|---|---|---|
| HTML, CSS, JavaScript; jQuery, Bootstrap, Tailwind, Canvas | Live Preview (F5), system browser | in the preview's console | Live Preview with device sizes | — |
| React, Vue, Svelte, Angular, Next.js | dev server (`npm run dev`, `ng serve`, `next dev`) | Node side: js-debug | built-in browser; React also offline (bundled in TMCode) | ✅ Vitest, Jest in the Testing view |
| Node.js, Express, NestJS, Fastify, TypeScript | `node`, `tsx`, `nest start --watch` | ✅ js-debug | API Tester | ✅ Vitest, Jest, `node --test` |
| Python, Flask, FastAPI, Django, pandas | Run panel; `flask run`, `uvicorn`, `manage.py runserver` | ✅ debugpy | API Tester (FastAPI docs at /docs) | input/output tests; ✅ pytest, Django tests |
| Java (single file, Maven, Gradle), Spring Boot, Swing | Run panel; `mvn spring-boot:run`, `gradle bootRun` | ✅ TMCode's Java debugger (JDWP); Java: Attach for Spring Boot / Maven | API Tester | input/output tests; ✅ JUnit via Maven / Gradle |
| C, C++ (Make, CMake) | Run panel (compile + run) | ✅ lldb-dap or GDB 14+ | — | input/output tests; `make test`, `ctest` tasks |
| Go (net/http, gin, echo, fiber) | `go run .` | ✅ Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`) | API Tester | ✅ `go test` |
| Rust (Cargo, axum, actix…) | `cargo run` | ✅ LLDB | API Tester | ✅ `cargo test` |
| C# / .NET, ASP.NET Core | `dotnet run`, `dotnet watch run` | ✅ netcoredbg (downloaded once) | API Tester | ✅ `dotnet test` (xUnit, NUnit, MSTest) |
| PHP, Laravel | `php -S`, `php artisan serve`; ▶ on a .php file | ✅ Xdebug + PHP Debug adapter (downloaded once); Listen for Xdebug for web requests | built-in browser, API Tester | ✅ PHPUnit, `php artisan test` |
| Ruby, Rails, Sinatra | `ruby`, `bin/rails server`, Sinatra | ✅ rdbg (Ruby 3.1+) | built-in browser, API Tester | ✅ RSpec, Rails (minitest) |
| Dart, Flutter | `dart run`; Flutter web in the built-in browser (hot reload: r) | ✅ Dart / Flutter debug adapters | built-in browser | ✅ `dart test`, `flutter test` |
| Swift | `swift run`; ▶ on a .swift file | ✅ lldb-dap (Swift packages: `swift build` first) | — | ✅ `swift test` |
| Kotlin | ▶ runs the file in a terminal | ✅ kotlinc + TMCode's Java debugger | — | ✅ JUnit via Gradle |
| Scala, Lua, R, Perl, Shell, PowerShell, Julia, Haskell, Elixir (no template for some) | ▶ runs the file in a terminal | — | — | — |
| **SQL** (SQLite) | ▶ / ⌘⇧↵: built into TMCode, also offline and in exams | statement by statement, errors at their line, EXPLAIN QUERY PLAN | results as tables, the schema with row counts | — |
| **Logic** (`.logic`) | ▶: truth tables | each step as a column | tautology / contradiction, minterms, sum of products, product of sums, equivalent expressions | — |
| Algorithms, problem solving | Run panel | ✅ (Python, C, C++) | — | input/output tests (`.tmcode/tests.json`) |

## Notes

- **Project tests:** the Testing view finds the test frameworks in the folder and its sub-folders: pytest, Django, Vitest, Jest, `node --test`, JUnit (Maven, Gradle), `go test`, `cargo test`, `dart test`, `flutter test`, PHPUnit, Laravel, RSpec, Rails (minitest), `dotnet test` and `swift test`. It runs them in your login shell and reads their reports (JUnit XML, Jest/RSpec JSON, TRX, `go test -json`…). Failures appear on their lines and in Problems. Run one test with ▶ Run Test above it, or **Test: Run Test at Cursor** (⌘/Ctrl+; C). Reports are kept in `.tmcode/test-results`, which is never uploaded.
- **Debugger downloads:** js-debug, netcoredbg (C#) and PHP Debug are downloaded only when first needed, after you agree. Each is checked against a pinned SHA-256. TMCode's Java debugger is built into the app.

- **Missing tools:** when a tool is missing, the Run and Debug view shows how to install it for your system. You can also open it with **How to Install a Language…**.
- **Setup step:** templates with one (`npm install`, `flutter create .`, `composer create-project`, `rails new`) offer to run it in a terminal after the files are written.
- **API Tester:** open it from the Run menu, or from the status bar while a server runs. It sends requests from the app, so CORS doesn't apply. It finds the routes your code declares in Express, NestJS, Flask, FastAPI, Django, Spring, Laravel, Go and Rails.
- **Exams:** dev servers, terminals and REPLs are off in exams. SQL, truth tables and the Run panel still work.
