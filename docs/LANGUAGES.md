# Languages and technologies in TMCode

What TMCode does for each technology. Every row has a template in **File › New Project from Template…**, unless marked "(no template)".

- **Run:** Run Project (⌘/Ctrl+Shift+F10) or ▶ on a file.
- **Debug:** F5 with breakpoints.
- **Preview:** the built-in browser, results, or tables.
- **Test:** the Testing view, or a test task (Run Task…).

| Technology | Run | Debug | Preview / responses | Tests |
|---|---|---|---|---|
| HTML, CSS, JavaScript; jQuery, Bootstrap, Tailwind, Canvas | Live Preview (F5), system browser | in the preview's console | Live Preview with device sizes | — |
| React, Vue, Svelte, Angular, Next.js | dev server (`npm run dev`, `ng serve`, `next dev`) | Node side: js-debug | built-in browser; React also offline (bundled in TMCode) | `npm test` task |
| Node.js, Express, NestJS, Fastify, TypeScript | `node`, `tsx`, `nest start --watch` | ✅ js-debug | API Tester | `npm test` task |
| Python, Flask, FastAPI, Django, pandas | Run panel; `flask run`, `uvicorn`, `manage.py runserver` | ✅ debugpy | API Tester (FastAPI docs at /docs) | input/output tests; `manage.py test` |
| Java (single file, Maven, Gradle), Spring Boot, Swing | Run panel; `mvn spring-boot:run`, `gradle bootRun` | — (Run) | API Tester | input/output tests; `mvn test` / `gradle test` |
| C, C++ (Make, CMake) | Run panel (compile + run) | ✅ lldb-dap or GDB 14+ | — | input/output tests; `make test`, `ctest` |
| Go (net/http, gin, echo, fiber) | `go run .` | ✅ Delve (`go install github.com/go-delve/delve/cmd/dlv@latest`) | API Tester | `go test` task |
| Rust (Cargo, axum, actix…) | `cargo run` | ✅ LLDB | API Tester | `cargo test` task |
| C# / .NET, ASP.NET Core | `dotnet run`, `dotnet watch run` | — | API Tester | `dotnet test` task |
| PHP, Laravel | `php -S`, `php artisan serve`; ▶ on a .php file | — | built-in browser, API Tester | `php artisan test`, phpunit |
| Ruby, Rails, Sinatra | `ruby`, `bin/rails server`, Sinatra | — | built-in browser, API Tester | `bin/rails test`, rspec |
| Dart, Flutter | `dart run`; Flutter web in the built-in browser (hot reload: r) | ✅ Dart / Flutter debug adapters | built-in browser | `dart test`, `flutter test` |
| Swift | `swift run`; ▶ on a .swift file | — | — | `swift test` |
| Kotlin, Scala, Lua, R, Perl, Shell, PowerShell, Julia, Haskell, Elixir (no template for some) | ▶ runs the file in a terminal | — | — | — |
| **SQL** (SQLite) | ▶ / ⌘⇧↵: built into TMCode, also offline and in exams | statement by statement, errors at their line, EXPLAIN QUERY PLAN | results as tables, the schema with row counts | — |
| **Logic** (`.logic`) | ▶: truth tables | each step as a column | tautology / contradiction, minterms, sum of products, product of sums, equivalent expressions | — |
| Algorithms, problem solving | Run panel | ✅ (Python, C, C++) | — | input/output tests (`.tmcode/tests.json`) |

## Notes

- **Missing tools:** when a tool is missing, the Run and Debug view shows how to install it for your system. You can also open it with **How to Install a Language…**.
- **Setup step:** templates with one (`npm install`, `flutter create .`, `composer create-project`, `rails new`) offer to run it in a terminal after the files are written.
- **API Tester:** open it from the Run menu, or from the status bar while a server runs. It sends requests from the app, so CORS doesn't apply. It finds the routes your code declares in Express, NestJS, Flask, FastAPI, Django, Spring, Laravel, Go and Rails.
- **Exams:** dev servers, terminals and REPLs are off in exams. SQL, truth tables and the Run panel still work.
