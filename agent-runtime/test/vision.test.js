const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildUserContent,
  loadVisionBlocks,
  looksImageRelated,
  parseVisionPaths,
  MAX_IMAGES,
} = require("../src/vision");
const { sanitizeMessages } = require("../src/client");

// Tiny valid PNG (1x1) for load tests.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bizagent-vision-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseVisionPaths", () => {
  it("extracts marked paths and ignores other comments/prose", () => {
    const prompt = [
      "# Turn prompt",
      "Some prose mentioning `.bizagent/uploads/hub/x/should-not-count.png` inline.",
      "<!-- bizagent-vision",
      ".bizagent/uploads/hub/2026-09-04-chat-abc123/20260904-pasted.png",
      "company/uploads/shot.jpg",
      "-->",
      "<!-- some other comment -->",
    ].join("\n");
    assert.deepEqual(parseVisionPaths(prompt), [
      ".bizagent/uploads/hub/2026-09-04-chat-abc123/20260904-pasted.png",
      "company/uploads/shot.jpg",
    ]);
  });

  it("returns [] when no marker is present", () => {
    assert.deepEqual(parseVisionPaths("no markers here"), []);
    assert.deepEqual(parseVisionPaths(""), []);
  });
});

describe("loadVisionBlocks", () => {
  it("loads existing images as image_url data-URL blocks", () => {
    withTempDir((dir) => {
      const file = path.join(dir, "shot.png");
      fs.writeFileSync(file, PNG_1PX);
      const blocks = loadVisionBlocks([file]);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].type, "image_url");
      assert.match(blocks[0].image_url.url, /^data:image\/png;base64,/);
    });
  });

  it("soft-fails unreadable images and keeps the rest", () => {
    withTempDir((dir) => {
      const good = path.join(dir, "good.jpg");
      fs.writeFileSync(good, PNG_1PX);
      const blocks = loadVisionBlocks([path.join(dir, "missing.png"), good]);
      assert.equal(blocks.length, 1);
      assert.match(blocks[0].image_url.url, /^data:image\/jpeg;base64,/);
    });
  });

  it("caps the number of attached images", () => {
    withTempDir((dir) => {
      const paths = [];
      for (let i = 0; i < MAX_IMAGES + 4; i += 1) {
        const p = path.join(dir, `img${i}.png`);
        fs.writeFileSync(p, PNG_1PX);
        paths.push(p);
      }
      assert.equal(loadVisionBlocks(paths).length, MAX_IMAGES);
    });
  });
});

describe("buildUserContent", () => {
  it("returns a plain string when no image blocks", () => {
    assert.equal(buildUserContent("hello", []), "hello");
    assert.equal(buildUserContent("hello", undefined), "hello");
  });

  it("returns [text, images...] with image blocks", () => {
    const blocks = [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }];
    const content = buildUserContent("what is this?", blocks);
    assert.ok(Array.isArray(content));
    assert.equal(content[0].type, "text");
    assert.equal(content[0].text, "what is this?");
    assert.equal(content[1].type, "image_url");
  });
});

describe("looksImageRelated", () => {
  it("matches image/vision refusals", () => {
    assert.equal(looksImageRelated({ status: 400, message: "Image content is not supported for this model" }), true);
    assert.equal(looksImageRelated({ status: 415, message: "unsupported media type" }), true);
    assert.equal(looksImageRelated({ message: "This model does not support vision input" }), true);
  });

  it("does not match auth/credit/rate-limit errors", () => {
    assert.equal(looksImageRelated({ status: 401, message: "invalid api key" }), false);
    assert.equal(looksImageRelated({ status: 429, message: "rate limit exceeded" }), false);
    assert.equal(looksImageRelated({ status: 402, message: "insufficient credits" }), false);
  });
});

describe("sanitizeMessages with vision content", () => {
  it("keeps valid text + image_url blocks, drops junk blocks", () => {
    const [out] = sanitizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
          { type: "audio", data: "nope" },
          "not-a-block",
        ],
      },
    ]);
    assert.ok(Array.isArray(out.content));
    assert.equal(out.content.length, 2);
    assert.equal(out.content[0].type, "text");
    assert.equal(out.content[1].type, "image_url");
  });

  it("rejects image blocks with non-data URLs", () => {
    const [out] = sanitizeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "https://evil.example/x.png" } },
        ],
      },
    ]);
    // Remote-URL image dropped; the valid text block remains (as a parts array).
    assert.ok(Array.isArray(out.content));
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, "text");
    assert.equal(out.content[0].text, "hi");
  });

  it("degrades unusable arrays to empty string (string flow unchanged)", () => {
    const [junk] = sanitizeMessages([{ role: "user", content: [{ bogus: true }] }]);
    assert.equal(junk.content, "");
    const [plain] = sanitizeMessages([{ role: "user", content: "plain" }]);
    assert.equal(plain.content, "plain");
    const [obj] = sanitizeMessages([{ role: "user", content: { weird: "object" } }]);
    assert.equal(obj.content, '{"weird":"object"}');
  });
});
