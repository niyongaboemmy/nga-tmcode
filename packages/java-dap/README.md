# @tmcode/java-dap

TMCode's debug adapter for Java (and Kotlin, best effort). It speaks the
[Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
over **stdio** (`Content-Length` framed JSON, like every VS Code adapter) and
talks [JDWP](https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-protocol.html)
straight to the JVM over a TCP socket: no jdb, no Eclipse JDT, no language server.
Only a JDK is needed on the machine (any version with JDWP, 8+; tested with 23).

```sh
node apps/desktop/src-tauri/resources/java-dap.cjs      # what TMCode spawns
node packages/java-dap/build.mjs                         # regenerate the bundle
node packages/java-dap/build.mjs --check                 # CI: fail if the bundle is stale
npx vitest run packages/java-dap                         # tests (need javac/java on PATH)
```

The bundle is a single CommonJS file targeting Node 18+, shipped as the Tauri
resource `resources/java-dap.cjs` next to `exthost.cjs`. Set `JAVA_DAP_LOG=1`
to get adapter diagnostics on stderr (stdout is reserved for DAP).

## Session flow

1. `initialize`: the client should pass `supportsRunInTerminalRequest: true` if it can run a command in a terminal.
2. `launch` (or `attach`): the adapter starts the JVM (suspended), connects JDWP, then
   **responds and sends the `initialized` event**.
3. `setBreakpoints` (per file), `setExceptionBreakpoints`, then `configurationDone`: the VM resumes.
4. `stopped` events, inspection, stepping, and finally `exited` (with the exit code) and `terminated`.

Breakpoints set before a class loads are answered `verified: false`. When the class is
prepared, a `breakpoint` event (`reason: "changed"`) reports `verified: true`, and the real line
if the breakpoint moved (see below).

## `launch` arguments

```jsonc
{
  "type": "java",
  "request": "launch",
  "mainClass": "com.example.App",     // required: fully qualified ("Main", "com.example.App", Kotlin "MainKt")
  "classPaths": ["/abs/build/classes"], // -cp entries; relative ones resolve against cwd. Default: [cwd]
  "sourcePaths": ["/abs/project/src"],  // source roots for mapping classes to files. Default: [cwd, cwd/src]
  "cwd": "/abs/project",              // working directory of the program. Default: the adapter's cwd
  "args": ["one", "two"],             // program arguments (array, or one string split like a shell)
  "vmArgs": ["-Xmx256m"],             // JVM options before -cp (array or string)
  "javaExec": "/path/to/bin/java",    // default "java" (PATH)
  "env": { "KEY": "value" },          // extra environment variables
  "console": "integratedTerminal",    // or "internalConsole" (default) / "externalTerminal"
  "stopOnEntry": false,               // stop on the first line of main()
  "timeout": 15000                    // ms to wait for the JVM's debug port
}
```

The JVM command line is:

```
<javaExec> -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:<free port>,quiet=y
           <vmArgs...> -cp <classPaths joined with path.delimiter> <mainClass> <args...>
```

Classes must be compiled with `javac -g` (or at least `-g:source,lines,vars`): without the
local variable table the adapter still stops and steps but shows
`(locals unavailable)` instead of locals.

### Program input and output

- `console: "integratedTerminal"` (or `"externalTerminal"`) **and** the client advertised
  `supportsRunInTerminalRequest`: the adapter sends the reverse request
  `runInTerminal { kind: "integrated" | "external", title, cwd, args: [java, ...], env }` and the
  program's stdin/stdout/stderr belong to that terminal (so `Scanner(System.in)` works). Nothing
  is forwarded as `output` events. The response's `processId` is not needed.
- Otherwise the adapter spawns the JVM itself: stdout/stderr arrive as `output` events
  (`category: "stdout"` / `"stderr"`), stdin is closed (a program reading input gets end-of-file).
  Use the terminal mode for programs that read input.
- Logpoint messages and breakpoint-condition errors are `output` events with `category: "console"`.

### Exit codes

- Spawned JVM: the real process exit code.
- Terminal / attach: the adapter does not own the process, so it reads the status passed to
  `System.exit(n)` (a hidden breakpoint on `java.lang.Shutdown.exit`); otherwise 1 if `main`
  died from an uncaught exception, else 0.

## `attach` arguments

For a JVM started with `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y|n,address=<port>`:

```jsonc
{ "request": "attach", "hostName": "127.0.0.1", "port": 5005, "sourcePaths": ["/abs/src"], "cwd": "/abs", "timeout": 15000 }
```

With `suspend=y` the VM resumes on `configurationDone`. `disconnect` defaults to
`terminateDebuggee: false` for attach (the VM is resumed and keeps running) and `true` for launch.

## Capabilities

```jsonc
{
  "supportsConfigurationDoneRequest": true,
  "supportsConditionalBreakpoints": true,
  "supportsHitConditionalBreakpoints": true,   // "5", "== 5", ">= 5", "> 5", "< 5", "<= 5", "% 5"
  "supportsLogPoints": true,                   // "i is {i}" — {expressions} evaluated like watches
  "supportsEvaluateForHovers": true,
  "supportsSetVariable": true,                 // locals, fields, statics, array elements
  "supportsTerminateRequest": true,            // VirtualMachine.Exit(1)
  "supportTerminateDebuggee": true,
  "supportsExceptionInfoRequest": true,
  "supportsDelayedStackTraceLoading": true,
  "exceptionBreakpointFilters": [
    { "filter": "uncaught", "label": "Uncaught Exceptions", "default": true },
    { "filter": "caught",   "label": "Caught Exceptions",   "default": false }
  ]
}
```

Requests: `initialize`, `launch`, `attach`, `setBreakpoints`, `setExceptionBreakpoints`,
`configurationDone`, `threads`, `stackTrace` (`startFrame`/`levels`), `scopes`, `variables`,
`setVariable`, `evaluate`, `exceptionInfo`, `continue`, `next`, `stepIn`, `stepOut`, `pause`,
`terminate`, `disconnect`.

Events: `initialized`, `stopped` (`breakpoint`, `step`, `exception`, `pause`, `entry`; always
`allThreadsStopped: true`), `breakpoint` (`changed`), `output`, `exited`, `terminated`.

## How it maps things

- **Breakpoints → classes.** The adapter watches every class prepare outside the JDK
  (`java.*`, `javax.*`, `jdk.*`, `sun.*`, `com.sun.*`, `kotlin.*` are excluded) and matches a
  class to a breakpoint file when the class's `SourceFile` attribute equals the file name and the
  file's `package` declaration equals the class's package. That covers nested/inner/anonymous
  classes (`Outer$Inner`), several top-level classes in one file, lambdas, and Kotlin file
  classes (`Main.kt` → `MainKt`). A breakpoint on a blank line, a comment, a lone brace or an
  annotation moves down to the next line with code in the same method.
- **Frames → files.** A frame's source is the breakpoint file of that class if there is one,
  else `<sourcePath>/<package dirs>/<SourceFile>`, else `<sourcePath>/<SourceFile>`. JDK frames
  have no path (`presentationHint: "subtle"`, source `presentationHint: "deemphasize"`).
- **Scopes.** `Locals` (the pending exception as `<exception>` when stopped on one, `this`,
  arguments and visible locals in declaration order) and, when the class has static fields,
  `Static (ClassName)`.
- **Values.** Java formatting: `41`, `2.5`, `1.0E10`, `'q'`, `true`, `"text"` (escaped),
  `null`. Arrays show a preview for small primitive/String arrays (`[1, 2, 3]`), otherwise
  `int[500]`; children are `[i]`, chunked into `[0..99]` ranges above 100 elements. Objects show
  `Point (id=42)` and expand to their fields, inherited ones included (a shadowed field is shown as
  `name (Super)`). Boxed numbers show their value, enums their constant name,
  `StringBuilder`/`StringBuffer` their text. `ArrayList`, `LinkedList`, `HashMap`,
  `LinkedHashMap`, `TreeMap`, `HashSet`, `LinkedHashSet`, `TreeSet` show `(size=n)` and expand to
  their elements (maps: one child per entry, named by the key).
- **Stepping** uses JDWP line steps with the JDK packages excluded, so "step into" never lands in
  library code (stepping into `System.out.println` behaves like step over). Every stop suspends all
  threads; continue/step resume all threads.

## Expressions (conditions, watch, hover, logpoints, setVariable)

A small Java subset evaluated against the selected frame:

- literals: `42`, `10L`, `0x1F`, `1.5`, `2f`, `'c'`, `"text"`, `true`, `false`, `null`
- names: locals and arguments, `this`, fields of `this` (also inherited), static fields of the
  current class and its outer classes, class names (`Math`, `com.example.Util`)
- `a.b` field access (instance or static), `arr.length`, `arr[i]`
- method calls: `name.length()`, `list.get(0)`, `s.equals("x")`, `Math.max(a, b)`,
  `Util.twice(3)` — run in the debuggee (single thread, other threads stay suspended);
  overloads are chosen by argument count and type; primitives are boxed when needed.
  Breakpoints hit inside an evaluated call are ignored.
- operators: `! - +` (unary), `* / %`, `+ -` (string concatenation when either side is a
  String, using `toString()`), `< > <= >=`, `== !=`, `&&`, `||`, `?:`, parentheses — with Java's
  int/long overflow, integer division, `/ by zero`, and numeric promotion; boxed values unbox.

Deliberate simplifications: `==` between two Strings compares contents (what students mean);
no assignment, `new`, casts, `instanceof`, lambdas or generics. A condition that cannot be
evaluated stops the program and explains why in the console.

## Limitations

- Kotlin works through `SourceFile` matching (breakpoints, stepping, locals) but is untested
  here; Kotlin values are shown as their JVM classes.
- Stdin is only available in terminal mode.
- Methods can only be called when the program stopped at a breakpoint/step/exception, not after
  `pause` (JDWP requires an event suspension).
- No hot code replace, data breakpoints, function breakpoints, restart frame or `restart`.
