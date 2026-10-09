import { describe, expect, it } from "vitest";
import { taskMentorHtml } from "./richHtml";

const API = "https://taskmentor-api.amashuri.com";

describe("taskMentorHtml (Task Mentor rich text in the editor theme)", () => {
  it("drops the colours, backgrounds and fonts the rich editor baked in, keeps structure", () => {
    const out = taskMentorHtml(
      `<h2 style="color: rgb(0,0,0); font-family: 'Times New Roman'; text-align: center">Task</h2><p style="background-color:#fff;color:black;font-size:12pt"><strong>Bold</strong> and <font color="#000" face="Times">old</font></p><ul><li style="font-weight: 700">One</li></ul>`,
      API,
    );
    expect(out).toContain('<h2 style="text-align: center">Task</h2>');
    expect(out).toContain("<p><strong>Bold</strong> and <font>old</font></p>");
    expect(out).toContain('<li style="font-weight: 700">One</li>');
    expect(out).not.toMatch(/color|Times|background|font-size/);
  });

  it("makes Task Mentor's /uploads images absolute and lazy", () => {
    const out = taskMentorHtml(`<p><img src="/uploads/editor-images/a.png"></p>`, API);
    expect(out).toContain(`src="${API}/uploads/editor-images/a.png"`);
    expect(out).toContain('loading="lazy"');
  });

  it("turns images from other sites into a link, keeps NGA and data images", () => {
    const out = taskMentorHtml(`<img src="https://tracker.example.com/x.png"><img src="https://files.amashuri.com/y.png"><img src="data:image/png;base64,AAAA">`, API);
    expect(out).toContain('<a href="https://tracker.example.com/x.png" class="tm-ext-image">Open image (tracker.example.com)</a>');
    expect(out).toContain('src="https://files.amashuri.com/y.png"');
    expect(out).toContain('src="data:image/png;base64,AAAA"');
  });

  it("makes relative links absolute and still strips scripts and handlers", () => {
    const out = taskMentorHtml(`<a href="/assignments/5">brief</a><img src="/uploads/x.png" onerror="alert(1)"><script>alert(2)</script><div style="background:url(javascript:alert(3))">x</div>`, API);
    expect(out).toContain(`href="${API}/assignments/5"`);
    expect(out).not.toMatch(/onerror|script|javascript/);
  });

  it("leaves other HTML alone between calls (the hooks are removed)", async () => {
    taskMentorHtml("<p>x</p>", API);
    const DOMPurify = (await import("dompurify")).default;
    expect(DOMPurify.sanitize('<p style="color:red">y</p>')).toBe('<p style="color:red">y</p>');
  });
});
