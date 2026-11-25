import { expect, it } from "vitest";
import { antigravitySessionPath } from "./antigravity-history.js";

it("decodes Windows ACP session URIs without affecting ordinary paths", () => {
  expect(antigravitySessionPath("/D:/sample%20workspace/project", true)).toBe("D:\\sample workspace\\project");
  expect(antigravitySessionPath("/d%3A/projects/%E6%96%87%E4%BB%B6", true)).toBe("d:\\projects\\文件");
  expect(antigravitySessionPath("/c%3a/Users/name/Documents", true)).toBe(
    "c:\\Users\\name\\Documents",
  );
  expect(antigravitySessionPath("file:///D:/sample%20workspace/project", true)).toBe(
    "D:\\sample workspace\\project",
  );
  expect(antigravitySessionPath("D:\\literal%20name", true)).toBe("D:\\literal%20name");
  expect(antigravitySessionPath("file:///home/user/my%20project", false)).toBe(
    "/home/user/my project",
  );
});
