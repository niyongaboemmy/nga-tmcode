/**
 * Recognises "a dependency could not be resolved" in a restore/build/test
 * step's output. Boxes have no network, so a package that isn't in the
 * school's cache layers fails offline; that is verdict `package-not-available`
 * (CODE_RUNNER_PLAN §12, §15.1), not the student's compile error.
 */

export interface MissingPackage {
  /** "maven" | "gradle" | "npm" | "pip" | "cargo" | "go" | "bundler" | "nuget" | "composer". */
  manager: string;
  /** The package as the manager names it, when the output says ("org.x:y:1.0", "express", "flask-socketio"). */
  package: string | null;
}

interface Rule {
  manager: string;
  /** Any of these means "could not resolve offline". */
  when: RegExp[];
  /** First capture group = the package name. */
  name: RegExp[];
}

const RULES: Rule[] = [
  {
    manager: "maven",
    when: [
      /Could not resolve dependencies for project/,
      /has not been downloaded from it before/,
      /The following artifacts could not be resolved/,
      /Plugin [\w.:-]+ or one of its dependencies could not be resolved/,
      /Non-resolvable (?:parent POM|import POM)/,
      /Cannot access [\w.-]+ \([^)]*\) in offline mode/,
    ],
    name: [
      /the artifact ([\w.-]+:[\w.-]+(?::[\w.-]+)*?:[\d][\w.-]*) has not been downloaded/,
      /artifacts? could not be resolved: ([\w.-]+:[\w.-]+(?::[\w.-]+)*)/,
      /Plugin ([\w.-]+:[\w.-]+:[\w.-]+) or one of its dependencies/,
      /Non-resolvable (?:parent|import) POM for [^:]+: [^:]*?([\w.-]+:[\w.-]+:(?:pom:)?[\d][\w.-]*)/,
      /Could not find artifact ([\w.-]+:[\w.-]+(?::[\w.-]+)*)/,
    ],
  },
  {
    manager: "gradle",
    when: [/No cached version of [\w.:-]+ available for offline mode/, /Could not resolve all (?:files|dependencies) for configuration/, /Could not resolve [\w.-]+:[\w.-]+:[\w.-]+\./],
    name: [/No cached version of ([\w.-]+:[\w.-]+(?::[\w.-]+)?) available for offline mode/, /Could not (?:resolve|find) ([\w.-]+:[\w.-]+:[\w.+-]+)\./],
  },
  {
    manager: "npm",
    when: [/\bENOTCACHED\b/, /ENOTFOUND\s+registry\.(?:npmjs\.org|yarnpkg\.com)/, /\bETARGET\b.*No matching version found/s, /\bE404\b.*registry\.npmjs\.org/s, /code EAI_AGAIN/],
    name: [
      /registry\.(?:npmjs\.org|yarnpkg\.com)\/((?:@[\w.-]+(?:\/|%2[fF]))?[\w.-]+)/,
      /No matching version found for ((?:@[\w.-]+\/)?[\w.-]+)@/,
      /404 Not Found - GET \S+?\/((?:@[\w.-]+(?:\/|%2[fF]))?[\w.-]+)(?:\s|$|\/-)/,
    ],
  },
  {
    manager: "pip",
    when: [
      /No matching distribution found for/,
      /Could not find a version that satisfies the requirement/,
      /was not found in the (?:provided package locations|package registry)/,
      /Because [\w.\-[\]]+ was not found/,
    ],
    name: [
      /No matching distribution found for ([A-Za-z0-9][\w.-]*)/,
      /satisfies the requirement ([A-Za-z0-9][\w.-]*)/,
      /Because ([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])? was not found/,
      /([A-Za-z0-9][\w.-]*) was not found in the (?:provided package locations|package registry)/,
    ],
  },
  {
    manager: "cargo",
    when: [
      /no matching package (?:named `[^`]+` )?found/,
      /failed to get `[^`]+` as a dependency/,
      /attempting to make an HTTP request, but --offline was specified/,
      /failed to download from `https:\/\/(?:static\.)?crates\.io/,
      /can't checkout from '[^']+': you are in the offline mode/,
    ],
    name: [/no matching package named `([^`]+)` found/, /failed to get `([^`]+)` as a dependency/, /searched package name: `([^`]+)`/, /failed to select a version for the requirement `([^ =`]+)/],
  },
  {
    manager: "go",
    when: [/module lookup disabled by GOPROXY=off/, /cannot find module providing package/, /reading file:\/\/\S+: no such file or directory/, /no required module provides package/],
    name: [
      /(?:package|go:|\bmodule) ([\w.-]+\.[\w.-]+\/[\w./-]+?)(?:@[\w.+-]+)?: (?:module lookup disabled|reading file:)/,
      /cannot find module providing package ([\w.-]+\.[\w.-]+\/[\w./-]+)/,
      /no required module provides package ([\w.-]+\.[\w.-]+\/[\w./-]+)/,
      /([\w.-]+\.[\w.-]+\/[\w./-]+?)@[\w.+-]+: module lookup disabled/,
      /go: downloading ([\w.-]+\.[\w.-]+\/[\w./-]+) v[\w.+-]+/,
    ],
  },
  {
    manager: "bundler",
    when: [/Could not find gem '[^']+'/, /Could not find [\w.-]+-[\d.]+ in (?:locally installed gems|any of the sources)/],
    name: [/Could not find gem '([^' ]+)/, /Could not find ([\w-]+?)-[\d.]+ in/],
  },
  {
    manager: "nuget",
    when: [/error NU1101: Unable to find package/, /error NU1102: Unable to find package/, /error NU1301/],
    name: [/Unable to find package ([\w.-]+)/],
  },
  {
    manager: "composer",
    when: [/The requested package [\w/.-]+ could not be found/, /COMPOSER_DISABLE_NETWORK/],
    name: [/The requested package ([\w/.-]+) could not be found/],
  },
];

/** The unresolvable dependency an offline step failed on, or null when the failure is something else. */
export function missingPackage(output: string): MissingPackage | null {
  if (!output) return null;
  for (const rule of RULES) {
    if (!rule.when.some((re) => re.test(output))) continue;
    let name: string | null = null;
    for (const re of rule.name) {
      const m = re.exec(output);
      if (m?.[1]) {
        name = m[1].replace(/%2[fF]/, "/");
        break;
      }
    }
    return { manager: rule.manager, package: name };
  }
  return null;
}

/** The message students and teachers see. */
export function missingPackageMessage(m: MissingPackage): string {
  return m.package
    ? `PACKAGE_NOT_AVAILABLE: "${m.package}" is not in the school package list (${m.manager}, offline).`
    : `PACKAGE_NOT_AVAILABLE: a ${m.manager} dependency is not in the school package list (the runner is offline).`;
}
