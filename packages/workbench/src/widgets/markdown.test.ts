import { describe, expect, it } from "vitest";
import { renderBrief, renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders briefs but never raw HTML or live links", () => {
    const html = renderMarkdown('# Task\n\nRead **n**.\n\n<script>alert(1)</script>\n\n[<img src=x onerror=alert(1)>](http://evil)\n\n```py\nprint(1)\n```');
    expect(html).toContain("<h1>Task</h1>");
    expect(html).toContain("<strong>n</strong>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).toContain('<code class="language-py">');
  });

  it("sanitises rich-text HTML briefs from Task Mentor", () => {
    const html = renderBrief('<p>Read <strong>n</strong></p><img src=x onerror="alert(1)"><script>alert(2)</script><a href="http://evil">click</a>');
    expect(html).toContain("<strong>n</strong>");
    expect(html).not.toMatch(/onerror|<script|href=/);
    expect(html).toContain("click");
  });
});
