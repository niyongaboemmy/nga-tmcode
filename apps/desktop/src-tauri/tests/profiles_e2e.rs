//! Builds and runs a tiny program per language with the real toolchains on
//! this machine, using the same steps as packages/profiles (keep in sync).
//! Languages whose toolchain isn't installed are skipped, not failed.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tmcode_lib::test_support::{detect, program_for, run_piped, Context, RunEvent, Step};

fn step(tool: &str, args: &[&str]) -> Step {
    Step { tool: tool.into(), args: args.iter().map(|s| s.to_string()).collect() }
}

/// Runs build + run for `file` (written with `source`) and returns stdout.
fn run(lang: &str, file: &str, source: &str, build: Vec<Step>, run: Step, stdin: &str) -> Option<String> {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let entry = root.join(file);
    std::fs::write(&entry, source).unwrap();
    let out = root.join(".out");
    std::fs::create_dir_all(&out).unwrap();
    let tools = |t: &str| detect(t).map(|tc| (std::path::PathBuf::from(tc.path), tc.prefix_args));
    for s in build.iter().chain(std::iter::once(&run)) {
        if s.tool != "exe" && tools(&s.tool).is_none() {
            eprintln!("skipping {lang}: no {}", s.tool);
            return None;
        }
    }
    let ctx = Context { out: out.clone(), tools: &tools };
    let stop = Arc::new(AtomicBool::new(false));
    let events = Arc::new(Mutex::new(Vec::<RunEvent>::new()));
    let e2 = events.clone();
    let emit = move |e: RunEvent| e2.lock().unwrap().push(e);
    for s in &build {
        let (p, a) = program_for(&ctx, s, &entry).unwrap();
        let exit = run_piped(&p, &a, &root, "build", None, Duration::from_secs(60), 1 << 20, &stop, &mut |_| {}, &emit);
        assert!(matches!(exit, RunEvent::Exit { code: Some(0), .. }), "{lang} build failed: {exit:?} {:?}", events.lock().unwrap());
    }
    events.lock().unwrap().clear();
    let (p, a) = program_for(&ctx, &run, &entry).unwrap();
    let exit = run_piped(&p, &a, &root, "run", Some(stdin), Duration::from_secs(20), 1 << 20, &stop, &mut |_| {}, &emit);
    let ev = events.lock().unwrap();
    assert!(matches!(exit, RunEvent::Exit { code: Some(0), .. }), "{lang} run failed: {exit:?} {ev:?}");
    Some(ev.iter().filter_map(|e| if let RunEvent::Stdout { data } = e { Some(data.clone()) } else { None }).collect())
}

#[test]
fn python() {
    let out = run("python", "main.py", "a, b = map(int, input().split())\nprint(a + b)\n", vec![], step("python", &["-u", "{entry}"]), "2 3\n");
    if let Some(out) = out {
        assert_eq!(out.trim(), "5");
    }
}

#[test]
fn javascript_and_typescript() {
    let js = run("node", "main.js", "const [a,b]=require('fs').readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);console.log(a+b);\n", vec![], step("node", &["{entry}"]), "2 3\n");
    if let Some(out) = js {
        assert_eq!(out.trim(), "5");
    }
    let ts = run("typescript", "main.ts", "const add = (a: number, b: number): number => a + b;\nconsole.log(add(2, 3));\n", vec![], step("node", &["--experimental-strip-types", "--no-warnings", "{entry}"]), "");
    if let Some(out) = ts {
        assert_eq!(out.trim(), "5");
    }
}

#[test]
fn c_and_cpp() {
    let c = run(
        "c",
        "main.c",
        "#include <stdio.h>\n#include <math.h>\nint main(void){int a,b;scanf(\"%d %d\",&a,&b);printf(\"%d %.0f\\n\",a+b,sqrt(16.0));return 0;}\n",
        vec![step("cc", &["-std=c17", "-Wall", "-O0", "-g", "{sources:c}", "-o", "{out}/main", "-lm"])],
        step("exe", &["{out}/main"]),
        "2 3\n",
    );
    if let Some(out) = c {
        assert_eq!(out.trim(), "5 4");
    }
    let cpp = run(
        "cpp",
        "main.cpp",
        "#include <iostream>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}\n",
        vec![step("cxx", &["-std=c++17", "-Wall", "-O0", "-g", "{sources:cpp}", "-o", "{out}/main"])],
        step("exe", &["{out}/main"]),
        "2 3\n",
    );
    if let Some(out) = cpp {
        assert_eq!(out.trim(), "5");
    }
}

#[test]
fn java() {
    let out = run(
        "java",
        "Main.java",
        "import java.util.Scanner;\npublic class Main { public static void main(String[] a) { Scanner s = new Scanner(System.in); System.out.println(s.nextInt() + s.nextInt()); } }\n",
        vec![step("javac", &["-d", "{out}", "-encoding", "UTF-8", "{sources:java}"])],
        step("java", &["-cp", "{out}", "{entry_stem}"]),
        "2 3\n",
    );
    if let Some(out) = out {
        assert_eq!(out.trim(), "5");
    }
}

#[test]
fn compile_errors_fail_the_build_with_parsable_output() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let Some(cc) = detect("cc") else { return };
    std::fs::write(root.join("main.c"), "int main(void) { return 0 }\n").unwrap();
    let events = Arc::new(Mutex::new(Vec::<RunEvent>::new()));
    let e2 = events.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let exit = run_piped(Path::new(&cc.path), &["-c".into(), root.join("main.c").to_string_lossy().into_owned(), "-o".into(), root.join("m.o").to_string_lossy().into_owned()], &root, "build", None, Duration::from_secs(30), 1 << 20, &stop, &mut |_| {}, &move |e| e2.lock().unwrap().push(e));
    assert!(!matches!(exit, RunEvent::Exit { code: Some(0), .. }));
    let stderr: String = events.lock().unwrap().iter().filter_map(|e| if let RunEvent::Stderr { data } = e { Some(data.clone()) } else { None }).collect();
    assert!(stderr.contains("main.c:1:"), "compiler output not in file:line form: {stderr}");
}
