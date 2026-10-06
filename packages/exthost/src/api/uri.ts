/**
 * `vscode.Uri`, with VS Code's semantics (a trimmed port of
 * vs/base/common/uri.ts): parse/file/from/joinPath/with, the same encoding
 * rules for toString(), and `fsPath` that follows the host OS.
 */

let windows = false;
/** The Node host sets this from process.platform; Web Workers are never Windows. */
export function setUriPlatform(isWindows: boolean) {
  windows = isWindows;
}

const SCHEME_RE = /^\w[\w\d+.-]*$/;
const URI_RE = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

function referenceResolution(scheme: string, path: string): string {
  // The path of a URI with an authority (or of file:) is absolute.
  if (scheme === "https" || scheme === "http" || scheme === "file") {
    if (!path) return "/";
    if (path[0] !== "/") return "/" + path;
  }
  return path;
}

// Characters that stay unencoded in toString(): unreserved + "/" in paths.
function encodeFast(uriComponent: string, isPath: boolean, isAuthority: boolean): string {
  let res: string | undefined;
  let nativeStart = -1;
  for (let pos = 0; pos < uriComponent.length; pos++) {
    const code = uriComponent.charCodeAt(pos);
    const unreserved =
      (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45 || code === 46 || code === 95 || code === 126 || (isPath && code === 47) || (isAuthority && (code === 91 || code === 93 || code === 58));
    if (unreserved) {
      if (nativeStart !== -1) {
        res += encodeURIComponent(uriComponent.substring(nativeStart, pos));
        nativeStart = -1;
      }
      if (res !== undefined) res += uriComponent.charAt(pos);
    } else {
      if (res === undefined) res = uriComponent.substr(0, pos);
      if (nativeStart === -1) nativeStart = pos;
    }
  }
  if (nativeStart !== -1) res += encodeURIComponent(uriComponent.substring(nativeStart));
  return res !== undefined ? res : uriComponent;
}

function encodeMinimal(path: string): string {
  let res: string | undefined;
  for (let pos = 0; pos < path.length; pos++) {
    const code = path.charCodeAt(pos);
    if (code === 35 /* # */ || code === 63 /* ? */) {
      if (res === undefined) res = path.substr(0, pos);
      res += code === 35 ? "%23" : "%3F";
    } else if (res !== undefined) {
      res += path[pos];
    }
  }
  return res !== undefined ? res : path;
}

const DECODE_RE = /(%[0-9A-Za-z][0-9A-Za-z])+/g;
function decode(s: string): string {
  if (!s.match(DECODE_RE)) return s;
  return s.replace(DECODE_RE, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m.length > 3 ? m.substr(0, 3) + decode(m.substr(3)) : m;
    }
  });
}

export interface UriComponents {
  scheme: string;
  authority?: string;
  path?: string;
  query?: string;
  fragment?: string;
}

export class Uri implements UriComponents {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  protected constructor(scheme: string, authority?: string, path?: string, query?: string, fragment?: string, strict = false) {
    this.scheme = scheme || (strict ? "" : "file");
    if (strict && !scheme) throw new Error(`[UriError]: Scheme is missing: {scheme: "", authority: "${authority}", path: "${path}"}`);
    if (this.scheme && !SCHEME_RE.test(this.scheme)) throw new Error("[UriError]: Scheme contains illegal characters.");
    this.authority = authority || "";
    this.path = referenceResolution(this.scheme, path || "");
    this.query = query || "";
    this.fragment = fragment || "";
    if (this.path && this.authority && this.path[0] !== "/") throw new Error('[UriError]: If a URI contains an authority component, then the path component must either be empty or begin with a slash ("/") character');
  }

  static isUri(thing: unknown): thing is Uri {
    if (thing instanceof Uri) return true;
    if (!thing || typeof thing !== "object") return false;
    const t = thing as Record<string, unknown>;
    return typeof t.authority === "string" && typeof t.fragment === "string" && typeof t.path === "string" && typeof t.query === "string" && typeof t.scheme === "string" && typeof t.with === "function" && typeof t.toString === "function";
  }

  static parse(value: string, strict = false): Uri {
    const m = URI_RE.exec(value);
    if (!m) return new Uri("", "", "", "", "", strict);
    return new Uri(m[2] || "", decode(m[4] || ""), decode(m[5] || ""), decode(m[7] || ""), decode(m[9] || ""), strict);
  }

  static file(path: string): Uri {
    let authority = "";
    if (windows) path = path.replace(/\\/g, "/");
    // UNC: //server/share
    if (path[0] === "/" && path[1] === "/") {
      const idx = path.indexOf("/", 2);
      if (idx === -1) {
        authority = path.substring(2);
        path = "/";
      } else {
        authority = path.substring(2, idx);
        path = path.substring(idx) || "/";
      }
    }
    return new Uri("file", authority, path);
  }

  static from(c: UriComponents): Uri {
    return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment, true);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    if (!base.path) throw new Error("[UriError]: cannot call joinPath on URI without path");
    const sep = "/";
    let joined = base.path;
    for (const s of segments) joined = joined.endsWith(sep) || !s ? joined + s : joined + sep + s;
    return base.with({ path: normalizePosix(joined) });
  }

  /** Revives a Uri sent over RPC ({$mid, scheme, path, …}). */
  static revive(data: UriComponents | Uri): Uri;
  static revive(data: UriComponents | Uri | undefined | null): Uri | undefined;
  static revive(data: UriComponents | Uri | undefined | null): Uri | undefined {
    if (!data) return undefined;
    if (data instanceof Uri) return data;
    return new Uri(data.scheme, data.authority, data.path, data.query, data.fragment);
  }

  get fsPath(): string {
    return uriToFsPath(this, false);
  }

  with(change: { scheme?: string; authority?: string | null; path?: string | null; query?: string | null; fragment?: string | null }): Uri {
    const pick = (v: string | null | undefined, cur: string) => (v === undefined ? cur : v === null ? "" : v);
    const scheme = change.scheme === undefined ? this.scheme : change.scheme;
    const authority = pick(change.authority, this.authority);
    const path = pick(change.path, this.path);
    const query = pick(change.query, this.query);
    const fragment = pick(change.fragment, this.fragment);
    if (scheme === this.scheme && authority === this.authority && path === this.path && query === this.query && fragment === this.fragment) return this;
    return new Uri(scheme, authority, path, query, fragment);
  }

  toString(skipEncoding = false): string {
    return asFormatted(this, skipEncoding);
  }

  toJSON(): UriComponents & { $mid: number; fsPath?: string; external?: string } {
    return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}

function normalizePosix(p: string): string {
  const abs = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else out.push(seg);
  }
  const trailing = p.endsWith("/") && out.length ? "/" : "";
  return (abs ? "/" : "") + out.join("/") + trailing;
}

export function uriToFsPath(uri: Uri, keepDriveLetterCasing: boolean): string {
  let value: string;
  if (uri.authority && uri.path.length > 1 && uri.scheme === "file") {
    value = `//${uri.authority}${uri.path}`;
  } else if (uri.path.charCodeAt(0) === 47 && /^[a-zA-Z]$/.test(uri.path[1] ?? "") && uri.path.charCodeAt(2) === 58) {
    value = keepDriveLetterCasing ? uri.path.substr(1) : uri.path[1].toLowerCase() + uri.path.substr(2);
  } else {
    value = uri.path;
  }
  if (windows) value = value.replace(/\//g, "\\");
  return value;
}

function asFormatted(uri: Uri, skipEncoding: boolean): string {
  const encoder = !skipEncoding ? encodeFast : (s: string) => encodeMinimal(s);
  let res = "";
  let { authority, path } = uri;
  const { scheme, query, fragment } = uri;
  if (scheme) res += scheme + ":";
  if (authority || scheme === "file") res += "//";
  if (authority) {
    let idx = authority.indexOf("@");
    if (idx !== -1) {
      const userinfo = authority.substr(0, idx);
      authority = authority.substr(idx + 1);
      idx = userinfo.lastIndexOf(":");
      if (idx === -1) res += encoder(userinfo, false, false);
      else res += encoder(userinfo.substr(0, idx), false, false) + ":" + encoder(userinfo.substr(idx + 1), false, true);
      res += "@";
    }
    authority = authority.toLowerCase();
    idx = authority.lastIndexOf(":");
    if (idx === -1) res += encoder(authority, false, true);
    else res += encoder(authority.substr(0, idx), false, true) + authority.substr(idx);
  }
  if (path) {
    // Lower-case windows drive letters in /C:/fff or C:/fff.
    if (path.length >= 3 && path.charCodeAt(0) === 47 && path.charCodeAt(2) === 58) {
      const code = path.charCodeAt(1);
      if (code >= 65 && code <= 90) path = `/${String.fromCharCode(code + 32)}:${path.substr(3)}`;
    } else if (path.length >= 2 && path.charCodeAt(1) === 58) {
      const code = path.charCodeAt(0);
      if (code >= 65 && code <= 90) path = `${String.fromCharCode(code + 32)}:${path.substr(2)}`;
    }
    res += encoder(path, true, false);
  }
  if (query) res += "?" + encoder(query, false, false);
  if (fragment) res += "#" + (!skipEncoding ? encodeFast(fragment, false, false) : fragment);
  return res;
}
