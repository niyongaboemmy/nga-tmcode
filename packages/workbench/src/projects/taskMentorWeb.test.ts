import { describe, expect, it } from "vitest";
import { taskMentorPath, taskMentorWeb } from "./taskMentorWeb";

describe("Task Mentor links (the new code area and grading routes)", () => {
  it("point at the new pages", () => {
    expect(taskMentorPath({ kind: "project", id: 7 })).toBe("/code/projects/7");
    expect(taskMentorPath({ kind: "projectEdit", id: 7 })).toBe("/code/projects/7/edit");
    expect(taskMentorPath({ kind: "assignmentWork", id: 51 })).toBe("/assignments/51/work");
    expect(taskMentorPath({ kind: "toGrade" })).toBe("/grading");
    expect(taskMentorPath({ kind: "grading", type: "quiz", id: 78, question: 501, student: 21 })).toBe("/grading/quiz/78?question=501&student=21");
    expect(taskMentorPath({ kind: "grading", type: "assignment", id: 51 })).toBe("/grading/assignment/51");
    expect(taskMentorPath({ kind: "playground" })).toBe("/code/playground");
    expect(taskMentorPath({ kind: "starters" })).toBe("/code/starters");
  });

  it("go to the web app of the API being used", () => {
    expect(taskMentorWeb("https://taskmentor-api.amashuri.com")).toBe("https://taskmentor.amashuri.com");
    expect(taskMentorWeb("http://localhost:5000")).toBe("http://localhost:5173/taskmentor");
  });
});
